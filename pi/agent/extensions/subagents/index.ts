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
 *   - Background groups that continue after the launch tool returns, with status/wait controls
 *   - Abort propagation from the parent agent's signal for synchronous runs; background groups stop on session shutdown
 *   - Monitoring: run records persisted via pi.appendEntry; `/subagents`
 *     command lists active/recent runs with usage; streaming TUI updates
 *   - Output caps so subagent results never flood the orchestrator's context
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
} from "./runner.ts";
import {
	formatTokens,
	formatElapsed,
	isFailedResult,
	liveDashboardText,
	preview,
	renderLiveDashboard,
	renderRunResults,
	statusIcon,
	truncateBytes,
	usageLine,
	runMatchesFilter,
	SubagentsBrowser,
	type LiveRun,
} from "./ui.ts";
import {
	SUBAGENT_PREFERENCE_ENTRY_TYPE,
	applyPreference,
	clearGlobalPreference,
	describePreference,
	getSessionPreference,
	loadGlobalPreference,
	promptForPreference,
	resolvePreference,
	restoredPreference,
	saveGlobalPreference,
	setSessionPreference,
	type SubagentPreference,
} from "./preference.ts";
import { TOKEN_USAGE_EVENT } from "../token-tracker.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 1; // sequential by default
const MAX_PARALLEL_TASKS = 8;
const PARENT_OUTPUT_CAP = 50 * 1024; // per-task cap for text returned to the parent LLM
const RUN_ENTRY_TYPE = "subagent-run";
const RUN_DETAIL_ENTRY_TYPE = "subagent-run-detail";
const UPDATE_THROTTLE_MS = 200;
// Caps for the persisted per-run transcript (browsable via /subagents after the fact).
const MESSAGE_TEXT_CAP = 4000;
const MESSAGE_RESULT_CAP = 2000;
const MAX_STORED_ACTIVITIES = 200;
// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

const ThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
	description:
		"Reasoning level for the subagent model. Default: off (cheap & fast). Raise to low/high for harder tasks that benefit from reasoning; not all models support every level.",
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
				'/Arbitrary model: "provider/id", "provider/*", or bare id; overridden by the user\'s session-wide subagent model choice when one is set',
		}),
	),
	systemPrompt: Type.Optional(Type.String({ description: "Inline system prompt (overrides agent file prompt)" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist for this subagent" })),
	thinking: Type.Optional(ThinkingLevelSchema),
	timeoutSec: Type.Optional(Type.Number({ description: "Kill the subagent after this many seconds" })),
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
				'Arbitrary model: "provider/id", "provider/*", or bare id (single mode); overridden by the user\'s session-wide subagent model choice when one is set',
		}),
	),
	systemPrompt: Type.Optional(
		Type.String({ description: "Inline system prompt (single mode, overrides agent prompt)" }),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist (single mode)" })),
	thinking: Type.Optional(ThinkingLevelSchema),
	timeoutSec: Type.Optional(Type.Number({ description: "Kill after this many seconds (single mode)" })),
	maxTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Assistant-turn budget; the runner reserves one finalization turn at the boundary",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
	sessionId: Type.Optional(Type.String({ description: "Continue an existing subagent context window" })),
	keepSession: Type.Optional(Type.Boolean({ description: "Save the session so it can be continued later" })),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately and let this group run in the background; use subagent_status/subagent_wait for progress and results",
		}),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode: array of tasks to run concurrently" })),
	chain: Type.Optional(
		Type.Array(TaskItem, { description: "Chain mode: sequential dependent steps, {previous} = prior step output" }),
	),
	onFailure: Type.Optional(FailurePolicySchema),
	agentScope: Type.Optional(AgentScopeSchema),
	parallelLimit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_PARALLEL_TASKS,
			description: "Max concurrent subagents (default 1 = sequential; use 2-4 for independent tasks)",
		}),
	),
});

const BackgroundStatusParams = Type.Object({
	groupId: Type.Optional(
		Type.String({ description: "Background group id returned by subagent with background:true" }),
	),
});

const BackgroundWaitParams = Type.Object({
	groupId: Type.String({ description: "Background group id returned by subagent with background:true" }),
	timeoutSec: Type.Optional(
		Type.Number({
			minimum: 0,
			description: "Stop waiting after this many seconds; the background group keeps running",
		}),
	),
});

type TaskItemType = Static<typeof TaskItem>;

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

type BackgroundWaitDetails = {
	groupId: string;
	status: "missing" | "running" | "completed";
	mode?: RunKind;
	results?: SubagentRunResult[];
};

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
}

function matchesPattern(model: { provider: string; id: string; name: string }, pattern: string): boolean {
	const p = pattern.trim();
	if (!p) return false;
	if (p.includes("/")) {
		const [providerPart, idPart] = p.split("/", 2);
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
			getAvailable(): { provider: string; id: string; name: string; contextWindow: number; maxTokens: number }[];
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
	// The user's session preference owns model + thinking; agent files and the
	// caller's request stay as fallbacks when the preference is "auto".
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
			thinking: controls.thinking,
			timeoutSec: controls.timeoutSec,
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

/** Truncate message payloads so persisted detail entries stay small. */
function truncateMessagesForStorage(messages: AgentMessage[]): { messages: AgentMessage[]; truncated: boolean } {
	let truncated = false;
	const capPart = <T extends { type?: string; text?: string }>(part: T, cap: number): T => {
		if (part.type !== "text" || typeof part.text !== "string") return part;
		const text = truncateBytes(part.text, cap);
		if (text !== part.text) truncated = true;
		return { ...part, text };
	};
	const stored = messages.map((m) => {
		if (m.role === "assistant") {
			return { ...m, content: m.content.map((part) => capPart(part, MESSAGE_TEXT_CAP)) } as AgentMessage;
		}
		if (m.role === "toolResult") {
			return { ...m, content: m.content.map((part) => capPart(part, MESSAGE_RESULT_CAP)) } as AgentMessage;
		}
		return m;
	});
	return { messages: stored, truncated };
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
	const storedMessages = truncateMessagesForStorage(r.messages);
	return {
		runId: live.runId,
		groupId,
		kind,
		step,
		groupSize: live.groupSize,
		name: r.name,
		model: r.model,
		task: r.task,
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

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// In-process context windows for multi-turn subagents (sessionId reuse).
	const sessionCache = new Map<string, Agent>();

	// ---- Live run registry (browsable via /subagents while running) ----
	const liveRuns = new Map<string, LiveRun>();
	const backgroundGroups = new Map<string, BackgroundGroup>();

	const trimActivities = (live: LiveRun) => {
		if (live.activities.length > 300) live.activities.splice(0, live.activities.length - 300);
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
			case "tool":
				live.activities.push({
					kind: "tool",
					at,
					toolName: event.name,
					argsPreview: preview(JSON.stringify(event.args), 90),
				});
				break;
			case "toolResult":
				live.activities.push({
					kind: "toolResult",
					at,
					toolName: event.name,
					argsPreview: preview(JSON.stringify(event.args), 90),
					resultPreview: event.resultPreview,
					isError: event.isError,
				});
				break;
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
		groupId: string,
		kind: LiveRun["kind"],
		r: SubagentRunResult,
		step: number | undefined,
		live: LiveRun,
		ctx?: ExtensionContext,
	) => {
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
	) => {
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
		persistRun(groupId, kind, r, step, live, ctx);
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
			lines.push(`${icon} ${group.groupId} · ${group.mode} · ${group.status} · ${formatElapsed(elapsed)}`);
			if (runs.length === 0) {
				lines.push("  (no subagent runs have started yet)");
			} else {
				for (const run of runs) {
					const detail =
						run.status === "running" ? "running" : run.errorMessage || run.stopReason || "finished";
					lines.push(`  ${statusIcon(run.status)} ${run.name} · ${run.model} · ${detail}`);
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
		// that prompt cannot overlap another tool call.
		executionMode: "sequential",
		description: [
			"Delegate tasks to subagents with isolated context windows and explicit orchestration controls. Use background:true when the main thread should continue while they run.",
			"Single: {task}. Parallel: {tasks:[...], parallelLimit}. Chain: {chain:[...], onFailure, {previous}}.",
			'Model and thinking level are chosen by the user: the first launch in a session asks, and the answer is reused for the session (optionally saved globally). Native OpenAI Luna models always use priority fast mode.',
			"Use focused tasks with an explicit expected output; do not make one worker own discovery, implementation, and review.",
			"Use parallel for independent tasks, chain for dependencies, and keepSession/sessionId to continue partial work without restarting.",
			"maxTurns reserves a finalization turn; if a run still fails, its result includes partial output and a session id when keepSession was enabled.",
			"Background groups keep running after the launch tool returns, so continue independent main-thread work and synchronize with subagent_wait only at dependency points.",
			"thinking, tools, cwd, timeoutSec, maxTurns, parallelLimit, and onFailure are orchestration controls, not decoration.",
			"Luna subagents always use OpenAI priority fast mode; callers cannot disable or override that service tier.",
			`Agents: ${formatAgentList(discoverAgents(process.cwd(), "user").agents, 5).text}.`,
		].join(" "),
		parameters: SubagentParams,
		promptGuidelines: [
			"Use subagent proactively whenever one or more focused delegated tasks would materially improve the work; there is no mode gating and the main thread can keep working while they run.",
			"Use subagent to delegate independent, parallelizable work to a fresh context window; set parallelLimit to 2-4 when concurrency is useful.",
			"When delegation is beneficial and independent work remains, set background:true, continue independent main-thread work, then use subagent_status or subagent_wait instead of idling.",
			"Prefer a scout/planner → focused worker → reviewer workflow instead of one broad worker call.",
			"Use subagent chain with {previous} for dependent phases; set onFailure to continue only when later phases can recover from partial evidence.",
			"Use keepSession when a task may need follow-up; resume a max-turn or partial run with its returned sessionId and a narrower task.",
			"Prefer task-specific systemPrompt and tools allowlists so subagents stay focused and finish within their turn budget; model and thinking come from the user's session preference, so do not set them.",
			"When a native OpenAI model id/name contains Luna, the runner enforces priority fast mode at the provider payload boundary.",
		],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parentSignal = signal ?? new AbortController().signal;
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
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: {},
							isError: true,
						};
					}
				}
			}

			// The user owns the subagent model + thinking level. Ask once per session
			// (or reuse the session/global choice) before any work is scheduled.
			const resolution = await resolvePreference(ctx);
			if (resolution.source === "cancelled") {
				return {
					content: [
						{
							type: "text",
							text: "Subagent launch canceled: the user did not choose a subagent model. Ask the user which model to use, then retry.",
						},
					],
					details: {},
					isError: true,
				};
			}
			if ((resolution.source === "prompted" || resolution.source === "global") && resolution.preference) {
				pi.appendEntry(SUBAGENT_PREFERENCE_ENTRY_TYPE, resolution.preference);
			}
			const preference = resolution.preference;

			const background = params.background === true;
			const backgroundController = background ? new AbortController() : undefined;
			const executionSignal = backgroundController?.signal ?? parentSignal;
			const dashboardOnUpdate = background ? undefined : onUpdate;
			const mode: RunKind = hasSingle ? "single" : hasChain ? "chain" : "parallel";
			// Display-only context; the runner and scheduling limits remain unchanged.
			const groupSize = hasSingle ? 1 : hasChain ? params.chain!.length : params.tasks!.length;

			const makeDetails = (results: SubagentRunResult[], resultMode: RunKind, live?: LiveRun[]) => ({
				mode: resultMode,
				results,
				live,
			});

			// Throttled streaming updates — stream a live per-subagent dashboard.
			let lastUpdate = 0;
			const emitDashboard = (resultMode: RunKind, force = false) => {
				if (!dashboardOnUpdate) return;
				const now = Date.now();
				if (!force && now - lastUpdate < UPDATE_THROTTLE_MS) return;
				lastUpdate = now;
				const live = [...liveRuns.values()].filter((r) => r.groupId === groupId);
				dashboardOnUpdate({
					content: [{ type: "text", text: liveDashboardText(live) }],
					details: makeDetails([], resultMode, live),
				});
			};

			const runOne = async (
				item: TaskItemType,
				resultMode: RunKind,
				step?: number,
				previousOutput?: string,
			): Promise<SubagentRunResult> => {
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
					recordFinishedRun(groupId, resultMode, result, step, ctx, groupSize);
					emitDashboard(resultMode, true);
					return result;
				}

				const spec = resolved.task;
				const live = startLiveRun(groupId, resultMode, spec, step, groupSize);

				const result = await runSubagent(spec, {
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
					signal: executionSignal,
					onEvent: (event) => {
						applyRunnerEvent(live, event);
						emitDashboard(resultMode);
					},
				});

				finalizeLiveRun(live, result);
				persistRun(groupId, resultMode, result, step, live, ctx);
				emitDashboard(resultMode, true);
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
					Math.min(params.parallelLimit ?? DEFAULT_CONCURRENCY, MAX_PARALLEL_TASKS),
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

			if (!background) {
				const groupResult = await runGroup();
				return {
					content: [{ type: "text", text: groupResult.text }],
					details: makeDetails(groupResult.results, groupResult.mode),
					isError: groupResult.isError,
				};
			}

			const backgroundGroup: BackgroundGroup = {
				groupId,
				mode,
				status: "running",
				startedAt: new Date().toISOString(),
				controller: backgroundController!,
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
				});
			void backgroundGroup.promise;

			const count = hasSingle ? 1 : hasChain ? params.chain!.length : tasks.length;
			return {
				content: [
					{
						type: "text",
						text: `Started background ${mode} group ${groupId} with ${count} subagent run${count === 1 ? "" : "s"}. Continue independent work; use subagent_status with groupId ${groupId} to monitor it and subagent_wait when its results are needed.`,
					},
				],
				details: { mode, groupId, background: true, results: [] },
			};
		},

		// -------------------------------------------------------------------
		// TUI rendering
		// -------------------------------------------------------------------
		renderCall(args, theme, _context) {
			const scope = args.agentScope ?? "user";
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `[${scope}]`);
			if (args.background) text += `\n${theme.fg("warning", "background — returns immediately")}`;
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
			const details = result.details as
				{ mode?: string; results?: SubagentRunResult[]; live?: LiveRun[] } | undefined;
			// Live streaming dashboard (details carried by onUpdate while running).
			if (details?.live && details.live.length > 0) {
				return renderLiveDashboard(details.live, expanded, theme);
			}
			// Final result.
			if (!details || !details.results || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			return renderRunResults(details.results, details.mode ?? "single", expanded, theme);
		},
	});

	type GroupWaitOutcome = { kind: "done"; result: GroupExecutionResult } | { kind: "timeout" } | { kind: "aborted" };

	const waitForGroup = (
		group: BackgroundGroup,
		timeoutSec: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<GroupWaitOutcome> => {
		if (group.result && group.status !== "running") return Promise.resolve({ kind: "done", result: group.result });
		return new Promise((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let onAbort: () => void;
			const finish = (outcome: GroupWaitOutcome) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(outcome);
			};
			onAbort = () => finish({ kind: "aborted" });
			group.promise.then((result) => finish({ kind: "done", result }));
			if (timeoutSec !== undefined) timer = setTimeout(() => finish({ kind: "timeout" }), timeoutSec * 1000);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	};

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent status",
		description: "Inspect running or completed background subagent groups. Pass a groupId to inspect one group.",
		parameters: BackgroundStatusParams,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: formatBackgroundStatus(params.groupId) }],
				details: { groupId: params.groupId },
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for subagents",
		description:
			"Wait for a background subagent group to finish and return its collected results. A timeout only stops waiting; it does not cancel the group.",
		parameters: BackgroundWaitParams,
		async execute(_toolCallId, params, signal) {
			const group = backgroundGroups.get(params.groupId);
			if (!group) {
				return {
					content: [{ type: "text", text: `No background subagent group found for ${params.groupId}.` }],
					details: { groupId: params.groupId, status: "missing" as const } as BackgroundWaitDetails,
					isError: true,
				};
			}

			const outcome = await waitForGroup(group, params.timeoutSec, signal);
			if (outcome.kind === "timeout") {
				return {
					content: [
						{
							type: "text",
							text: `Background group ${params.groupId} is still running after ${params.timeoutSec}s.\n\n${formatBackgroundStatus(params.groupId)}`,
						},
					],
					details: { groupId: params.groupId, status: "running" as const },
				};
			}
			if (outcome.kind === "aborted") {
				return {
					content: [
						{
							type: "text",
							text: `Stopped waiting for background group ${params.groupId}; the group continues running.`,
						},
					],
					details: { groupId: params.groupId, status: "running" as const },
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Background group ${params.groupId} completed.\n\n${truncateBytes(outcome.result.text, PARENT_OUTPUT_CAP)}`,
					},
				],
				details: {
					groupId: params.groupId,
					status: "completed" as const,
					mode: outcome.result.mode,
					results: outcome.result.results,
				},
				isError: outcome.result.isError,
			};
		},
	});

	pi.on("session_shutdown", () => {
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

	// The user owns the subagent model + thinking level for the session.
	const choosePreference = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("Choosing a subagent model requires an interactive session.", "warning");
			return;
		}
		const result = await promptForPreference(ctx);
		if (result.cancelled || !result.preference) {
			ctx.ui.notify("Subagent model choice cancelled.", "info");
			return;
		}
		setSessionPreference(result.preference);
		pi.appendEntry(SUBAGENT_PREFERENCE_ENTRY_TYPE, result.preference);
		if (result.persistGlobally) await saveGlobalPreference(result.preference);
		ctx.ui.notify(
			`Subagents will use ${describePreference(result.preference)}${result.persistGlobally ? " (saved for future sessions)" : " (this session)"}.`,
			"info",
		);
	};

	pi.registerCommand("subagent-model", {
		description: "Choose the model and thinking level subagents use (remembered per session; optional global save)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") {
				const session = getSessionPreference();
				const global = await loadGlobalPreference();
				ctx.ui.notify(
					[
						`Session: ${session ? describePreference(session) : "not chosen yet (asked on the first subagent launch)"}`,
						`Global: ${global ? describePreference(global) : "not saved"}`,
					].join("\n"),
					"info",
				);
				return;
			}
			if (action === "reset") {
				setSessionPreference(undefined);
				const global = await loadGlobalPreference();
				if (!global) {
					ctx.ui.notify("Subagent model reset; the next launch asks again.", "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`Session choice cleared; the saved global choice (${describePreference(global)}) still applies.`,
						"info",
					);
					return;
				}
				const clearGlobal = await ctx.ui.confirm(
					"Clear the saved global subagent model?",
					`Saved globally: ${describePreference(global)}.`,
				);
				if (clearGlobal) {
					await clearGlobalPreference();
					ctx.ui.notify("Subagent model reset; the next launch asks again.", "info");
					return;
				}
				ctx.ui.notify(
					`Session choice cleared; the saved global choice (${describePreference(global)}) still applies.`,
					"info",
				);
				return;
			}
			if (action !== "" && action !== "select" && action !== "set") {
				ctx.ui.notify("Usage: /subagent-model [select|status|reset]", "warning");
				return;
			}
			await choosePreference(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		setSessionPreference(restoredPreference(ctx.sessionManager.getBranch()));
	});

	pi.on("before_agent_start", (event) => {
		const preference = getSessionPreference();
		const choice = preference
			? `The user already chose the subagent model for this session (${describePreference(preference)}); do not ask for one again and do not set model/thinking per task.`
			: "The user is asked to choose the subagent model and thinking level on the first launch of each session.";
		return {
			systemPrompt: `${event.systemPrompt}\n\n[SUBAGENT DELEGATION] Subagents run in isolated context windows and are available at all times, with no mode gating. Delegate proactively whenever focused research, implementation, or review would materially improve the work, and keep the main thread productive with background:true while they run. ${choice}`,
		};
	});
}
