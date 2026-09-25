import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

type GoalSnapshot = {
	goal?: string;
	plan?: string[];
	acceptanceCriteria?: Array<{ id?: string; description?: string; verified?: boolean; evidence?: string }>;
	workIterationsAfterPlan?: number;
	progress?: string;
	status?: string;
};

const CONTEXT_CAPABILITY =
	"[CONTEXT CAPABILITY] Tool output is automatically bounded to protect context. When context usage is high, focused compaction preserves the active goal, success criteria, recent important results, errors, and file changes while removing redundant output.";
const DEFAULT_MAX_RESULT_CHARS = 12_000;
const DEFAULT_COMPACT_PERCENT = 78;

function configuredNumber(name: string, fallback: number, minimum: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function trimText(text: string, limit: number): { text: string; trimmed: boolean } {
	if (text.length <= limit) return { text, trimmed: false };
	if (limit <= 0) return { text: "", trimmed: true };

	const marker = (omitted: number): string => {
		return `\n\n[… trimmed ${omitted.toLocaleString()} chars from tool output; use a focused command or read range for more …]\n\n`;
	};

	let middle = marker(text.length);
	let head = 0;
	let tail = 0;
	for (let attempt = 0; attempt < 4; attempt++) {
		const available = Math.max(0, limit - middle.length);
		head = Math.floor(available * 0.72);
		tail = available - head;
		const next = marker(Math.max(0, text.length - head - tail));
		if (next === middle) break;
		middle = next;
	}

	if (middle.length >= limit) return { text: middle.slice(0, limit), trimmed: true };
	const available = limit - middle.length;
	head = Math.floor(available * 0.72);
	tail = available - head;
	const result = `${text.slice(0, head)}${middle}${text.slice(-tail)}`;
	return { text: result.length <= limit ? result : result.slice(0, limit), trimmed: true };
}

function latestGoal(ctx: ExtensionContext): GoalSnapshot | undefined {
	const entry = [...ctx.sessionManager.getBranch()]
		.reverse()
		.find((candidate) => candidate.type === "custom" && candidate.customType === "goal-mode-state");
	return entry?.type === "custom" && entry.data && typeof entry.data === "object"
		? (entry.data as GoalSnapshot)
		: undefined;
}

function goalInstruction(ctx: ExtensionContext): string {
	const goal = latestGoal(ctx);
	if (!goal || goal.status !== "active") return "No active goal state was found.";
	const plan =
		goal.plan
			?.slice(0, 8)
			.map((item, index) => `${index + 1}. ${item}`)
			.join("\n") || "(plan not yet recorded)";
	const criteria =
		goal.acceptanceCriteria
			?.slice(0, 8)
			.map(
				(criterion) =>
					`- ${criterion.id ?? "AC"} [${criterion.verified ? "VERIFIED" : "UNVERIFIED"}] ${criterion.description ?? "(missing description)"}${criterion.evidence ? ` — evidence: ${criterion.evidence}` : ""}`,
			)
			.join("\n") || "(acceptance criteria not yet recorded)";
	return `Active goal: ${goal.goal ?? "(unnamed)"}\nPlan:\n${plan}\nAcceptance criteria and evidence:\n${criteria}\nWork iterations since latest plan: ${goal.workIterationsAfterPlan ?? 0}\nLatest progress: ${(goal.progress ?? "").slice(-500)}`;
}

function resultDetails(event: ToolResultEvent, originalChars: number, retainedChars: number): unknown {
	const existing =
		event.details && typeof event.details === "object" ? (event.details as Record<string, unknown>) : {};
	return {
		...existing,
		contextTrimmed: true,
		originalChars,
		retainedChars,
	};
}

export default function contextBudgetExtension(pi: ExtensionAPI): void {
	const maxResultChars = configuredNumber("PI_CONTEXT_MAX_TOOL_CHARS", DEFAULT_MAX_RESULT_CHARS, 1_000);
	const compactPercent = configuredNumber("PI_CONTEXT_COMPACT_PERCENT", DEFAULT_COMPACT_PERCENT, 50);
	let enabled = true;
	let compactionPending = false;

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${CONTEXT_CAPABILITY}`,
	}));

	pi.on("tool_result", (event) => {
		if (!enabled) return;
		let remaining = maxResultChars;
		let originalChars = 0;
		let retainedChars = 0;
		let trimmed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			originalChars += part.text.length;
			if (remaining <= 0) {
				trimmed = true;
				return { ...part, text: "" };
			}
			if (part.text.length > remaining) {
				const result = trimText(part.text, remaining);
				trimmed = true;
				retainedChars += result.text.length;
				remaining = 0;
				return { ...part, text: result.text };
			}
			const result = trimText(part.text, remaining);
			remaining -= result.text.length;
			retainedChars += result.text.length;
			trimmed ||= result.trimmed;
			return result.trimmed ? { ...part, text: result.text } : part;
		});
		if (!trimmed) return;
		return { content, details: resultDetails(event, originalChars, retainedChars) };
	});

	function requestCompaction(ctx: ExtensionContext, reason: string): void {
		if (!enabled || compactionPending) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || usage.percent < compactPercent) return;
		compactionPending = true;
		ctx.ui.setStatus("context-budget", `compacting ${usage.percent.toFixed(0)}%`);
		ctx.compact({
			customInstructions: `${reason}

Preserve these items exactly when they are present:
- The latest user request and its constraints.
- The active goal, explicit success criteria, plan, verified evidence, and blockers.
- Recent important tool results, errors, modified files, and actionable next steps.
- Decisions and facts needed to continue.
Remove redundant tool output, repeated capability descriptions, stale progress narration, and completed low-value details.

${goalInstruction(ctx)}`,
			onComplete: () => {
				compactionPending = false;
				ctx.ui.setStatus("context-budget", undefined);
			},
			onError: (error: Error) => {
				compactionPending = false;
				ctx.ui.setStatus("context-budget", undefined);
				ctx.ui.notify(`Context compaction failed: ${error.message}`, "warning");
			},
		});
	}

	pi.registerCommand("context-budget", {
		description: "Inspect or manage context output limits and compaction",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "on") {
				enabled = true;
				ctx.ui.notify("Context budget manager enabled.", "info");
				return;
			}
			if (command === "off") {
				enabled = false;
				ctx.ui.notify("Context budget manager disabled for this session.", "warning");
				return;
			}
			if (command === "compact") {
				compactionPending = false;
				ctx.compact({
					customInstructions: `Perform a focused compaction. Preserve the latest user request, active goal criteria, recent important tool results, errors, modified files, decisions, and next steps. Remove redundant output.\n\n${goalInstruction(ctx)}`,
					onComplete: () => ctx.ui.notify("Focused context compaction complete.", "info"),
					onError: (error: Error) => ctx.ui.notify(`Context compaction failed: ${error.message}`, "warning"),
				});
				return;
			}
			const usage = ctx.getContextUsage();
			const usageText =
				usage?.percent === null || usage?.percent === undefined ? "unknown" : `${usage.percent.toFixed(0)}%`;
			ctx.ui.notify(
				`Context budget: ${enabled ? "on" : "off"} · tool cap ${maxResultChars.toLocaleString()} chars · auto-compact at ${compactPercent}% · current ${usageText}`,
				"info",
			);
		},
	});

	pi.on("agent_end", (_event, ctx) =>
		requestCompaction(ctx, "Context usage crossed the configured threshold after an agent run."),
	);
	pi.on("session_compact", (_event, ctx) => {
		compactionPending = false;
		ctx.ui.setStatus("context-budget", undefined);
	});
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("context-budget", enabled ? `cap ${Math.round(maxResultChars / 1_000)}k` : "context off");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("context-budget", undefined);
	});
}
