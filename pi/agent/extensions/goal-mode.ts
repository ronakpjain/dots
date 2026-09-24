import { createGitCheckpoint } from "./checkpoint.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderToolResult } from "./tool-results/render.ts";

const DEFAULT_MAX_ITERATIONS = 32;
const GOAL_CONTEXT_TYPE = "goal-mode-context";
const GOAL_STATE_TYPE = "goal-mode-state";
const GOAL_CAPABILITY_PROMPT =
	"[GOAL CAPABILITY] The user can start autonomous work with /goal <objective>. " +
	"When goal mode is active, design explicit verifiable criteria, keep working across turns, and call goal_complete only after every criterion is verified. " +
	"A message from the user during an active goal is FEEDBACK on the goal, not a new request: incorporate it, adjust the plan if needed, and keep working toward the goal. " +
	"If the goal is paused, the user is giving feedback when they type a message; resume addressing the goal. " +
	"If the user says to stop or pause, stop working and wait for /goal resume.";

type GoalStatus = "idle" | "active" | "paused" | "completed";

interface GoalState {
	goal: string;
	status: GoalStatus;
	plan: string[];
	progress: string;
	iterations: number;
	maxIterations: number;
	startedAt: string;
	completedAt?: string;
	completionSummary?: string;
	feedback?: string;
}

interface GoalMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	customType?: string;
}

interface GoalStateEntry {
	type: "custom";
	customType?: string;
	data?: GoalState;
}

const GoalCompleteParams = Type.Object({
	summary: Type.String({ description: "A concise summary of the completed goal and outcome" }),
	evidence: Type.Optional(
		Type.Array(Type.String(), {
			description: "Concrete checks, files, commands, or observations that verify completion",
			maxItems: 8,
		}),
	),
});

function textFromMessage(message: unknown): string {
	const candidate = message as GoalMessage;
	if (typeof candidate.content === "string") return candidate.content;
	if (!Array.isArray(candidate.content)) return "";

	return candidate.content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
			);
		})
		.map((part) => part.text)
		.join("\n");
}

function isAssistantMessage(message: unknown): boolean {
	return (message as GoalMessage).role === "assistant";
}

function cleanPlanItem(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(/\[(?:DONE|TODO):\d+\]/gi, "")
		.trim()
		.replace(/[.;]+$/, "");
}

function extractPlan(text: string): string[] {
	const lines = text.split("\n");
	const items: string[] = [];
	let inPlanSection = false;

	for (const line of lines) {
		const heading = line
			.match(/^#{1,4}\s*(.+)$/)?.[1]
			?.trim()
			.toLowerCase();
		if (heading) {
			inPlanSection = /plan|success criteria|acceptance criteria|steps|objective/.test(heading);
			continue;
		}

		const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
		if (!match) {
			if (inPlanSection && line.trim() === "") continue;
			if (inPlanSection && items.length > 0 && line.trim()) inPlanSection = false;
			continue;
		}

		const item = cleanPlanItem(match[1]);
		if (item.length > 3 && !items.includes(item)) items.push(item.slice(0, 140));
		if (items.length >= 8) break;
	}

	return items;
}

function latestAssistant(messages: unknown[]): GoalMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isAssistantMessage(messages[i])) return messages[i] as GoalMessage;
	}
	return undefined;
}

function makeInitialState(goal: string): GoalState {
	const configuredMax = Number.parseInt(process.env.PI_GOAL_MAX_ITERATIONS ?? "", 10);
	const maxIterations = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_ITERATIONS;
	return {
		goal,
		status: "active",
		plan: [],
		progress: "Designing a plan and success criteria",
		iterations: 0,
		maxIterations,
		startedAt: new Date().toISOString(),
		feedback: "",
	};
}

function statusText(state: GoalState): string {
	if (state.status === "active") return `◈ goal ${state.iterations}/${state.maxIterations}`;
	if (state.status === "completed") return "✓ goal complete";
	if (state.status === "paused") return "Ⅱ goal paused";
	return "";
}

function compactUiText(value: string): string {
	return (
		value
			// A widget render entry must represent one terminal line. Strip control
			// characters (including newlines) from user/model-provided text so it
			// cannot desynchronize Pi's differential renderer.
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}

function goalWidget(ctx: ExtensionContext, getState: () => GoalState): void {
	ctx.ui.setWidget("goal-mode", (_tui, theme) => ({
		render(width: number): string[] {
			const state = getState();
			const limit = Math.max(1, width);
			const icon = state.status === "completed" ? "✓" : state.status === "paused" ? "Ⅱ" : "◈";
			const heading = `${icon} ${state.status === "completed" ? "Goal complete" : state.status === "paused" ? "Goal paused" : "Goal mode"}  ·  ${state.iterations}/${state.maxIterations}`;
			const lines = [
				theme.fg(
					state.status === "completed" ? "success" : state.status === "paused" ? "warning" : "accent",
					heading,
				),
				theme.fg("text", `  ${compactUiText(state.goal)}`),
				theme.fg("muted", `  ${compactUiText(state.progress)}`),
			];

			if (state.feedback) {
				lines.push(theme.fg("warning", `  ↳ feedback: ${compactUiText(state.feedback)}`));
			}

			if (state.plan.length > 0) {
				const plan = state.plan
					.slice(0, 3)
					.map((item, index) => `${index + 1}. ${compactUiText(item)}`)
					.join("  ·  ");
				lines.push(theme.fg("dim", "  plan: ") + plan);
			}

			const hint =
				state.status === "paused"
					? "type a message or /goal resume to continue · /goal feedback <text>"
					: state.status === "active"
						? "type to give feedback · ^G pause · /goal status"
						: "";
			if (hint) lines.push(theme.fg("dim", `  ${hint}`));

			// Use an empty ellipsis so every returned entry is strictly bounded by
			// width without adding another wide glyph at the terminal edge.
			return lines.map((line) => truncateToWidth(line, limit, ""));
		},
		invalidate() {},
	}));
}

export default function goalModeExtension(pi: ExtensionAPI): void {
	let state: GoalState = {
		goal: "",
		status: "idle",
		plan: [],
		progress: "",
		iterations: 0,
		maxIterations: DEFAULT_MAX_ITERATIONS,
		startedAt: "",
		feedback: "",
	};
	let currentContext: ExtensionContext | undefined;
	let continuationQueued = false;
	let goalWidgetInstalled = false;
	/** Why the current run was aborted: a user pause, or a feedback-resume.
	 *  Lets agent_end(aborted) avoid pausing a goal that was just resumed
	 *  with feedback. */
	let abortIntent: "pause" | "feedback" | undefined;

	function persist(): void {
		pi.appendEntry(GOAL_STATE_TYPE, { ...state, plan: [...state.plan] });
	}

	function updateUi(ctx: ExtensionContext): void {
		currentContext = ctx;
		ctx.ui.setStatus("goal-mode", statusText(state) || undefined);

		if (state.status === "idle") {
			if (goalWidgetInstalled) {
				ctx.ui.setWidget("goal-mode", undefined);
				goalWidgetInstalled = false;
			}
		} else if (!goalWidgetInstalled) {
			goalWidget(ctx, () => state);
			goalWidgetInstalled = true;
		}
	}

	function completeGoal(summary: string, evidence: string[], ctx: ExtensionContext): void {
		state.status = "completed";
		state.completedAt = new Date().toISOString();
		state.completionSummary = summary;
		state.progress = evidence.length > 0 ? evidence.join(" · ") : summary;
		continuationQueued = false;
		persist();
		updateUi(ctx);
	}

	function promptForGoal(): string {
		const plan =
			state.plan.length > 0
				? `\nCurrent designed plan:\n${state.plan.map((item, i) => `${i + 1}. ${item}`).join("\n")}`
				: "";
		const feedback =
			state.feedback && state.feedback.trim()
				? `\n\nLatest user feedback (address this first, then continue the goal):\n${state.feedback.trim()}`
				: "";
		return `[GOAL MODE ACTIVE — iteration ${state.iterations}/${state.maxIterations}]\n\nOriginal goal:\n${state.goal}${plan}${feedback}\n\nWork autonomously toward this goal. On the first pass, design a concrete plan and explicit, verifiable success criteria. Then execute the plan using the available tools and verify each criterion yourself. Do not stop merely because you have a plan or because one step succeeded. A user message during the goal is feedback: incorporate it and keep going. If information is genuinely required from the user, use the question tool instead of writing a question in prose. When every criterion is verified, call goal_complete with a concise summary and concrete evidence. Never call goal_complete speculatively. If blocked, explain the blocker and the next useful action rather than claiming success.`;
	}

	function kickoffPrompt(): string {
		return "Begin working on the active goal. Design the plan and success criteria, then take the first useful action.";
	}

	function continuationPrompt(): string {
		return `Continue working on the active goal. Review the goal, your designed success criteria, and the latest tool results. Take the next useful action now; do not provide a stopping summary until the goal is verified. When all criteria pass, call goal_complete.`;
	}

	function isGoalGeneratedText(text: string): boolean {
		return text.trimStart().startsWith("[GOAL MODE ACTIVE —");
	}

	function sendGoalPrompt(
		prompt: string,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		pi.sendMessage(
			{
				customType: GOAL_CONTEXT_TYPE,
				content: `${promptForGoal()}\n\n${prompt}`,
				display: false,
			},
			options,
		);
	}

	function isGeneratedGoalPrompt(message: unknown): boolean {
		const candidate = message as GoalMessage;
		return candidate.role === "user" && textFromMessage(message).startsWith("[GOAL MODE ACTIVE —");
	}

	pi.registerTool({
		name: "goal_complete",
		label: "Complete Goal",
		description:
			"Mark the active goal as complete only after every model-designed success criterion has been verified. Include concrete evidence.",
		promptGuidelines: [
			"Use goal_complete only when the active goal is fully verified; do not use it to end a plan early.",
		],
		parameters: GoalCompleteParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.status !== "active") {
				return {
					content: [{ type: "text", text: `No active goal to complete (status: ${state.status}).` }],
					details: { status: state.status },
				};
			}

			const summary = params.summary.trim();
			if (!summary) throw new Error("goal_complete requires a non-empty summary");

			const evidence = (params.evidence ?? []).map((item) => item.trim()).filter(Boolean);
			completeGoal(summary, evidence, ctx);
			ctx.ui.notify("Goal completed.", "info");

			return {
				content: [
					{
						type: "text",
						text: `Goal completed: ${summary}${evidence.length ? `\nEvidence:\n- ${evidence.join("\n- ")}` : ""}`,
					},
				],
				details: { status: "completed", summary, evidence },
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("goal_complete ")) + theme.fg("muted", args.summary),
				0,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult("goal_complete", result, options, theme, context, {
				collapsedSummary: () => (context.isError ? "Goal completion failed" : "Goal complete"),
			});
		},
	});

	const handleGoalCommand = async (
		args: string,
		ctx: ExtensionContext & { waitForIdle?: () => Promise<void> },
	): Promise<void> => {
		const input = args.trim();
		const command = input.toLowerCase();

		if (command === "help") {
			const help = [
				"Goal mode lets pi work autonomously toward an objective you set.",
				"",
				"  /goal <objective>            start a goal (also creates a git checkpoint)",
				"  /goal status                 show goal, progress, plan, and feedback",
				"  /goal stop                   pause now and abort the current work",
				"  /goal resume                 continue working toward the goal",
				"  /goal feedback <text>        stop work, record your feedback, and resume",
				"  /goal clear                  end the goal and reset goal mode",
				"  Ctrl+Alt+G                   toggle pause / resume",
				"",
				"Giving feedback mid-goal:",
				"  - While the goal is running, just type your feedback as a normal message.",
				"    It is recorded and the goal keeps working with it in mind.",
				"  - While the goal is paused, typing a message also counts as feedback and",
				"    automatically resumes the goal.",
				"  - To stop work first, press Ctrl+Alt+G or run /goal stop, then type your",
				"    feedback; the goal resumes with it.",
				"  - /goal feedback <text> does all of that in one step.",
			].join("\n");
			ctx.ui.notify(help, "info");
			return;
		}

		if (command === "status" || command === "") {
			if (state.status === "idle") {
				ctx.ui.notify("No goal is active. Start one with /goal <objective> (or /goal help).", "info");
			} else {
				const plan =
					state.plan.length > 0
						? `\nPlan:\n${state.plan.map((item, i) => `${i + 1}. ${item}`).join("\n")}`
						: "";
				const feedback = state.feedback ? `\nLatest feedback: ${state.feedback}` : "";
				ctx.ui.notify(`${statusText(state)}\n${state.goal}\n${state.progress}${feedback}${plan}`, "info");
			}
			return;
		}

		if (command === "stop" || command === "pause") {
			if (state.status === "active") {
				state.status = "paused";
				state.progress = "Paused by user — type feedback or /goal resume to continue";
				abortIntent = "pause";
				persist();
				ctx.abort();
				updateUi(ctx);
				ctx.ui.notify(
					"Goal paused. Type your feedback (it resumes the goal) or /goal resume to continue.",
					"warning",
				);
			}
			return;
		}

		if (command.startsWith("feedback")) {
			if (state.status === "idle") {
				ctx.ui.notify("No goal is active. Start one with /goal <objective>.", "warning");
				return;
			}
			const feedbackText = input.slice("feedback".length).trim();
			if (!feedbackText) {
				ctx.ui.notify("Usage: /goal feedback <message>", "warning");
				return;
			}
			if (state.status === "active") abortIntent = "feedback";
			if (state.status === "active") ctx.abort();
			state.status = "active";
			state.feedback = feedbackText;
			state.progress = "Addressing your feedback";
			state.iterations = 0;
			continuationQueued = false;
			persist();
			updateUi(ctx);
			sendGoalPrompt(continuationPrompt(), { triggerTurn: true });
			ctx.ui.notify(`Feedback recorded; goal resuming: ${compactUiText(feedbackText)}`, "info");
			return;
		}

		if (command === "resume" || command === "continue") {
			if (state.status !== "paused") {
				ctx.ui.notify(`Cannot resume a goal with status: ${state.status}`, "warning");
				return;
			}
			state.status = "active";
			state.progress = "Resuming work";
			continuationQueued = false;
			persist();
			updateUi(ctx);
			sendGoalPrompt(continuationPrompt(), { triggerTurn: true });
			return;
		}

		if (command === "clear" || command === "reset") {
			state = makeInitialState("");
			state.status = "idle";
			continuationQueued = false;
			persist();
			updateUi(ctx);
			ctx.ui.notify("Goal state cleared.", "info");
			return;
		}

		if (typeof ctx.waitForIdle === "function") await ctx.waitForIdle();
		try {
			const checkpoint = await createGitCheckpoint(pi, ctx.cwd, "goal-start");
			pi.appendEntry("git-checkpoint", {
				id: checkpoint.id,
				label: checkpoint.label,
				createdAt: checkpoint.createdAt,
				repoRoot: checkpoint.repoRoot,
				head: checkpoint.head,
				branch: checkpoint.branch,
			});
			ctx.ui.notify(`Git checkpoint created before goal: ${checkpoint.id}`, "info");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (/not a git repository/i.test(detail)) {
				ctx.ui.notify("No Git repository found; starting goal without a checkpoint.", "warning");
			} else {
				ctx.ui.notify(`Goal not started because the Git checkpoint failed: ${detail}`, "error");
				return;
			}
		}
		if (!pi.getSessionName()) {
			const goalName = compactUiText(input);
			const suffix = goalName.length > 70 ? `${goalName.slice(0, 69).trimEnd()}…` : goalName;
			if (suffix) pi.setSessionName(`Goal: ${suffix}`);
		}
		state = makeInitialState(input);
		continuationQueued = false;
		persist();
		updateUi(ctx);
		sendGoalPrompt(kickoffPrompt(), { triggerTurn: true });
	};

	pi.registerCommand("goal", {
		description: "Start, pause, resume, or inspect autonomous goal mode",
		handler: handleGoalCommand,
	});
	pi.registerCommand("goal-mode", {
		description: "Alias for /goal",
		handler: handleGoalCommand,
	});

	pi.registerShortcut(Key.ctrlAlt("g"), {
		description: "Pause or resume goal mode",
		handler: async (ctx) => {
			if (state.status === "active") {
				state.status = "paused";
				state.progress = "Paused by user — type feedback or /goal resume to continue";
				abortIntent = "pause";
				persist();
				ctx.abort();
				updateUi(ctx);
				return;
			}
			if (state.status === "paused") {
				state.status = "active";
				state.progress = "Resuming work";
				continuationQueued = false;
				persist();
				updateUi(ctx);
				sendGoalPrompt(continuationPrompt(), { triggerTurn: true });
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const entry = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find(
				(candidate) =>
					candidate.type === "custom" && (candidate as GoalStateEntry).customType === GOAL_STATE_TYPE,
			) as GoalStateEntry | undefined;
		if (entry?.data?.goal && entry.data.status !== "idle") {
			state = {
				...state,
				...entry.data,
				plan: [...(entry.data.plan ?? [])],
			};
		}
		continuationQueued = false;
		updateUi(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		continuationQueued = false;
		abortIntent = undefined;
		updateUi(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const result: {
			systemPrompt: string;
			message?: { customType: string; content: string; display: false };
		} = {
			systemPrompt: `${event.systemPrompt}\n\n${GOAL_CAPABILITY_PROMPT}`,
		};

		const userPrompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
		const isGenerated = isGoalGeneratedText(userPrompt);

		if (state.status === "paused" && userPrompt && !isGenerated) {
			// The user typed a message while the goal is paused: record it as
			// feedback and resume the goal with that feedback in context.
			state.status = "active";
			state.feedback = userPrompt;
			state.progress = "Addressing your feedback";
			state.iterations = 0;
			continuationQueued = false;
			persist();
			result.message = {
				customType: GOAL_CONTEXT_TYPE,
				content: promptForGoal(),
				display: false,
			};
			return result;
		}

		if (state.status === "active") {
			// Any non-generated user message during the goal is feedback on it.
			if (userPrompt && !isGenerated) state.feedback = userPrompt;
			result.message = {
				customType: GOAL_CONTEXT_TYPE,
				content: promptForGoal(),
				display: false,
			};
		}
		return result;
	});

	pi.on("context", async (event) => {
		const goalMessages = event.messages.filter(
			(message) => (message as GoalMessage).customType === GOAL_CONTEXT_TYPE,
		);
		const generatedPrompts = event.messages.filter(isGeneratedGoalPrompt);

		// Goal instructions are implementation details, not conversation history.
		// Remove them completely once the goal is no longer active so a completed or
		// paused goal cannot leak into a later user request.
		if (state.status !== "active") {
			if (goalMessages.length === 0 && generatedPrompts.length === 0) return;
			return {
				messages: event.messages.filter((message) => {
					return (message as GoalMessage).customType !== GOAL_CONTEXT_TYPE && !isGeneratedGoalPrompt(message);
				}),
			};
		}

		if (goalMessages.length <= 1 && generatedPrompts.length === 0) return;

		let latestIndex = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			if ((event.messages[i] as GoalMessage).customType === GOAL_CONTEXT_TYPE) {
				latestIndex = i;
				break;
			}
		}
		return {
			messages: event.messages.filter((message, index) => {
				if (isGeneratedGoalPrompt(message)) return false;
				return (message as GoalMessage).customType !== GOAL_CONTEXT_TYPE || index === latestIndex;
			}),
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		if (state.status !== "active" || !isAssistantMessage(event.message)) return;
		const text = textFromMessage(event.message);
		const extracted = extractPlan(text);
		if (state.plan.length === 0 && extracted.length > 0) state.plan = extracted;
		if (text.trim()) state.progress = text.trim().replace(/\s+/g, " ").slice(-220);
		persist();
		updateUi(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.status !== "active") return;

		const last = latestAssistant(event.messages);
		const text = last ? textFromMessage(last) : "";
		const extracted = extractPlan(text);
		if (state.plan.length === 0 && extracted.length > 0) state.plan = extracted;

		if (/\[GOAL_COMPLETE\]/i.test(text)) {
			completeGoal(text.replace(/\[GOAL_COMPLETE\]/gi, "").trim(), [], ctx);
			return;
		}

		if (last?.stopReason === "aborted") {
			// An abort with a feedback-resume pending must not pause the goal
			// again: the feedback turn is queued and about to start.
			if (abortIntent === "feedback") {
				abortIntent = undefined;
				return;
			}
			abortIntent = undefined;
			state.status = "paused";
			state.progress = "Paused — type feedback or /goal resume to continue";
			persist();
			updateUi(ctx);
			return;
		}

		if (last?.stopReason === "error") {
			abortIntent = undefined;
			state.status = "paused";
			state.progress = `Paused after error: ${text.slice(0, 120) || "unknown error"}`;
			persist();
			updateUi(ctx);
			return;
		}

		if (state.iterations >= state.maxIterations) {
			state.status = "paused";
			state.progress = `Iteration limit reached (${state.maxIterations}) — type feedback or /goal resume to continue`;
			persist();
			updateUi(ctx);
			ctx.ui.notify("Goal paused at its iteration limit. Type feedback or /goal resume to continue.", "warning");
			return;
		}

		if (continuationQueued || ctx.hasPendingMessages()) return;

		state.iterations += 1;
		state.progress = "Continuing toward the next unverified criterion";
		continuationQueued = true;
		persist();
		updateUi(ctx);
		sendGoalPrompt(continuationPrompt(), { deliverAs: "followUp" });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state.status === "active") persist();
		ctx.ui.setStatus("goal-mode", undefined);
		ctx.ui.setWidget("goal-mode", undefined);
		goalWidgetInstalled = false;
		currentContext = undefined;
	});

	void currentContext;
}
