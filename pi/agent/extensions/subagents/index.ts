/**
 * Subagents — robust subagent orchestration for pi.
 *
 * Lets the orchestrator (the main agent) spin up, monitor, and prompt
 * subagents of ARBITRARY models, each with its OWN isolated context window.
 *
 * Capabilities:
 *   - Single / parallel / chain modes
 *   - Arbitrary model per task: `model: "provider/id"` (validated against the
 *     model registry before running; clear errors for unknown models)
 *   - Inline agents: `systemPrompt` + `model` + `tools` without agent files
 *   - Agent files: `<agentDir>/agents/*.md` (user) and `.pi/agents/*.md`
 *     (project, opt-in), with model/tools/thinking/timeout/maxTurns frontmatter
 *   - Own context window per subagent: each subagent is an in-process Agent
 *     with its own transcript — no extra pi processes are spawned
 *   - Multi-turn prompting: `keepSession: true` returns a sessionId; passing
 *     that `sessionId` later continues the SAME context window (memory)
 *   - Watchdogs: per-task timeout and maxTurns abort the subagent
 *   - Every launch returns immediately; groups continue in the background and expose non-blocking status
 *   - Completed groups interject a capped result into the parent session as a follow-up
 *   - Background groups stop on session shutdown
 *   - Monitoring: run records persisted via pi.appendEntry; `/subagents`
 *     command lists active/recent runs with usage and live activity
 *   - Output caps so subagent results never flood the orchestrator's context
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createToolResultRenderer } from "../tool-results/render.ts";
import { Type, type Static } from "typebox";
import { type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import {
	type SubagentRunResult,
	type SubagentTaskSpec,
	type RunnerEvent,
	accumulateUsage,
	emptyUsage,
	getFinalOutput,
	runSubagent,
	DEFAULT_SUBAGENT_TIMEOUT_SEC,
} from "./runner.ts";
import {
	formatTokens,
	formatElapsed,
	isFailedResult,
	preview,
	renderRunResults,
	statusIcon,
	truncateBytes,
	usageLine,
	runMatchesFilter,
	SubagentsBrowser,
	type LiveRun,
} from "./ui.ts";
import {
	DEFAULT_SUBAGENT_TYPE,
	INLINE_SUBAGENT_TYPE,
	SUBAGENT_PREFERENCE_ENTRY_TYPE,
	applyPreference,
	clearGlobalPreference,
	clearGlobalPreferenceForType,
	describePreference,
	getSessionPreferences,
	loadGlobalPreferences,
	normalizeSubagentType,
	promptForPreference,
	resolvePreference,
	restoredPreferences,
	saveGlobalPreferenceForType,
	setSessionPreference,
	setSessionPreferences,
	supportedThinkingLevels,
	THINKING_LEVELS,
	type SubagentPreference,
	type SubagentThinking,
} from "./preference.ts";
import { TOKEN_USAGE_EVENT } from "../token-tracker.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 1; // sequential by default
const MAX_PARALLEL_TASKS = 20;
const MAX_CONCURRENT_SUBAGENTS = 20;
const PARENT_OUTPUT_CAP = 50 * 1024; // cap text returned or interjected into the parent LLM
const RUN_ENTRY_TYPE = "subagent-run";
const RUN_DETAIL_ENTRY_TYPE = "subagent-run-detail";
// Bound the live event log; completed transcripts retain the raw AgentMessage history.
// Detail rendering deliberately keeps the full transcript available for expansion.
const MAX_STORED_ACTIVITIES = 300;
const SUBAGENT_COMPLETION_MESSAGE_TYPE = "subagent-completion";
const NO_DUPLICATE_WORK_DIRECTIVE =
	"Do not duplicate work assigned to a running subagent: after launching one, do not independently repeat its investigation, implementation, or review. Work only on non-overlapping tasks and use the subagent's completion result instead of recreating its work.";
// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

const ThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
	description:
		"Reasoning level for the subagent model. Default: off (cheap & fast). Raise to low/high for harder tasks that benefit from reasoning; the chooser filters levels to the selected model's capabilities.",
});

const FailurePolicySchema = StringEnum(["stop", "continue"] as const, {
	description: "Chain behavior after a failed step. Default: stop. Use continue only for best-effort pipelines.",
});

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent definition name (from agents/)" })),
	task: Type.String({
		description:
			"Self-contained task with an explicit expected output. Use {previous} in chain mode for prior step output.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				'/Arbitrary model: "provider/id", "provider/*", or bare id; overridden by the user\'s choice for this subagent type when one is set',
		}),
	),
	systemPrompt: Type.Optional(Type.String({ description: "Inline system prompt (overrides agent file prompt)" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist for this subagent" })),
	thinking: Type.Optional(ThinkingLevelSchema),
	timeoutSec: Type.Optional(
		Type.Number({ minimum: 1, description: `Hard timeout in seconds (default ${DEFAULT_SUBAGENT_TIMEOUT_SEC})` }),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Assistant-turn budget; the runner reserves one finalization turn at the boundary",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
	sessionId: Type.Optional(
		Type.String({ description: "Continue an existing subagent context window (from keepSession)" }),
	),
	keepSession: Type.Optional(Type.Boolean({ description: "Save the session so it can be continued later" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Agent scope. "user" (default) loads <agentDir>/agents. "project" loads .pi/agents. "both" loads both.',
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent definition name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task text (single mode)" })),
	model: Type.Optional(
		Type.String({
			description:
				'Arbitrary model: "provider/id", "provider/*", or bare id (single mode); overridden by the user\'s choice for this subagent type when one is set',
		}),
	),
	systemPrompt: Type.Optional(
		Type.String({ description: "Inline system prompt (single mode, overrides agent prompt)" }),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist (single mode)" })),
	thinking: Type.Optional(ThinkingLevelSchema),
	timeoutSec: Type.Optional(
		Type.Number({ minimum: 1, description: `Hard timeout in seconds (default ${DEFAULT_SUBAGENT_TIMEOUT_SEC})` }),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Assistant-turn budget; the runner reserves one finalization turn at the boundary",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
	sessionId: Type.Optional(Type.String({ description: "Continue an existing subagent context window" })),
	keepSession: Type.Optional(Type.Boolean({ description: "Save the session so it can be continued later" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode: array of tasks to run concurrently" })),
	chain: Type.Optional(
		Type.Array(TaskItem, { description: "Chain mode: sequential dependent steps, {previous} = prior step output" }),
	),
	onFailure: Type.Optional(FailurePolicySchema),
	agentScope: Type.Optional(AgentScopeSchema),
	parallelLimit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_CONCURRENT_SUBAGENTS,
			description: "Max concurrent subagents (default 1 = sequential; use 2-4 for independent tasks)",
		}),
	),
});

const BackgroundStatusParams = Type.Object({
	groupId: Type.Optional(Type.String({ description: "Group id returned by subagent" })),
});

const SubagentHistoryParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Read live or completed history for one run" })),
	groupId: Type.Optional(Type.String({ description: "Limit history to a subagent group id" })),
	filter: Type.Optional(Type.String({ description: "Case-insensitive AND terms matched against run metadata" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum runs to return (default 5)" })),
	includeTranscript: Type.Optional(
		Type.Boolean({ description: "Include assistant/tool transcript; for active runs, include retained live events and current streamed text" }),
	),
});

const SubagentCancelParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Cancel one active run" })),
	groupId: Type.Optional(Type.String({ description: "Cancel every active run in a group" })),
});

type TaskItemType = Static<typeof TaskItem>;

/** Identify the preference bucket that owns a task's model choice. */
function subagentTypeForTask(item: Pick<TaskItemType, "agent" | "systemPrompt">): string {
	if (item.agent?.trim()) return normalizeSubagentType(item.agent);
	return item.systemPrompt ? INLINE_SUBAGENT_TYPE : DEFAULT_SUBAGENT_TYPE;
}

function preferenceEntryData(subagentType: string, preference: SubagentPreference): Record<string, unknown> {
	return { subagentType, ...preference };
}

interface ResolvedTask extends SubagentTaskSpec {
	agentSource?: string;
}

type RunKind = "single" | "parallel" | "chain";

type GroupExecutionResult = {
	mode: RunKind;
	results: SubagentRunResult[];
	text: string;
	isError: boolean;
};

/** Build the parent-session message emitted when a detached group finishes. */
export function formatSubagentCompletionMessage(
	groupId: string,
	result: Pick<GroupExecutionResult, "mode" | "text" | "isError">,
): string {
	const status = result.isError ? "failed" : "completed";
	return truncateBytes(
		[
			`Background ${result.mode} subagent group ${groupId} ${status}.`,
			"",
			result.text,
			"",
			"Review the result and continue the main task as appropriate.",
		].join("\n"),
		PARENT_OUTPUT_CAP,
	);
}

interface BackgroundGroup {
	groupId: string;
	mode: RunKind;
	status: "running" | "ok" | "error";
	startedAt: string;
	completedAt?: string;
	controller: AbortController;
	promise: Promise<GroupExecutionResult>;
	result?: GroupExecutionResult;
}

interface RunRecord {
	runId: string;
	groupId: string;
	/** Planned number of runs in this invocation group (display-only). */
	groupSize?: number;
	kind: RunKind;
	name: string;
	model: string;
	task: string;
	step?: number;
	status: "running" | "ok" | "error";
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	usage: { input: number; output: number; cost: number; turns: number; contextTokens: number };
	sessionId?: string;
	startedAt: string;
	durationMs?: number;
	/** True when the persisted detail transcript was capped. */
	transcriptTruncated?: boolean;
}

// ---------------------------------------------------------------------------
// Model resolution & validation
// ---------------------------------------------------------------------------

interface ResolvedModel {
	modelId: string; // "provider/id" for --model
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<SubagentThinking, string | null>>;
}

function matchesPattern(model: { provider: string; id: string; name: string }, pattern: string): boolean {
	const p = pattern.trim();
	if (!p) return false;
	if (p.includes("/")) {
		const separator = p.indexOf("/");
		const providerPart = p.slice(0, separator);
		const idPart = p.slice(separator + 1);
		const providerOk = providerPart === "*" || model.provider === providerPart;
		if (!providerOk) return false;
		if (idPart === "*") return true;
		return model.id === idPart || model.name === idPart;
	}
	return model.id === p || model.name === p || `${model.provider}/${model.id}` === p;
}

// Resolve a model request against the session's model registry.
// Exported for testing.
export function resolveModel(
	requested: string | undefined,
	ctx: Pick<ExtensionContext, "model"> & {
		modelRegistry: {
			getAvailable(): {
				provider: string;
				id: string;
				name: string;
				contextWindow: number;
				maxTokens: number;
				reasoning?: boolean;
				thinkingLevelMap?: Partial<Record<SubagentThinking, string | null>>;
			}[];
		};
	},
): { ok: true; model: ResolvedModel } | { ok: false; error: string; suggestions: string[] } {
	const available = ctx.modelRegistry.getAvailable();

	if (!requested) {
		const current = ctx.model;
		if (current) {
			return {
				ok: true,
				model: {
					modelId: `${current.provider}/${current.id}`,
					provider: current.provider,
					id: current.id,
					name: current.name,
					contextWindow: current.contextWindow,
					maxTokens: current.maxTokens,
					reasoning: current.reasoning,
					thinkingLevelMap: current.thinkingLevelMap,
				},
			};
		}
		return { ok: false, error: "No model specified and no active model available.", suggestions: [] };
	}

	const normalized = requested.trim();
	const matches = available.filter((m) => matchesPattern(m as never, normalized));

	if (matches.length > 0) {
		// Prefer exact provider/id match.
		const exact = matches.find((m) => `${m.provider}/${m.id}` === normalized) ?? matches[0];
		return {
			ok: true,
			model: {
				modelId: `${exact.provider}/${exact.id}`,
				provider: exact.provider,
				id: exact.id,
				name: exact.name,
				contextWindow: exact.contextWindow,
				maxTokens: exact.maxTokens,
				reasoning: exact.reasoning,
				thinkingLevelMap: exact.thinkingLevelMap,
			},
		};
	}

	// Fuzzy suggestions for a helpful error.
	const lower = normalized.toLowerCase();
	const suggestions = available
		.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower))
		.slice(0, 5)
		.map((m) => `${m.provider}/${m.id}`);

	return {
		ok: false,
		error: `Unknown model "${requested}".`,
		suggestions,
	};
}

// ---------------------------------------------------------------------------
// Task resolution
// ---------------------------------------------------------------------------

function compatibleThinkingLevel(model: ResolvedModel, thinking: string | undefined): string | undefined {
	if (!thinking || thinking === "auto") return thinking;
	const supported = supportedThinkingLevels(model);
	if (supported.includes(thinking as SubagentThinking)) return thinking;

	const requestedIndex = THINKING_LEVELS.indexOf(thinking as SubagentThinking);
	if (requestedIndex < 0) return supported[0];
	return (
		supported.find((level) => THINKING_LEVELS.indexOf(level) >= requestedIndex) ??
		[...supported].reverse().find((level) => THINKING_LEVELS.indexOf(level) < requestedIndex) ??
		supported[0]
	);
}

function taskPreview(t: TaskItemType): string {
	return preview(t.task);
}

function buildTask(
	item: TaskItemType,
	agents: ReturnType<typeof discoverAgents>["agents"],
	ctx: Parameters<typeof resolveModel>[1],
	preference: SubagentPreference | undefined,
	step?: number,
	previousOutput?: string,
): { ok: true; task: ResolvedTask } | { ok: false; error: string; suggestions?: string[] } {
	const agent = item.agent ? agents.find((a) => a.name === item.agent) : undefined;

	if (item.agent && !agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return { ok: false, error: `Unknown agent "${item.agent}". Available agents: ${available}.` };
	}

	const systemPrompt = item.systemPrompt ?? agent?.systemPrompt ?? "";
	// The user's preference for this subagent type owns model + thinking; agent
	// files and the caller's request stay as fallbacks when the preference is "auto".
	const controls = applyPreference(
		{
			model: item.model ?? agent?.model,
			tools: item.tools ?? agent?.tools,
			thinking: item.thinking ?? agent?.thinking,
			timeoutSec: item.timeoutSec ?? agent?.timeoutSec,
			maxTurns: item.maxTurns ?? agent?.maxTurns,
		},
		preference,
	);

	const resolved = resolveModel(controls.model, ctx);
	if (!resolved.ok) {
		return { ok: false, error: resolved.error, suggestions: resolved.suggestions };
	}

	let taskText = item.task;
	if (step !== undefined && previousOutput !== undefined) {
		taskText = taskText.replace(/\{previous\}/g, previousOutput);
	}

	return {
		ok: true,
		task: {
			name: item.agent ?? (item.systemPrompt ? "inline" : resolved.model.id),
			task: taskText,
			systemPrompt,
			model: resolved.model.modelId,
			tools: controls.tools,
			thinking: compatibleThinkingLevel(resolved.model, controls.thinking),
			timeoutSec: controls.timeoutSec ?? DEFAULT_SUBAGENT_TIMEOUT_SEC,
			maxTurns: controls.maxTurns,
			cwd: item.cwd,
			sessionId: item.sessionId,
			keepSession: item.keepSession,
		},
	};
}

// ---------------------------------------------------------------------------
// Usage / output helpers
// ---------------------------------------------------------------------------

function resultOutput(r: SubagentRunResult): string {
	const finalOutput = getFinalOutput(r.messages);
	let output: string;
	if (isFailedResult(r)) {
		const diagnostic = r.errorMessage || r.stderr || "Subagent stopped before producing a final answer.";
		output = finalOutput ? `${diagnostic}\n\nPartial output before stop:\n${finalOutput}` : diagnostic;
	} else {
		output = finalOutput || "(no output)";
	}
	const capped = truncateBytes(output, PARENT_OUTPUT_CAP);
	// Make multi-turn sessions actually threadable: the orchestrator must see the
	// session id in the visible result (details are not shown to the model).
	if (r.sessionId) {
		return `${capped}\n\n[Session: ${r.sessionId} — pass as sessionId to continue this context window]`;
	}
	return capped;
}

/** Keep the raw transcript in the detail entry; the browser applies reversible display caps. */
function messagesForStorage(messages: AgentMessage[]): { messages: AgentMessage[]; truncated: boolean } {
	return { messages, truncated: false };
}

/** Full per-run detail record persisted alongside the summary entry. */
function toDetailRecord(
	groupId: string,
	kind: RunRecord["kind"],
	r: SubagentRunResult,
	step: number | undefined,
	live: LiveRun,
): LiveRun {
	const startedAt = new Date(r.startedAt).getTime();
	const storedMessages = messagesForStorage(r.messages);
	return {
		runId: live.runId,
		groupId,
		kind,
		step,
		groupSize: live.groupSize,
		name: r.name,
		model: r.model,
		task: r.task,
		systemPrompt: live.systemPrompt,
		tools: live.tools ? [...live.tools] : undefined,
		thinking: live.thinking,
		cwd: live.cwd,
		timeoutSec: live.timeoutSec,
		maxTurns: live.maxTurns,
		status: isFailedResult(r) ? "error" : "ok",
		startTime: startedAt,
		endTime: startedAt + (r.durationMs ?? 0),
		usage: {
			input: r.usage.input,
			output: r.usage.output,
			cacheRead: r.usage.cacheRead,
			cacheWrite: r.usage.cacheWrite,
			cost: r.usage.cost,
			contextTokens: r.usage.contextTokens,
			turns: r.usage.turns,
		},
		activities: live.activities.slice(-MAX_STORED_ACTIVITIES),
		currentThinking: live.currentThinking,
		messages: storedMessages.messages,
		transcriptTruncated: storedMessages.truncated || live.transcriptTruncated,
		stopReason: r.stopReason,
		errorMessage: r.errorMessage,
		sessionId: r.sessionId,
	};
}

function toRunRecord(
	groupId: string,
	kind: RunRecord["kind"],
	r: SubagentRunResult,
	step: number | undefined,
	runId: string,
	groupSize?: number,
): RunRecord {
	return {
		runId,
		groupId,
		kind,
		groupSize,
		name: r.name,
		model: r.model,
		task: preview(r.task, 80),
		step,
		status: isFailedResult(r) ? "error" : "ok",
		exitCode: r.exitCode,
		stopReason: r.stopReason,
		errorMessage: r.errorMessage,
		usage: {
			input: r.usage.input,
			output: r.usage.output,
			cost: r.usage.cost,
			turns: r.usage.turns,
			contextTokens: r.usage.contextTokens,
		},
		sessionId: r.sessionId,
		startedAt: r.startedAt,
		durationMs: r.durationMs,
	};
}

const HISTORY_TRUNCATION_NOTICE = `\n[history output truncated at ${Math.floor(PARENT_OUTPUT_CAP / 1024)} KiB]`;
const HISTORY_BODY_CAP = PARENT_OUTPUT_CAP - Buffer.byteLength(HISTORY_TRUNCATION_NOTICE, "utf8");

function formatHistoryRuns(runs: LiveRun[], includeTranscript: boolean): string {
	const lines: string[] = [];
	let usedBytes = 0;
	let truncated = false;
	const add = (line: string): boolean => {
		const remaining = HISTORY_BODY_CAP - usedBytes;
		if (remaining <= 0) {
			truncated = true;
			return false;
		}
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (lineBytes + 1 <= remaining) {
			lines.push(line);
			usedBytes += lineBytes + 1;
			return true;
		}
		const markerBytes = Buffer.byteLength("… [truncated]", "utf8");
		if (remaining > markerBytes + 1) {
			lines.push(truncateBytes(line, remaining - markerBytes - 1));
		}
		usedBytes = HISTORY_BODY_CAP;
		truncated = true;
		return false;
	};

	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const run = runs[runIndex]!;
		if (runIndex > 0 && !add("---")) break;
		const headers = [
			`Run ${run.runId}`,
			`Group: ${run.groupId} · ${run.kind}${run.step !== undefined ? ` step ${run.step}` : ""}`,
			`Agent: ${run.name} · ${run.model}`,
			`Status: ${run.status}${run.stopReason ? ` · ${run.stopReason}` : ""}`,
			`Started: ${new Date(run.startTime).toISOString()}`,
		];
		if (run.endTime !== undefined) headers.push(`Duration: ${formatElapsed(run.endTime - run.startTime)}`);
		if (run.errorMessage) headers.push(`Error: ${run.errorMessage}`);
		headers.push(`Task: ${run.task}`);
		if (run.systemPrompt) headers.push(`System prompt: ${run.systemPrompt}`);
		if (run.tools?.length) headers.push(`Tools: ${run.tools.join(", ")}`);
		if (run.thinking) headers.push(`Thinking: ${run.thinking}`);
		if (run.timeoutSec !== undefined) headers.push(`Timeout: ${run.timeoutSec}s`);
		if (run.maxTurns !== undefined) headers.push(`Max turns: ${run.maxTurns}`);
		if (run.sessionId) headers.push(`Session: ${run.sessionId}`);
		for (const header of headers) if (!add(header)) break;
		if (truncated) break;

		if (!includeTranscript) {
			const finalOutput = getFinalOutput(run.messages ?? []);
			if (finalOutput && !add(`Final answer: ${truncateBytes(finalOutput, 6_000)}`)) break;
			if (!finalOutput && run.status === "running") {
				if (run.currentThinking && !add(`Current thinking: ${truncateBytes(run.currentThinking, 2_000)}`)) break;
				for (const activity of run.activities.slice(-8)) {
					const recent = activity.text || activity.toolName || activity.kind;
					if (!add(`Recent activity: ${recent}`)) break;
				}
			}
			if (truncated) break;
			continue;
		}

		if (!add("Transcript:")) break;
		let turn = 0;
		for (const message of run.messages ?? []) {
			if (message.role === "assistant") {
				turn++;
				for (const part of message.content) {
					if (part.type === "text" && part.text.trim() && !add(`[turn ${turn}] assistant: ${part.text}`)) break;
					if (part.type === "thinking" && part.thinking?.trim() && !add(`[turn ${turn}] thinking: ${part.thinking}`)) break;
					if (part.type === "toolCall" && !add(`[turn ${turn}] tool ${part.name}(${JSON.stringify(part.arguments)})`)) break;
				}
			} else if (message.role === "toolResult") {
				let hasText = false;
				for (const part of message.content) {
					if (part.type !== "text") continue;
					hasText = true;
					const label = message.isError ? "tool error" : "tool result";
					if (!add(`[turn ${turn}] ${label} ${message.toolName}: ${part.text}`)) break;
				}
				if (!hasText && !add(`[turn ${turn}] tool result ${message.toolName}`)) break;
			}
			if (truncated) break;
		}
		if (truncated) break;
		if (run.status === "running") {
			if (!add("Live activity (most recent retained events):")) break;
			for (const activity of run.activities) {
				const at = `[+${formatElapsed(activity.at)}]`;
				let detail: string;
				switch (activity.kind) {
					case "message":
						detail = `assistant (message preview): ${activity.text ?? ""}`;
						break;
					case "thinking":
						detail = `assistant: ${activity.text ?? ""}`;
						break;
					case "tool":
						detail = `tool ${activity.toolName ?? "unknown"}(${activity.args ?? activity.argsPreview ?? ""})`;
						break;
					case "toolResult":
						detail = `${activity.isError ? "tool error" : "tool result"} ${activity.toolName ?? "unknown"}: ${activity.resultText ?? activity.resultPreview ?? ""}`;
						break;
					case "status":
						detail = `status: ${activity.text ?? ""}`;
						break;
				}
				if (!add(`${at} ${detail}`)) break;
			}
			if (!truncated && run.currentThinking && !add(`Current streamed assistant text: ${run.currentThinking}`)) break;
			if (!truncated && run.activities.length === 0 && !run.currentThinking) {
				add("[no live assistant or tool activity yet]");
			}
		}
		if (truncated) break;
		if (run.transcriptTruncated && !add("[Stored transcript was truncated before this history view.]")) break;
	}

	const body = lines.join("\n");
	return truncated ? `${body}${HISTORY_TRUNCATION_NOTICE}` : body;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// In-process context windows for multi-turn subagents (sessionId reuse).
	const sessionCache = new Map<string, Agent>();

	// ---- Live run registry (browsable via /subagents while running) ----
	const liveRuns = new Map<string, LiveRun>();
	const runControllers = new Map<string, AbortController>();
	const backgroundGroups = new Map<string, BackgroundGroup>();
	let sessionShuttingDown = false;
	let sessionGeneration = 0;

	const interjectGroupCompletion = (groupId: string, result: GroupExecutionResult, generation: number): void => {
		// A session switch/reload aborts old groups; do not deliver their stale
		// results into the replacement session. The generation check also covers
		// a delayed promise settling after the replacement session starts.
		if (sessionShuttingDown || generation !== sessionGeneration) return;
		try {
			const pending = pi.sendMessage(
				{
					customType: SUBAGENT_COMPLETION_MESSAGE_TYPE,
					content: formatSubagentCompletionMessage(groupId, result),
					display: true,
					details: {
						groupId,
						mode: result.mode,
						status: result.isError ? "error" : "ok",
						resultCount: result.results.length,
					},
				},
				// Steer the parent as soon as the current turn's tool work yields; when
				// idle, triggerTurn starts a continuation immediately. This mirrors a
				// user steering message instead of waiting behind the follow-up queue.
				{ deliverAs: "steer", triggerTurn: true },
			);
			void Promise.resolve(pending).catch(() => {
				// The host may expose sendMessage as a fire-and-forget API. If its
				// async implementation rejects during shutdown, keep the group result
				// available through subagent_status without an unhandled rejection.
			});
		} catch {
			// The session can close between the shutdown check and this callback.
			// The result remains available through /subagents in that case.
		}
	};

	const trimActivities = (live: LiveRun) => {
		if (live.activities.length > MAX_STORED_ACTIVITIES)
			live.activities.splice(0, live.activities.length - MAX_STORED_ACTIVITIES);
	};

	const startLiveRun = (
		groupId: string,
		kind: LiveRun["kind"],
		spec: ResolvedTask,
		step?: number,
		groupSize?: number,
	): LiveRun => {
		const live: LiveRun = {
			runId: randomUUID(),
			groupId,
			groupSize,
			kind,
			step,
			name: spec.name,
			model: spec.model,
			task: spec.task,
			systemPrompt: spec.systemPrompt,
			tools: spec.tools ? [...spec.tools] : undefined,
			thinking: spec.thinking,
			cwd: spec.cwd,
			timeoutSec: spec.timeoutSec,
			maxTurns: spec.maxTurns,
			status: "running",
			startTime: Date.now(),
			usage: emptyUsage(),
			activities: [],
			messages: [],
		};
		liveRuns.set(live.runId, live);
		return live;
	};

	const applyRunnerEvent = (live: LiveRun, event: RunnerEvent) => {
		const at = Date.now() - live.startTime;
		switch (event.type) {
			case "message":
				accumulateUsage(live.usage, event.message);
				{
					const text = getFinalOutput([event.message]);
					if (text) live.activities.push({ kind: "message", at, text: truncateBytes(text, 600) });
				}
				break;
			case "tool": {
				const args = JSON.stringify(event.args);
				live.activities.push({
					kind: "tool",
					at,
					toolName: event.name,
					args,
					argsPreview: preview(args, 90),
				});
				break;
			}
			case "toolResult": {
				const args = JSON.stringify(event.args);
				live.activities.push({
					kind: "toolResult",
					at,
					toolName: event.name,
					args,
					argsPreview: preview(args, 90),
					resultText: event.resultText,
					resultPreview: event.resultPreview,
					resultDetails: event.resultDetails,
					isError: event.isError,
				});
				break;
			}
			case "thinking":
				live.currentThinking = event.text;
				break;
			case "status":
				live.activities.push({ kind: "status", at, text: event.text });
				break;
		}
		trimActivities(live);
	};

	const finalizeLiveRun = (live: LiveRun, r: SubagentRunResult) => {
		live.status = isFailedResult(r) ? "error" : "ok";
		live.endTime = Date.now();
		live.stopReason = r.stopReason;
		live.errorMessage = r.errorMessage;
		live.sessionId = r.sessionId;
		live.messages = r.messages;
		live.usage = { ...r.usage };
		live.currentThinking = undefined;
	};

	const persistRun = (
		generation: number,
		groupId: string,
		kind: LiveRun["kind"],
		r: SubagentRunResult,
		step: number | undefined,
		live: LiveRun,
		ctx?: ExtensionContext,
	) => {
		if (sessionShuttingDown || generation !== sessionGeneration) return;
		pi.appendEntry(RUN_ENTRY_TYPE, toRunRecord(groupId, kind, r, step, live.runId, live.groupSize));
		pi.appendEntry(RUN_DETAIL_ENTRY_TYPE, toDetailRecord(groupId, kind, r, step, live));

		// Subagents use isolated pi-agent-core Agents, so their assistant messages
		// do not pass through the parent extension event hooks. Publish one usage
		// event per completed run for the persistent token tracker.
		const qualifiedModel = r.model;
		const separator = qualifiedModel.indexOf("/");
		const provider = separator > 0 ? qualifiedModel.slice(0, separator) : undefined;
		const model = separator > 0 ? qualifiedModel.slice(separator + 1) : qualifiedModel;
		pi.events.emit(TOKEN_USAGE_EVENT, {
			recordId: `subagent:${live.runId}`,
			source: "subagent",
			timestamp: r.startedAt,
			sessionId: ctx?.sessionManager.getSessionId(),
			cwd: ctx?.cwd,
			provider,
			model,
			label: r.name,
			usage: {
				input: r.usage.input,
				output: r.usage.output,
				cacheRead: r.usage.cacheRead,
				cacheWrite: r.usage.cacheWrite,
				totalTokens: r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite,
				turns: r.usage.turns,
				cost: { total: r.usage.cost },
			},
		});
	};

	// Register a run that failed before it ever started (bad model/agent/etc.).
	const recordFinishedRun = (
		groupId: string,
		kind: LiveRun["kind"],
		r: SubagentRunResult,
		step?: number,
		ctx?: ExtensionContext,
		groupSize?: number,
		generation = sessionGeneration,
	) => {
		if (sessionShuttingDown || generation !== sessionGeneration) return;
		const live: LiveRun = {
			runId: randomUUID(),
			groupId,
			groupSize,
			kind,
			step,
			name: r.name,
			model: r.model,
			task: r.task,
			status: isFailedResult(r) ? "error" : "ok",
			startTime: new Date(r.startedAt).getTime(),
			endTime: new Date(r.startedAt).getTime() + (r.durationMs ?? 0),
			usage: { ...r.usage },
			activities: [],
			messages: r.messages,
			stopReason: r.stopReason,
			errorMessage: r.errorMessage,
			sessionId: r.sessionId,
		};
		liveRuns.set(live.runId, live);
		persistRun(generation, groupId, kind, r, step, live, ctx);
	};

	// Merge the in-memory registry with persisted detail entries for the browser.
	const collectRuns = (ctx: ExtensionContext, filter: string): LiveRun[] => {
		const byId = new Map<string, LiveRun>();
		for (const live of liveRuns.values()) {
			if (runMatchesFilter(live, filter)) byId.set(live.runId, live);
		}
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== RUN_DETAIL_ENTRY_TYPE || !entry.data) continue;
			const rec = entry.data as LiveRun;
			if (!rec || typeof rec.runId !== "string" || !rec.name) continue;
			if (!runMatchesFilter(rec, filter)) continue;
			if (!byId.has(rec.runId)) byId.set(rec.runId, rec);
		}
		return [...byId.values()].sort((a, b) => {
			const ar = a.status === "running" ? 0 : 1;
			const br = b.status === "running" ? 0 : 1;
			if (ar !== br) return ar - br;
			return b.startTime - a.startTime;
		});
	};

	const runsForGroup = (groupId: string): LiveRun[] =>
		[...liveRuns.values()].filter((run) => run.groupId === groupId).sort((a, b) => a.startTime - b.startTime);

	const formatBackgroundStatus = (requestedGroupId?: string): string => {
		const groups = [...backgroundGroups.values()]
			.filter((group) => !requestedGroupId || group.groupId === requestedGroupId)
			.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
		if (groups.length === 0) {
			return requestedGroupId
				? `No background subagent group found for ${requestedGroupId}.`
				: "No background subagent groups have been started in this session.";
		}

		const lines: string[] = [];
		for (const group of groups) {
			const runs = runsForGroup(group.groupId);
			const elapsed =
				(group.completedAt ? Date.parse(group.completedAt) : Date.now()) - Date.parse(group.startedAt);
			const icon = statusIcon(group.status === "running" ? "running" : group.status === "ok" ? "ok" : "error");
			const groupStatus = group.status === "running" && group.controller.signal.aborted ? "cancelling" : group.status;
			lines.push(`${icon} ${group.groupId} · ${group.mode} · ${groupStatus} · ${formatElapsed(elapsed)}`);
			if (runs.length === 0) {
				lines.push("  (no subagent runs have started yet)");
			} else {
				for (const run of runs) {
					const detail =
						run.status === "running"
							? runControllers.get(run.runId)?.signal.aborted
								? "cancelling"
								: "running"
							: run.errorMessage || run.stopReason || "finished";
					lines.push(`  ${statusIcon(run.status)} ${run.name} · ${run.model} · runId ${run.runId} · ${detail}`);
				}
			}
			if (group.result && group.status !== "running") {
				lines.push(`  result: ${truncateBytes(group.result.text, 1600)}`);
			}
		}
		return truncateBytes(lines.join("\n"), PARENT_OUTPUT_CAP);
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		// The user is asked for a model on the first launch; keep launches serial so
		// that prompt cannot overlap another tool call. Execution itself is always
		// detached below, so this never waits for a subagent to finish.
		executionMode: "sequential",
		description: [
			"Delegate tasks to subagents with isolated context windows. Every launch returns immediately; continue independent work or return control to the user. Completed groups automatically interject a capped result into the parent session as a follow-up.",
			"Single: {task}. Parallel: {tasks:[...], parallelLimit}. Chain: {chain:[...], onFailure, {previous}}.",
			'Model and thinking level are chosen by the user: the first launch of each subagent type asks, and the answer is reused only for that type (optionally saved globally). Native OpenAI Luna models always use priority fast mode.',
			"Use focused tasks with an explicit expected output; do not make one worker own discovery, implementation, and review.",
			"Model choices are keyed by agent definition name; unnamed tasks use the default or inline type and do not inherit another type's choice.",
			"Use parallel for independent tasks, chain for dependencies, and keepSession/sessionId to continue partial work without restarting.",
			"maxTurns reserves a finalization turn; if a run still fails, its result includes partial output and a session id when keepSession was enabled.",
			`Every group runs in the background after the launch tool returns and has a ${DEFAULT_SUBAGENT_TIMEOUT_SEC}s default hard timeout; set timeoutSec higher for longer work. Continue independent work or return control to the user; do not wait for subagent results. Use subagent_status for run ids, subagent_history with includeTranscript for live or persisted history, and subagent_cancel to stop one run or a whole group.`,
			"thinking, tools, cwd, timeoutSec, maxTurns, parallelLimit, and onFailure are orchestration controls, not decoration.",
			"Luna subagents always use OpenAI priority fast mode; callers cannot disable or override that service tier.",
			`Agents: ${formatAgentList(discoverAgents(process.cwd(), "user").agents, 5).text}.`,
		].join(" "),
		parameters: SubagentParams,
		promptGuidelines: [
			"Use subagent proactively whenever one or more focused delegated tasks would materially improve the work; there is no mode gating and the main thread can keep working while they run.",
			"Use subagent to delegate independent, parallelizable work to a fresh context window; set parallelLimit to 2-4 when concurrency is useful.",
			"When delegation is beneficial, launch the task and immediately continue independent main-thread work. If no useful work remains, return control to the user; completed results interject automatically. Use subagent_status for live snapshots, subagent_history to inspect live or prior transcripts, and subagent_cancel to stop an unwanted run/group.",
			NO_DUPLICATE_WORK_DIRECTIVE,
			"Prefer a scout/planner → focused worker → reviewer workflow instead of one broad worker call.",
			"Use subagent chain with {previous} for dependent phases; set onFailure to continue only when later phases can recover from partial evidence.",
			"Use keepSession when a task may need follow-up; resume a max-turn or partial run with its returned sessionId and a narrower task.",
			"Prefer task-specific systemPrompt and tools allowlists so subagents stay focused and finish within their turn budget; model and thinking come from the user's preference for that subagent type, so do not set them.",
			"When a native OpenAI model id/name contains Luna, the runner enforces priority fast mode at the provider payload boundary.",
		],

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parentSignal = signal ?? new AbortController().signal;
			const launchGeneration = sessionGeneration;
			const staleLaunch = (): boolean => sessionShuttingDown || launchGeneration !== sessionGeneration;
			const canceledForSessionChange = () => ({
				content: [{ type: "text" as const, text: "Subagent launch canceled because the session changed during setup." }],
				details: {},
				isError: true,
			});
			const groupId = randomUUID();
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasSingle = params.task !== undefined;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasChain = (params.chain?.length ?? 0) > 0;
			const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid subagent parameters: provide exactly one mode (task, tasks, or chain).\nAvailable agents: ${formatAgentList(agents, 8).text}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			if (parentSignal.aborted) {
				return {
					content: [
						{
							type: "text",
							text: "Subagent request canceled before start because the parent request was aborted.",
						},
					],
					details: {},
					isError: true,
				};
			}

			// Project-agent confirmation (headless-safe).
			if ((agentScope === "project" || agentScope === "both") && ctx.hasUI) {
				const items: Array<{ agent?: string }> = params.tasks ?? params.chain ?? (hasSingle ? [params] : []);
				const requestedNames = new Set(items.map((t) => t.agent).filter((n): n is string => Boolean(n)));
				const projectAgentsRequested = agents.filter(
					(a) => a.source === "project" && requestedNames.has(a.name),
				);
				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${discovery.projectAgentsDir}\n\nProject agents are repo-controlled. Continue only for trusted repositories.`,
					);
					if (staleLaunch()) return canceledForSessionChange();
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: {},
							isError: true,
						};
					}
				}
			}

			if (staleLaunch()) return canceledForSessionChange();

			// Resolve each requested agent type independently. A planner's choice must
			// never become the worker's choice, even when both run in one group.
			const preferenceItems: TaskItemType[] = params.tasks ?? params.chain ?? (hasSingle ? [params as TaskItemType] : []);
			const preferenceTypes = [...new Set(preferenceItems.map((item) => subagentTypeForTask(item)))];
			const preferencesByType = new Map<string, SubagentPreference>();
			for (const subagentType of preferenceTypes) {
				const resolution = await resolvePreference(ctx, subagentType, { shouldCancel: staleLaunch });
				if (staleLaunch()) return canceledForSessionChange();
				if (resolution.source === "cancelled") {
					return {
						content: [
							{
								type: "text",
								text: `Subagent launch canceled: the user did not choose a model for the "${subagentType}" subagent type. Ask the user which model to use, then retry.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				if ((resolution.source === "prompted" || resolution.source === "global") && resolution.preference) {
					pi.appendEntry(
						SUBAGENT_PREFERENCE_ENTRY_TYPE,
						preferenceEntryData(subagentType, resolution.preference),
					);
				}
				if (resolution.preference) preferencesByType.set(subagentType, resolution.preference);
			}

			// Subagent execution is always detached from the parent turn. The parent
			// signal is only used for the preflight cancellation check above; active
			// groups live until completion or session shutdown.
			const backgroundController = new AbortController();
			const executionSignal = backgroundController.signal;
			const mode: RunKind = hasSingle ? "single" : hasChain ? "chain" : "parallel";
			// Display-only context; the runner and scheduling limits remain unchanged.
			const groupSize = hasSingle ? 1 : hasChain ? params.chain!.length : params.tasks!.length;

			const runOne = async (
				item: TaskItemType,
				resultMode: RunKind,
				step?: number,
				previousOutput?: string,
			): Promise<SubagentRunResult> => {
				const preference = preferencesByType.get(subagentTypeForTask(item));
				const resolved = buildTask(item, agents, ctx, preference, step, previousOutput);
				if (!resolved.ok) {
					const errText = resolved.suggestions?.length
						? `${resolved.error} Did you mean: ${resolved.suggestions.join(", ")}?`
						: resolved.error;
					const result: SubagentRunResult = {
						name: item.agent ?? "inline",
						task: item.task,
						exitCode: 2,
						messages: [],
						stderr: errText,
						usage: emptyUsage(),
						model: item.model ?? "unknown",
						timeoutKilled: false,
						maxTurnsKilled: false,
						aborted: false,
						startedAt: new Date().toISOString(),
						durationMs: 0,
					};
					recordFinishedRun(groupId, resultMode, result, step, ctx, groupSize, launchGeneration);
					return result;
				}

				const spec = resolved.task;
				const live = startLiveRun(groupId, resultMode, spec, step, groupSize);
				const runController = new AbortController();
				const abortRunWithGroup = () => runController.abort();
				if (executionSignal.aborted) runController.abort();
				else executionSignal.addEventListener("abort", abortRunWithGroup, { once: true });
				runControllers.set(live.runId, runController);

				let result: SubagentRunResult;
				try {
					result = await runSubagent(spec, {
						defaultCwd: ctx.cwd,
						getModel: (id) =>
							ctx.modelRegistry
								.getAvailable()
								.find((m) => `${m.provider}/${m.id}` === id || m.id === id) as never,
						getProvider: (providerId) => ctx.modelRegistry.getProvider(providerId) as never,
						getApiKey: async (providerId) => {
							try {
								return await ctx.modelRegistry.getApiKeyForProvider(providerId);
							} catch {
							return undefined;
							}
						},
						sessionCache,
						signal: runController.signal,
						onEvent: (event) => {
							applyRunnerEvent(live, event);
						},
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					result = {
						name: spec.name,
						task: spec.task,
						exitCode: 1,
						messages: [],
						stderr: message,
						usage: emptyUsage(),
						model: spec.model,
						stopReason: "error",
						errorMessage: message,
						timeoutKilled: false,
						maxTurnsKilled: false,
						aborted: false,
						startedAt: new Date(live.startTime).toISOString(),
						durationMs: Date.now() - live.startTime,
					};
				} finally {
					executionSignal.removeEventListener("abort", abortRunWithGroup);
					runControllers.delete(live.runId);
				}

				finalizeLiveRun(live, result);
				persistRun(launchGeneration, groupId, resultMode, result, step, live, ctx);
				return result;
			};

			const tasks = params.tasks ?? [];
			if (tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [
						{
							type: "text",
							text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const runGroup = async (): Promise<GroupExecutionResult> => {
				// ---- Single mode ----
				if (hasSingle) {
					const result = await runOne(params as TaskItemType, "single");
					return {
						mode: "single",
						results: [result],
						text: isFailedResult(result)
							? `Subagent failed (${result.name}): ${resultOutput(result)}`
							: resultOutput(result),
						isError: isFailedResult(result),
					};
				}

				// ---- Chain mode ----
				if (hasChain) {
					const results: SubagentRunResult[] = [];
					const continueOnFailure = params.onFailure === "continue";
					let previousOutput = "";
					for (let i = 0; i < params.chain!.length; i++) {
						if (executionSignal.aborted) {
							return {
								mode: "chain",
								results,
								text: `Chain canceled before step ${i + 1}; no further steps were started.`,
								isError: true,
							};
						}
						const stepItem = params.chain![i];
						const result = await runOne(stepItem, "chain", i + 1, previousOutput);
						results.push(result);
						if (isFailedResult(result) && !continueOnFailure) {
							return {
								mode: "chain",
								results,
								text: `Chain stopped at step ${i + 1} (${result.name}): ${resultOutput(result)}`,
								isError: true,
							};
						}
						if (isFailedResult(result)) {
							previousOutput = `Step ${i + 1} (${result.name}) failed. Treat this as partial evidence and continue only if the next step can recover:\n\n${resultOutput(result)}`;
						} else {
							previousOutput = getFinalOutput(result.messages) || previousOutput;
						}
					}
					const last = results[results.length - 1]!;
					const failedSteps = results.filter((result) => isFailedResult(result)).length;
					const prefix =
						failedSteps > 0
							? `Chain completed with ${failedSteps} failed step${failedSteps === 1 ? "" : "s"}; later steps were allowed to continue.\n\n`
							: "";
					return {
						mode: "chain",
						results,
						text: `${prefix}${resultOutput(last)}`,
						isError: isFailedResult(last),
					};
				}

				// ---- Parallel mode ----
				const concurrency = Math.max(
					1,
					Math.min(params.parallelLimit ?? DEFAULT_CONCURRENCY, MAX_CONCURRENT_SUBAGENTS),
				);
				const results: SubagentRunResult[] = new Array(tasks.length);
				let nextIndex = 0;

				const worker = async () => {
					while (true) {
						// Do not claim queued work after cancellation. Active runs still
						// receive the execution signal through runSubagent.
						if (executionSignal.aborted) return;
						const current = nextIndex++;
						if (current >= tasks.length) return;
						const result = await runOne(tasks[current], "parallel");
						results[current] = result;
					}
				};
				await Promise.all(new Array(concurrency).fill(null).map(() => worker()));

				const done = results.filter((r) => r !== undefined).length;
				const failed = results.filter((r) => r && isFailedResult(r)).length;
				const summary = tasks.map((t: TaskItemType, i: number) => {
					const r = results[i];
					if (!r) return `- ${t.agent ?? "task"} ${i + 1}: (missing)`;
					const icon = isFailedResult(r) ? "✗" : "✓";
					return `- ${icon} ${r.name} (${r.model}): ${truncateBytes(resultOutput(r), 2000)}`;
				});
				return {
					mode: "parallel",
					results: results.filter((r): r is SubagentRunResult => Boolean(r)),
					text: `Parallel: ${done - failed}/${done} succeeded.\n\n${summary.join("\n\n")}`,
					isError: failed > 0 || done !== tasks.length,
				};
			};

			const backgroundGroup: BackgroundGroup = {
				groupId,
				mode,
				status: "running",
				startedAt: new Date().toISOString(),
				controller: backgroundController,
				promise: Promise.resolve({ mode, results: [], text: "", isError: false }),
			};
			backgroundGroups.set(groupId, backgroundGroup);
			backgroundGroup.promise = Promise.resolve()
				.then(() => runGroup())
				.then((groupResult) => {
					backgroundGroup.result = groupResult;
					backgroundGroup.status = groupResult.isError ? "error" : "ok";
					backgroundGroup.completedAt = new Date().toISOString();
					return groupResult;
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					const groupResult: GroupExecutionResult = {
						mode,
						results: [],
						text: `Background ${mode} group failed unexpectedly: ${message}`,
						isError: true,
					};
					backgroundGroup.result = groupResult;
					backgroundGroup.status = "error";
					backgroundGroup.completedAt = new Date().toISOString();
					return groupResult;
				})
				.then((groupResult) => {
					interjectGroupCompletion(groupId, groupResult, launchGeneration);
					return groupResult;
				});
			void backgroundGroup.promise;

			const count = hasSingle ? 1 : hasChain ? params.chain!.length : tasks.length;
			return {
				content: [
					{
						type: "text",
						text: `Started non-blocking ${mode} group ${groupId} with ${count} subagent run${count === 1 ? "" : "s"}. Continue independent work or return control to the user; the completed group result will be interjected automatically. Use subagent_status with groupId ${groupId} only for a non-blocking snapshot.`,
					},
				],
				details: { mode, groupId, nonBlocking: true, results: [] },
			};
		},

		// -------------------------------------------------------------------
		// TUI rendering
		// -------------------------------------------------------------------
		renderCall(args, theme, _context) {
			const scope = args.agentScope ?? "user";
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `[${scope}]`);
			text += `\n${theme.fg("warning", "non-blocking — returns immediately")}`;
			if (args.chain) {
				text += `\n${theme.fg("accent", `chain (${args.chain.length} steps)`)}`;
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", args.chain[i].agent ?? "inline")} ${theme.fg("dim", preview(taskPreview(args.chain[i])))}`;
				}
			} else if (args.tasks) {
				text += `\n${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}`;
				for (const t of args.tasks.slice(0, 3)) {
					text += `\n  ${theme.fg("accent", t.agent ?? "inline")} ${theme.fg("dim", preview(taskPreview(t)))}`;
				}
			} else {
				const name = args.agent ?? (args.model ? args.model : "inline");
				text += `\n${theme.fg("accent", name)} ${theme.fg("dim", preview(args.task ?? ""))}`;
				if (args.model) text += `\n${theme.fg("dim", `model: ${args.model}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as { mode?: string; results?: SubagentRunResult[] } | undefined;
			// The launch result is intentionally only a non-blocking acknowledgement.
			if (!details || !details.results || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			return renderRunResults(details.results, details.mode ?? "single", expanded, theme);
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent status",
		description:
			"Inspect running or completed subagent groups without waiting. Pass a groupId to inspect one group; run ids are included for individual cancellation and transcript lookup.",
		parameters: BackgroundStatusParams,
		renderResult: createToolResultRenderer("subagent_status"),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: formatBackgroundStatus(params.groupId) }],
				details: { groupId: params.groupId },
			};
		},
	});

	pi.registerTool({
		name: "subagent_history",
		label: "Subagent history",
		description:
			"Read live or persisted subagent history by runId, groupId, or metadata. For a running run, includeTranscript returns completed messages plus recent tool events and current streamed assistant text. Output is capped.",
		parameters: SubagentHistoryParams,
		renderResult: createToolResultRenderer("subagent_history"),
		async execute(_toolCallId, params, _signal, _onUpdate, rawContext) {
			const ctx = rawContext as ExtensionContext;
			const filter = (params.filter ?? "").trim();
			const matchingRuns = collectRuns(ctx, filter)
				.filter((run) => !params.runId || run.runId === params.runId)
				.filter((run) => !params.groupId || run.groupId === params.groupId)
				.sort((a, b) => b.startTime - a.startTime);
			const limit = params.runId ? 1 : (params.limit ?? 5);
			const runs = matchingRuns.slice(0, limit);
			if (runs.length === 0) {
				const text = params.runId
					? `No subagent run found for runId ${params.runId}.`
					: "No subagent history matched the requested filters.";
				return { content: [{ type: "text", text }], details: { runIds: [] }, isError: Boolean(params.runId) };
			}
			const text = formatHistoryRuns(runs, params.includeTranscript === true);
			return { content: [{ type: "text", text }], details: { runIds: runs.map((run) => run.runId) } };
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Cancel subagent",
		description:
			"Request cancellation of exactly one active run by runId, or every active run in a group by groupId. Returns immediately; queued group work is skipped.",
		parameters: SubagentCancelParams,
		renderResult: createToolResultRenderer("subagent_cancel"),
		async execute(_toolCallId, params) {
			const response = (text: string, isError = false) => ({
				content: [{ type: "text" as const, text }],
				details: {},
				...(isError ? { isError: true as const } : {}),
			});
			const hasRunId = typeof params.runId === "string" && params.runId.length > 0;
			const hasGroupId = typeof params.groupId === "string" && params.groupId.length > 0;
			if (hasRunId === hasGroupId) {
				return response("Provide exactly one of runId or groupId to cancel subagent work.", true);
			}

			if (hasRunId) {
				const run = liveRuns.get(params.runId!);
				if (!run) return response(`Unknown subagent runId ${params.runId}.`, true);
				if (run.status !== "running") {
					return response(`Subagent run ${params.runId} has already finished (${run.status}).`);
				}
				const controller = runControllers.get(params.runId!);
				if (!controller) return response(`Subagent run ${params.runId} is no longer active.`);
				if (controller.signal.aborted) {
					return response(`Cancellation was already requested for run ${params.runId}.`);
				}
				controller.abort();
				return response(`Cancellation requested for run ${params.runId}.`);
			}

			const group = backgroundGroups.get(params.groupId!);
			if (!group) return response(`Unknown subagent groupId ${params.groupId}.`, true);
			if (group.status !== "running") {
				return response(`Subagent group ${params.groupId} has already finished (${group.status}).`);
			}
			if (group.controller.signal.aborted) {
				return response(`Cancellation was already requested for group ${params.groupId}.`);
			}
			group.controller.abort();
			return response(
				`Cancellation requested for group ${params.groupId}; active runs are aborting and queued work will not start.`,
			);
		},
	});

	pi.on("session_shutdown", () => {
		sessionShuttingDown = true;
		sessionGeneration++;
		for (const group of backgroundGroups.values()) {
			if (group.status === "running") group.controller.abort();
		}
	});

	// -----------------------------------------------------------------------
	// /subagents — browsable live + recent runs
	// -----------------------------------------------------------------------
	const openBrowser = async (args: string, ctx: ExtensionContext) => {
		const filter = (args ?? "").trim();
		const runs = collectRuns(ctx, filter);
		if (runs.length === 0) {
			ctx.ui.notify(
				filter ? "No subagent runs matched the filter." : "No subagent runs yet in this session.",
				"info",
			);
			return;
		}
		const active = runs.filter((r) => r.status === "running").length;
		ctx.ui.notify(
			`Subagents: ${runs.length} run${runs.length === 1 ? "" : "s"}${active ? ` (${active} active)` : ""}. Esc to close.`,
			"info",
		);
		await ctx.ui.custom<null>(
			(tui, theme, keybindings, done) =>
				new SubagentsBrowser(
					theme,
					tui,
					() => done(null),
					() => collectRuns(ctx, filter),
					keybindings,
					() => collectRuns(ctx, ""),
				),
			{
				overlay: true,
				overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
			},
		);
	};

	// Non-interactive fallback (print/RPC modes): a plain listing via the widget.
	const renderTextList = (args: string, ctx: ExtensionContext) => {
		const filter = (args ?? "").trim();
		const entries = ctx.sessionManager.getEntries();
		const runs: RunRecord[] = [];
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE && entry.data) {
				runs.push(entry.data as RunRecord);
			}
		}
		const filtered = runs.filter((r) => runMatchesFilter(r, filter));
		const recent = filtered.slice(-15).reverse();

		if (recent.length === 0) {
			ctx.ui.notify("No subagent runs recorded yet in this session.", "info");
			return;
		}

		const lines: string[] = [];
		let totalInput = 0;
		let totalCost = 0;
		let totalTurns = 0;
		for (const r of recent) {
			const group = r.groupId
				? ` group ${r.groupId.slice(0, 8)}${r.groupSize ? ` · ${r.step !== undefined ? `step ${r.step}/` : ""}${r.groupSize}` : ""}`
				: "";
			lines.push(
				`${statusIcon(r.status)} ${r.kind === "single" ? r.name : `${r.kind}:${r.step ?? ""}:${r.name}`} [${r.model}]${group} ${r.stopReason ?? ""} ${r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : "…"}`,
			);
			lines.push(`   ${r.task}`);
			const usage = usageLine({
				input: r.usage.input,
				output: r.usage.output,
				cacheRead: 0,
				cacheWrite: 0,
				cost: r.usage.cost,
				contextTokens: r.usage.contextTokens,
				turns: r.usage.turns,
			});
			if (usage) lines.push(`   ${usage}`);
			if (r.sessionId) lines.push(`   session: ${r.sessionId}`);
			totalInput += r.usage.input;
			totalCost += r.usage.cost;
			totalTurns += r.usage.turns;
		}
		lines.push("");
		lines.push(
			`Total: ${recent.length} run(s), ${totalTurns} turns, ↑${formatTokens(totalInput)} input, $${totalCost.toFixed(4)} cost`,
		);
		ctx.ui.setWidget("subagents", lines);
	};

	pi.registerCommand("subagents", {
		description: "Browse subagent runs — live activity, per-run transcripts (optional case-insensitive multi-term filter)",
		handler: async (args, ctx) => {
			if (ctx.mode === "tui" && ctx.hasUI) {
				await openBrowser(args, ctx);
			} else {
				renderTextList(args, ctx);
			}
		},
	});

	const knownSubagentTypes = async (ctx: ExtensionContext): Promise<string[]> => {
		const discoveredTypes = discoverAgents(ctx.cwd || process.cwd(), "both").agents.map((agent) => agent.name);
		const sessionTypes = Object.keys(getSessionPreferences());
		const globalTypes = Object.keys((await loadGlobalPreferences()) ?? {});
		return [...new Set([DEFAULT_SUBAGENT_TYPE, INLINE_SUBAGENT_TYPE, ...discoveredTypes, ...sessionTypes, ...globalTypes])].sort(
			(a, b) => a.localeCompare(b),
		);
	};

	// The user owns a separate model + thinking choice for each subagent type.
	const choosePreference = async (ctx: ExtensionContext, subagentType?: string): Promise<void> => {
		const generation = sessionGeneration;
		const isStale = () => sessionShuttingDown || generation !== sessionGeneration;
		if (!ctx.hasUI) {
			ctx.ui.notify("Choosing a subagent model requires an interactive session.", "warning");
			return;
		}

		let type = subagentType ? normalizeSubagentType(subagentType) : undefined;
		if (!type) {
			const types = await knownSubagentTypes(ctx);
			if (isStale()) return;
			const selectedType = await ctx.ui.select("Which subagent type should this apply to?", types);
			if (isStale()) return;
			if (selectedType === undefined) {
				ctx.ui.notify("Subagent type selection cancelled.", "info");
				return;
			}
			type = normalizeSubagentType(selectedType);
		}

		const result = await promptForPreference(ctx, type);
		if (isStale()) return;
		if (result.cancelled || !result.preference) {
			ctx.ui.notify(`Subagent model choice for \"${type}\" was cancelled.`, "info");
			return;
		}
		if (result.persistGlobally) {
			await saveGlobalPreferenceForType(type, result.preference);
			if (isStale()) return;
		}
		if (isStale()) return;
		setSessionPreference(type, result.preference);
		pi.appendEntry(SUBAGENT_PREFERENCE_ENTRY_TYPE, preferenceEntryData(type, result.preference));
		ctx.ui.notify(
			`The \"${type}\" subagent will use ${describePreference(result.preference)}${result.persistGlobally ? " (saved for future sessions)" : " (this session)"}.`,
			"info",
		);
	};

	const formatPreferenceStatus = (
		label: string,
		preferences: Record<string, SubagentPreference>,
		type?: string,
	): string => {
		if (type) {
			const preference = preferences[normalizeSubagentType(type)];
			return `${label} (\"${normalizeSubagentType(type)}\"): ${preference ? describePreference(preference) : "not chosen yet"}`;
		}
		const entries = Object.entries(preferences).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return `${label}: ${label === "Session" ? "not chosen yet (asked on the first subagent launch)" : "not saved"}`;
		return [`${label}:`, ...entries.map(([name, preference]) => `  ${name}: ${describePreference(preference)}`)].join("\n");
	};

	const showPreferenceStatus = async (ctx: ExtensionContext, type?: string): Promise<void> => {
		const session = getSessionPreferences();
		const global = (await loadGlobalPreferences()) ?? {};
		ctx.ui.notify(
			[formatPreferenceStatus("Session", session, type), formatPreferenceStatus("Global", global, type)].join("\n"),
			"info",
		);
	};

	const resetPreferences = async (ctx: ExtensionContext, type?: string): Promise<void> => {
		if (type) {
			setSessionPreference(type, undefined);
			const global = (await loadGlobalPreferences()) ?? {};
			const saved = global[type];
			if (!saved) {
				ctx.ui.notify(`The \"${type}\" subagent model was reset; its next launch asks again.`, "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Session choice cleared; the saved global choice (${describePreference(saved)}) still applies.`, "info");
				return;
			}
			const clearGlobal = await ctx.ui.confirm(
				`Clear the saved global model for \"${type}\"?`,
				`Saved globally: ${describePreference(saved)}.`,
			);
			if (clearGlobal) {
				await clearGlobalPreferenceForType(type);
				ctx.ui.notify(`The \"${type}\" subagent model was reset; its next launch asks again.`, "info");
				return;
			}
			ctx.ui.notify(`Session choice cleared; the saved global choice (${describePreference(saved)}) still applies.`, "info");
			return;
		}

		setSessionPreference(undefined);
		const global = (await loadGlobalPreferences()) ?? {};
		if (Object.keys(global).length === 0) {
			ctx.ui.notify("Subagent model choices reset; the next launch of each type asks again.", "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("Session choices cleared; saved global choices still apply.", "info");
			return;
		}
		const clearGlobal = await ctx.ui.confirm(
			"Clear all saved global subagent models?",
			Object.entries(global)
				.map(([name, preference]) => `${name}: ${describePreference(preference)}`)
				.join("\n"),
		);
		if (clearGlobal) {
			await clearGlobalPreference();
			ctx.ui.notify("Subagent model choices reset; the next launch of each type asks again.", "info");
			return;
		}
		ctx.ui.notify("Session choices cleared; saved global choices still apply.", "info");
	};

	const openPreferenceMenu = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			await choosePreference(ctx);
			return;
		}
		const action = await ctx.ui.select("Subagent model settings", [
			"Choose a model and thinking level",
			"View current choices",
			"Reset one subagent type",
			"Reset all subagent choices",
		]);
		if (action === undefined) {
			ctx.ui.notify("Subagent model menu cancelled.", "info");
			return;
		}
		if (action === "Choose a model and thinking level") {
			await choosePreference(ctx);
			return;
		}
		if (action === "View current choices") {
			await showPreferenceStatus(ctx);
			return;
		}
		if (action === "Reset one subagent type") {
			const type = await ctx.ui.select("Which subagent type should be reset?", await knownSubagentTypes(ctx));
			if (type !== undefined) await resetPreferences(ctx, normalizeSubagentType(type));
			return;
		}
		await resetPreferences(ctx);
	};

	pi.registerCommand("subagent-model", {
		description: "Open the per-subagent-type model and thinking settings menu",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (!trimmedArgs) {
				await openPreferenceMenu(ctx);
				return;
			}

			const tokens = trimmedArgs.split(/\s+/);
			const first = tokens[0]?.toLowerCase();
			const knownActions = new Set(["select", "set", "status", "reset"]);
			const hasExplicitAction = knownActions.has(first ?? "");
			const action = hasExplicitAction ? first! : "select";
			// `/subagent-model worker` is shorthand for `select worker`; explicit
			// actions keep their type in the second token.
			const typeArgument = hasExplicitAction ? tokens[1] : tokens[0];
			const type = typeArgument ? normalizeSubagentType(typeArgument) : undefined;

			if (action === "status") {
				await showPreferenceStatus(ctx, type);
				return;
			}
			if (action === "reset") {
				await resetPreferences(ctx, type);
				return;
			}
			await choosePreference(ctx, type);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration++;
		sessionShuttingDown = false;
		for (const group of backgroundGroups.values()) {
			if (group.status === "running") group.controller.abort();
		}
		sessionCache.clear();
		liveRuns.clear();
		backgroundGroups.clear();
		runControllers.clear();
		setSessionPreferences(restoredPreferences(ctx.sessionManager.getBranch()));
	});

	pi.on("before_agent_start", (event) => {
		const preferences = getSessionPreferences();
		const entries = Object.entries(preferences).sort(([a], [b]) => a.localeCompare(b));
		const choice =
			entries.length > 0
				? `The user already chose subagent models per type (${entries.map(([type, preference]) => `${type}: ${describePreference(preference)}`).join(", ")}); do not ask again for those types. For a new type, ask on its first launch.`
				: "The user is asked to choose the subagent model and thinking level on the first launch of each session's subagent type.";
		return {
			systemPrompt: `${event.systemPrompt}\n\n[SUBAGENT DELEGATION] Subagents run in isolated context windows and are available at all times, with no mode gating. Delegate proactively whenever focused research, implementation, or review would materially improve the work. Every subagent launch is non-blocking and has a ${DEFAULT_SUBAGENT_TIMEOUT_SEC}s default hard timeout (set timeoutSec higher for long tasks); continue independent work or return control to the user. Completed groups automatically interject their capped result into this session. Use subagent_status for live snapshots and run ids, subagent_history to inspect the transcript so far or past transcripts, and subagent_cancel to stop one run or an entire group; do not wait or poll for completion. ${NO_DUPLICATE_WORK_DIRECTIVE} ${choice}`,
		};
	});
}
