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
	"When goal mode is active, first use goal_set_plan to record a concrete plan and explicit, testable acceptance criteria; do not use implementation or research tools before recording both. " +
	"Then complete at least one real work iteration, call goal_verify with concrete evidence for each criterion, and call goal_complete only after every criterion is verified. " +
	"A message from the user during an active goal is FEEDBACK on the goal, not a new request: incorporate it, revise the plan or criteria if needed, and keep working toward the goal. " +
	"If the goal is paused, the user is giving feedback when they type a message; resume addressing the goal. " +
	"If the user says to stop or pause, stop working and wait for /goal resume.";

type GoalStatus = "idle" | "active" | "paused" | "completed";
type GoalPhase = "planning" | "execution" | "verification";

interface GoalCriterion {
	id: string;
	description: string;
	verified: boolean;
	evidence: string;
}

interface GoalState {
	goal: string;
	status: GoalStatus;
	plan: string[];
	acceptanceCriteria: GoalCriterion[];
	planSetIteration: number;
	workIterationsAfterPlan: number;
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

const GoalPlanParams = Type.Object({
	plan: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
		minItems: 1,
		maxItems: 8,
		description: "Ordered, actionable implementation or work steps",
	}),
	acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
		minItems: 1,
		maxItems: 8,
		description: "Distinct, observable conditions that must be true for the goal to count as complete",
	}),
});

const GoalVerifyParams = Type.Object({
	criterionId: Type.String({ minLength: 1, description: "Criterion id from goal_set_plan, such as AC1" }),
	evidence: Type.String({
		minLength: 1,
		maxLength: 1000,
		description: "Concrete check or observation supporting this criterion",
	}),
});

const GoalCompleteParams = Type.Object({
	summary: Type.String({ description: "A concise summary of the completed goal and outcome" }),
	evidence: Type.Optional(
		Type.Array(Type.String(), {
			description: "Additional concrete checks, files, commands, or observations",
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

function normalizeItems(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.replace(/\s+/g, " ").trim().slice(0, 300);
		if (normalized && !items.includes(normalized)) items.push(normalized);
		if (items.length === 8) break;
	}
	return items;
}

function goalPhase(state: GoalState): GoalPhase {
	if (state.plan.length === 0 || state.acceptanceCriteria.length === 0) return "planning";
	return state.acceptanceCriteria.every((criterion) => criterion.verified && criterion.evidence.trim())
		? "verification"
		: "execution";
}

function completionBlockReason(state: GoalState): string | undefined {
	if (goalPhase(state) === "planning") {
		return "Record a non-empty plan and explicit acceptance criteria with goal_set_plan before completing the goal.";
	}
	if (state.iterations <= state.planSetIteration || state.workIterationsAfterPlan < 1) {
		return "Complete at least one subsequent work iteration after the current plan was recorded before verifying or completing it.";
	}
	const outstanding = state.acceptanceCriteria.filter(
		(criterion) => !criterion.verified || !criterion.evidence.trim(),
	);
	if (outstanding.length > 0) {
		return `Verify every acceptance criterion with goal_verify and concrete evidence first (outstanding: ${outstanding.map((item) => item.id).join(", ")}).`;
	}
	return undefined;
}

function normalizeRestoredCriteria(value: unknown): GoalCriterion[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 8).flatMap((candidate, index) => {
		if (!candidate || typeof candidate !== "object") return [];
		const item = candidate as Partial<GoalCriterion>;
		if (typeof item.description !== "string" || !item.description.trim()) return [];
		const evidence = typeof item.evidence === "string" ? item.evidence.trim().slice(0, 1000) : "";
		const verified = item.verified === true && evidence.length > 0;
		return [
			{
				id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `AC${index + 1}`,
				description: item.description.replace(/\s+/g, " ").trim().slice(0, 300),
				verified,
				evidence: verified ? evidence : "",
			},
		];
	});
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
		acceptanceCriteria: [],
		planSetIteration: 0,
		workIterationsAfterPlan: 0,
		progress: "Planning required: record a plan and acceptance criteria",
		iterations: 0,
		maxIterations,
		startedAt: new Date().toISOString(),
		feedback: "",
	};
}

function makeIdleState(): GoalState {
	return { ...makeInitialState(""), status: "idle", progress: "", startedAt: "" };
}

function statusText(state: GoalState): string {
	if (state.status === "active") return `◈ goal ${goalPhase(state)} ${state.iterations}/${state.maxIterations}`;
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
			if (state.acceptanceCriteria.length > 0) {
				const verified = state.acceptanceCriteria.filter((criterion) => criterion.verified).length;
				const criteria = state.acceptanceCriteria
					.slice(0, 3)
					.map(
						(criterion) =>
							`${criterion.id} ${criterion.verified ? "✓" : "○"}: ${compactUiText(criterion.description)}`,
					)
					.join("  ·  ");
				lines.push(theme.fg("dim", `  criteria ${verified}/${state.acceptanceCriteria.length}: `) + criteria);
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
	let state: GoalState = makeIdleState();
	let currentContext: ExtensionContext | undefined;
	let continuationQueued = false;
	let pendingWorkInTurn = false;
	let goalWidgetInstalled = false;
	/** Why the current run was aborted: a user pause, or a feedback-resume.
	 *  Lets agent_end(aborted) avoid pausing a goal that was just resumed
	 *  with feedback. */
	let abortIntent: "pause" | "feedback" | undefined;

	function persist(): void {
		pi.appendEntry(GOAL_STATE_TYPE, {
			...state,
			plan: [...state.plan],
			acceptanceCriteria: state.acceptanceCriteria.map((criterion) => ({ ...criterion })),
		});
	}

	function requireReplanningAfterFeedback(): void {
		state.plan = [];
		state.acceptanceCriteria = [];
		state.planSetIteration = state.iterations;
		state.workIterationsAfterPlan = 0;
		pendingWorkInTurn = false;
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
		const phase = goalPhase(state);
		const plan =
			state.plan.length > 0
				? `\n\nRecorded plan:\n${state.plan.map((item, i) => `${i + 1}. ${item}`).join("\n")}`
				: "\n\nRecorded plan: (required; not yet set)";
		const criteria =
			state.acceptanceCriteria.length > 0
				? `\n\nAcceptance criteria:\n${state.acceptanceCriteria
						.map(
							(criterion) =>
								`- ${criterion.id} [${criterion.verified ? "VERIFIED" : "UNVERIFIED"}] ${criterion.description}${criterion.evidence ? ` — evidence: ${criterion.evidence}` : ""}`,
						)
						.join("\n")}`
				: "\n\nAcceptance criteria: (required; not yet set)";
		const feedback =
			state.feedback && state.feedback.trim()
				? `\n\nLatest user feedback (address this first, revise the plan/criteria if needed, then continue):\n${state.feedback.trim()}`
				: "";
		const lifecycle =
			phase === "planning"
				? "You are in PLANNING. Your first required action is to call goal_set_plan with a concrete ordered plan AND distinct, observable acceptance criteria. Until both are recorded, no implementation or research tools may be used; ask the user with the question tool only if genuinely necessary. After planning, continue in a later goal iteration."
				: phase === "execution"
					? "You are in EXECUTION. Work through the plan in iterations, using tools and checking results. Do not claim a criterion is met without checking it. After at least one subsequent work iteration that uses a non-lifecycle tool, call goal_verify once per criterion with concrete evidence. Revise the plan/criteria with goal_set_plan if feedback changes the requirements."
					: "You are in VERIFICATION. Every criterion has recorded evidence; review that evidence against the criteria and call goal_complete only if it truly supports every one.";
		return `[GOAL MODE ACTIVE — phase ${phase} — iteration ${state.iterations}/${state.maxIterations}]\n\nOriginal goal:\n${state.goal}${plan}${criteria}${feedback}\n\n${lifecycle} A user message during the goal is feedback, not a new request: incorporate it and keep working. If information is genuinely required from the user, use the question tool. goal_complete is the sole completion path; prose markers never complete a goal. If blocked, explain the blocker and the next useful action rather than claiming success.`;
	}

	function kickoffPrompt(): string {
		return "Start in planning phase: call goal_set_plan to record an actionable plan and explicit acceptance criteria before using any other tools. Continue working through later goal iterations until every criterion is verified.";
	}

	function continuationPrompt(): string {
		const phase = goalPhase(state);
		if (phase === "planning")
			return "The goal cannot proceed without a recorded plan and acceptance criteria. Call goal_set_plan now, then continue the goal.";
		if (phase === "verification")
			return "Review the evidence recorded for every acceptance criterion. If each is truly satisfied, call goal_complete; otherwise continue work and update verification only after checking.";
		return "Continue the active goal through the next useful work iteration. Review the plan, outstanding criteria, feedback, and latest tool results; do not provide a stopping summary until all criteria have been checked and recorded with goal_verify.";
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
		name: "goal_set_plan",
		label: "Set Goal Plan",
		description:
			"Required first step in goal mode: record an actionable plan and explicit acceptance criteria before using work tools.",
		promptGuidelines: [
			"Call this before implementation or research tools while a goal is in planning phase.",
			"Use distinct, observable criteria that can each be checked and evidenced.",
		],
		parameters: GoalPlanParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.status !== "active") {
				return {
					content: [{ type: "text", text: `No active goal to plan (status: ${state.status}).` }],
					details: { status: state.status },
				};
			}

			const plan = normalizeItems(params.plan);
			const descriptions = normalizeItems(params.acceptanceCriteria);
			if (plan.length === 0 || descriptions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Goal plan rejected: provide at least one actionable plan step and one explicit acceptance criterion.",
						},
					],
					details: { status: "active", phase: "planning" },
					isError: true,
				};
			}

			const unchanged =
				JSON.stringify(plan) === JSON.stringify(state.plan) &&
				JSON.stringify(descriptions) ===
					JSON.stringify(state.acceptanceCriteria.map((criterion) => criterion.description));
			if (!unchanged) {
				state.plan = plan;
				state.acceptanceCriteria = descriptions.map((description, index) => ({
					id: `AC${index + 1}`,
					description,
					verified: false,
					evidence: "",
				}));
				state.planSetIteration = state.iterations;
				state.workIterationsAfterPlan = 0;
				pendingWorkInTurn = false;
			}
			state.progress = unchanged
				? "Plan and acceptance criteria already recorded; continue the next goal iteration"
				: "Plan and acceptance criteria recorded; begin work in the next goal iteration";
			persist();
			updateUi(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Goal plan recorded (${plan.length} steps, ${descriptions.length} acceptance criteria).\n${descriptions.map((description, index) => `AC${index + 1}: ${description}`).join("\n")}`,
					},
				],
				details: {
					status: "active",
					phase: goalPhase(state),
					plan,
					acceptanceCriteria: state.acceptanceCriteria,
				},
			};
		},
	});

	pi.registerTool({
		name: "goal_verify",
		label: "Verify Goal Criterion",
		description:
			"Record concrete evidence that one acceptance criterion from the active goal has been checked and satisfied.",
		promptGuidelines: [
			"Verify criteria individually only after at least one subsequent work iteration has used a non-lifecycle tool.",
			"Evidence must identify a concrete check, command, file, or observation; do not guess or mark unchecked criteria verified.",
		],
		parameters: GoalVerifyParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.status !== "active") {
				return {
					content: [{ type: "text", text: `No active goal to verify (status: ${state.status}).` }],
					details: { status: state.status },
				};
			}
			if (goalPhase(state) === "planning") {
				return {
					content: [
						{
							type: "text",
							text: "Cannot verify yet: record a plan and acceptance criteria with goal_set_plan first.",
						},
					],
					details: { status: "active", phase: "planning" },
					isError: true,
				};
			}
			if (state.iterations <= state.planSetIteration || state.workIterationsAfterPlan < 1) {
				return {
					content: [
						{
							type: "text",
							text: "Cannot verify yet: complete at least one subsequent work iteration after the latest plan was recorded.",
						},
					],
					details: { status: "active", phase: goalPhase(state), iterations: state.iterations },
					isError: true,
				};
			}

			const criterionId = typeof params.criterionId === "string" ? params.criterionId.trim() : "";
			const evidence = typeof params.evidence === "string" ? params.evidence.trim().slice(0, 1000) : "";
			if (!criterionId || !evidence) {
				return {
					content: [
						{
							type: "text",
							text: "Cannot verify a criterion without its id and non-empty concrete evidence.",
						},
					],
					details: { status: "active" },
					isError: true,
				};
			}
			const criterionIndex = state.acceptanceCriteria.findIndex((criterion) => criterion.id === criterionId);
			if (criterionIndex < 0) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown acceptance criterion ${criterionId}. Use one of: ${state.acceptanceCriteria.map((criterion) => criterion.id).join(", ")}.`,
						},
					],
					details: { status: "active", phase: goalPhase(state) },
					isError: true,
				};
			}

			state.acceptanceCriteria[criterionIndex] = {
				...state.acceptanceCriteria[criterionIndex]!,
				verified: true,
				evidence,
			};
			state.progress =
				goalPhase(state) === "verification"
					? "All acceptance criteria have evidence; review it and call goal_complete if it proves the goal"
					: `Recorded evidence for ${criterionId}; continue working on outstanding criteria`;
			persist();
			updateUi(ctx);
			return {
				content: [{ type: "text", text: `Recorded verification for ${criterionId}: ${evidence}` }],
				details: {
					status: "active",
					phase: goalPhase(state),
					criterion: state.acceptanceCriteria[criterionIndex],
				},
			};
		},
	});
	pi.registerTool({
		name: "goal_complete",
		label: "Complete Goal",
		description:
			"Mark the active goal complete only after every recorded acceptance criterion has concrete evidence and at least one iteration followed the latest plan.",
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

			const summary = typeof params.summary === "string" ? params.summary.trim() : "";
			if (!summary) throw new Error("goal_complete requires a non-empty summary");

			const blockedReason = completionBlockReason(state);
			if (blockedReason) {
				return {
					content: [{ type: "text", text: `Goal completion blocked: ${blockedReason}` }],
					details: { status: "active", phase: goalPhase(state), reason: blockedReason },
					isError: true,
				};
			}

			const evidence = [
				...state.acceptanceCriteria.map((criterion) => `${criterion.id}: ${criterion.evidence}`),
				...(params.evidence ?? []).map((item) => item.trim()).filter(Boolean),
			];
			completeGoal(summary, evidence, ctx);
			ctx.ui.notify("Goal completed.", "info");

			return {
				content: [
					{
						type: "text",
						text: `Goal completed: ${summary}\nVerified acceptance criteria:\n- ${state.acceptanceCriteria.map((criterion) => `${criterion.id}: ${criterion.description} — ${criterion.evidence}`).join("\n- ")}${evidence.length > state.acceptanceCriteria.length ? `\nAdditional evidence:\n- ${evidence.slice(state.acceptanceCriteria.length).join("\n- ")}` : ""}`,
					},
				],
				details: { status: "completed", summary, evidence, acceptanceCriteria: state.acceptanceCriteria },
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
				"  /goal status                 show goal, phase, plan, criteria, and feedback",
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
				const criteria =
					state.acceptanceCriteria.length > 0
						? `\nAcceptance criteria:\n${state.acceptanceCriteria.map((criterion) => `- ${criterion.id} [${criterion.verified ? "VERIFIED" : "UNVERIFIED"}] ${criterion.description}${criterion.evidence ? ` — evidence: ${criterion.evidence}` : ""}`).join("\n")}`
						: "\nAcceptance criteria: not yet recorded";
				const feedback = state.feedback ? `\nLatest feedback: ${state.feedback}` : "";
				ctx.ui.notify(
					`${statusText(state)}\n${state.goal}\n${state.progress}${feedback}${plan}${criteria}`,
					"info",
				);
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
			requireReplanningAfterFeedback();
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
			state = makeIdleState();
			continuationQueued = false;
			pendingWorkInTurn = false;
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
		pendingWorkInTurn = false;
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
		state = makeIdleState();
		continuationQueued = false;
		pendingWorkInTurn = false;
		abortIntent = undefined;
		const entry = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find(
				(candidate) =>
					candidate.type === "custom" && (candidate as GoalStateEntry).customType === GOAL_STATE_TYPE,
			) as GoalStateEntry | undefined;
		if (entry?.data?.goal && entry.data.status !== "idle") {
			const restored = entry.data;
			const restoredIteration =
				Number.isInteger(restored.planSetIteration) && restored.planSetIteration! >= 0
					? restored.planSetIteration!
					: 0;
			state = {
				...state,
				...restored,
				plan: normalizeItems(restored.plan),
				// Older persisted goals have no structured criteria, so they return to
				// planning rather than being treated as implicitly verified.
				acceptanceCriteria: normalizeRestoredCriteria(restored.acceptanceCriteria),
				planSetIteration: restoredIteration,
				workIterationsAfterPlan:
					Number.isInteger(restored.workIterationsAfterPlan) && restored.workIterationsAfterPlan! >= 0
						? restored.workIterationsAfterPlan!
						: 0,
			};
		}
		continuationQueued = false;
		updateUi(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		continuationQueued = false;
		pendingWorkInTurn = false;
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
			requireReplanningAfterFeedback();
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
			if (userPrompt && !isGenerated) {
				state.feedback = userPrompt;
				requireReplanningAfterFeedback();
				persist();
			}
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

	pi.on("tool_call", (event) => {
		if (state.status !== "active" || event.toolName === "goal_set_plan" || event.toolName === "question") return;
		if (goalPhase(state) === "planning") {
			return {
				block: true,
				reason: "Goal mode requires a structured plan and explicit acceptance criteria via goal_set_plan before any work tools can run.",
			};
		}
		if (event.toolName === "goal_verify") {
			if (state.iterations <= state.planSetIteration || state.workIterationsAfterPlan < 1) {
				return {
					block: true,
					reason: "Complete at least one subsequent work iteration after the latest plan before verifying criteria.",
				};
			}
			return;
		}
	});

	pi.on("tool_result", (event) => {
		if (
			state.status !== "active" ||
			event.isError ||
			goalPhase(state) === "planning" ||
			state.iterations <= state.planSetIteration ||
			["goal_set_plan", "goal_verify", "goal_complete", "question"].includes(event.toolName)
		) {
			return;
		}
		pendingWorkInTurn = true;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (state.status !== "active" || !isAssistantMessage(event.message)) return;
		const text = textFromMessage(event.message);
		if (text.trim()) state.progress = text.trim().replace(/\s+/g, " ").slice(-220);
		persist();
		updateUi(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.status !== "active") return;

		const last = latestAssistant(event.messages);
		const text = last ? textFromMessage(last) : "";

		if (last?.stopReason === "aborted") {
			pendingWorkInTurn = false;
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
			pendingWorkInTurn = false;
			abortIntent = undefined;
			state.status = "paused";
			state.progress = `Paused after error: ${text.slice(0, 120) || "unknown error"}`;
			persist();
			updateUi(ctx);
			return;
		}

		if (pendingWorkInTurn) state.workIterationsAfterPlan += 1;
		pendingWorkInTurn = false;
		persist();
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
		state.progress =
			goalPhase(state) === "planning"
				? "Waiting for a structured plan and acceptance criteria"
				: goalPhase(state) === "verification"
					? "Reviewing verified evidence before completion"
					: "Continuing toward the next unverified criterion";
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
