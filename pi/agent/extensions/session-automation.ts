import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SESSION_CAPABILITY =
	"[SESSION CAPABILITY] Unnamed sessions are named from their first meaningful request or active goal. Use /session-label <label> (or /label) to name the session and bookmark the current conversation branch.";
const MAX_NAME_LENGTH = 80;

type SessionEntry = {
	id?: string;
	type?: string;
	customType?: string;
	message?: { role?: string; content?: unknown };
	data?: unknown;
};

type GoalState = {
	status?: string;
	goal?: string;
	iterations?: number;
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type?: unknown; text?: unknown } => Boolean(part && typeof part === "object"))
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function compact(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function nameFromText(text: string): string | undefined {
	const normalized = compact(text)
		.replace(/^\[GOAL MODE ACTIVE[^\]]*\]\s*/i, "")
		.replace(/^Original goal:\s*/i, "")
		.replace(/^[/!][^\s]+\s*/i, "")
		.trim();
	if (!normalized) return undefined;
	return normalized.length > MAX_NAME_LENGTH ? `${normalized.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : normalized;
}

function goalFromPrompt(prompt: string | undefined): string | undefined {
	if (typeof prompt !== "string") return undefined;
	const match = prompt.match(
		/Original goal:\s*([\s\S]*?)(?:\n\s*Current designed plan:|\n\s*Work autonomously toward this goal\.|\n\s*\n)/i,
	);
	return nameFromText(match?.[1] ?? "");
}

function branchEntries(ctx: ExtensionContext): SessionEntry[] {
	return ctx.sessionManager.getBranch() as SessionEntry[];
}

function latestEntry(ctx: ExtensionContext): SessionEntry | undefined {
	return [...branchEntries(ctx)].reverse().find((entry) => typeof entry.id === "string");
}

function latestUserPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of [...branchEntries(ctx)].reverse()) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = nameFromText(textFromContent(entry.message.content));
		if (text) return text;
	}
	return undefined;
}

function latestGoalState(ctx: ExtensionContext): GoalState | undefined {
	for (const entry of [...branchEntries(ctx)].reverse()) {
		if (
			entry.type === "custom" &&
			entry.customType === "goal-mode-state" &&
			entry.data &&
			typeof entry.data === "object"
		) {
			return entry.data as GoalState;
		}
	}
	return undefined;
}

function labelCurrentEntry(pi: ExtensionAPI, ctx: ExtensionContext, label: string): void {
	const entry = latestEntry(ctx);
	if (entry?.id) pi.setLabel(entry.id, label);
}

function autoName(pi: ExtensionAPI, value: string | undefined): void {
	if (pi.getSessionName() || !value) return;
	const name = nameFromText(value);
	if (name) pi.setSessionName(name);
}

export default function sessionAutomationExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) => {
		const goalName = goalFromPrompt(event.prompt);
		if (goalName) {
			if (!pi.getSessionName()) pi.setSessionName(`Goal: ${goalName}`);
			if (/\[GOAL MODE ACTIVE\s+—\s+iteration 0\//i.test(event.prompt)) labelCurrentEntry(pi, ctx, "goal-start");
			return { systemPrompt: `${event.systemPrompt}\n\n${SESSION_CAPABILITY}` };
		}

		autoName(pi, event.prompt);
		labelCurrentEntry(pi, ctx, "work-start");
		return { systemPrompt: `${event.systemPrompt}\n\n${SESSION_CAPABILITY}` };
	});

	pi.registerCommand("session-label", {
		description: "Name the session and label the current conversation branch",
		handler: async (args, ctx) => {
			const label = compact(args);
			const entry = latestEntry(ctx);
			if (!label) {
				ctx.ui.notify(
					`Session: ${pi.getSessionName() ?? "(unnamed)"}\nCurrent branch label: ${entry?.id ? (ctx.sessionManager.getLabel(entry.id) ?? "(none)") : "(no entry)"}`,
					"info",
				);
				return;
			}
			if (label.toLowerCase() === "clear") {
				pi.setSessionName("");
				if (entry?.id) pi.setLabel(entry.id, undefined);
				ctx.ui.notify("Session name and current branch label cleared.", "info");
				return;
			}
			const name = nameFromText(label) ?? label;
			pi.setSessionName(name);
			if (entry?.id) pi.setLabel(entry.id, name);
			pi.appendEntry("session-label", { name, entryId: entry?.id });
			ctx.ui.notify(`Session labeled: ${name}`, "info");
		},
	});
	pi.registerCommand("label", {
		description: "Alias for /session-label",
		handler: async (args, ctx) => {
			const label = compact(args);
			const entry = latestEntry(ctx);
			if (!label) {
				ctx.ui.notify(`Session: ${pi.getSessionName() ?? "(unnamed)"}`, "info");
				return;
			}
			const name = nameFromText(label) ?? label;
			pi.setSessionName(name);
			if (entry?.id) pi.setLabel(entry.id, name);
			pi.appendEntry("session-label", { name, entryId: entry?.id });
			ctx.ui.notify(`Session labeled: ${name}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		autoName(pi, latestUserPrompt(ctx));
		ctx.ui.setStatus("session-automation", pi.getSessionName() ? "session labeled" : "auto-name on");
	});

	pi.on("agent_end", (_event, ctx) => {
		const goal = latestGoalState(ctx);
		if (goal?.status === "active" && typeof goal.iterations === "number") {
			labelCurrentEntry(pi, ctx, `goal-iteration-${goal.iterations}`);
		} else if (goal?.status === "completed") {
			labelCurrentEntry(pi, ctx, "goal-complete");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("session-automation", undefined);
	});
}
