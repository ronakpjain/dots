import { describe, expect, test } from "bun:test";
import goalModeExtension from "../extensions/goal-mode.ts";

const goalState = (overrides: Record<string, unknown> = {}) => ({
	goal: "Implement the feature",
	status: "active",
	plan: [],
	progress: "Planning required",
	iterations: 0,
	maxIterations: 8,
	startedAt: new Date(0).toISOString(),
	...overrides,
});

function runtime(initialState = goalState()) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: any[] = [{ type: "custom", customType: "goal-mode-state", data: initialState }];
	const sentMessages: any[] = [];
	const notifications: string[] = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerShortcut() {},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: unknown, options: unknown) {
			sentMessages.push({ message, options });
		},
		getSessionName: () => "",
		setSessionName() {},
	};
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		ui: {
			setStatus() {},
			setWidget() {},
			notify(message: string) {
				notifications.push(message);
			},
		},
		sessionManager: { getBranch: () => entries },
		hasPendingMessages: () => false,
		abort() {},
	};
	goalModeExtension(pi as any);
	handlers.get("session_start")?.({}, ctx);

	const latestState = () => {
		const entry = [...entries].reverse().find((item) => item.customType === "goal-mode-state");
		return entry?.data as any;
	};
	const execute = (name: string, params: any) =>
		tools.get(name).execute!("test-call", params, undefined, undefined, ctx);
	return { handlers, tools, commands, entries, sentMessages, notifications, ctx, execute, latestState };
}

const plan = {
	plan: ["Inspect the relevant code", "Implement and run checks"],
	acceptanceCriteria: ["The lifecycle is enforced", "Tests pass"],
};

async function finishOneIteration(rt: ReturnType<typeof runtime>, text = "Continued goal work") {
	await rt.handlers.get("tool_call")?.({ toolName: "read", input: { path: "goal-work" } }, rt.ctx);
	await rt.handlers.get("tool_result")?.(
		{
			toolName: "read",
			toolCallId: "successful-work",
			input: { path: "goal-work" },
			content: [{ type: "text", text: "work completed" }],
			isError: false,
			details: undefined,
		},
		rt.ctx,
	);
	await rt.handlers.get("agent_end")?.(
		{
			messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
		},
		rt.ctx,
	);
}

describe("goal mode lifecycle enforcement", () => {
	test("requires a structured plan and criteria before allowing work tools", async () => {
		const rt = runtime();
		expect(rt.tools.has("goal_set_plan")).toBe(true);
		expect(rt.tools.has("goal_verify")).toBe(true);
		const toolCall = rt.handlers.get("tool_call")!;

		const blocked = (await toolCall({ toolName: "bash", input: { command: "echo work" } }, rt.ctx)) as any;
		expect(blocked).toMatchObject({ block: true });
		expect(blocked.reason).toContain("goal_set_plan");
		expect(await toolCall({ toolName: "question", input: {} }, rt.ctx)).toBeUndefined();

		const result = (await rt.execute("goal_set_plan", plan)) as any;
		expect(result.isError).not.toBe(true);
		expect(result.details.phase).toBe("execution");
		expect(rt.latestState().acceptanceCriteria.map((criterion: any) => criterion.id)).toEqual(["AC1", "AC2"]);
		expect(await toolCall({ toolName: "bash", input: { command: "echo work" } }, rt.ctx)).toBeUndefined();
	});

	test("legacy goals with a free-form plan still require structured criteria", async () => {
		const rt = runtime(goalState({ plan: ["Old persisted plan"] }));
		const blocked = (await rt.handlers.get("tool_call")!(
			{ toolName: "read", input: { path: "file.ts" } },
			rt.ctx,
		)) as any;
		expect(blocked?.block).toBe(true);

		const completion = (await rt.execute("goal_complete", { summary: "Done" })) as any;
		expect(completion.isError).toBe(true);
		expect(completion.details.status).toBe("active");
		expect(rt.latestState().status).toBe("active");
	});

	test("requires a subsequent iteration and evidence for every criterion; prose marker cannot complete", async () => {
		const rt = runtime();
		await rt.execute("goal_set_plan", plan);

		const tooEarly = (await rt.execute("goal_verify", { criterionId: "AC1", evidence: "checked" })) as any;
		expect(tooEarly.isError).toBe(true);
		expect(tooEarly.content[0].text).toContain("subsequent work iteration");

		const earlyCompletion = (await rt.execute("goal_complete", { summary: "Done" })) as any;
		expect(earlyCompletion.isError).toBe(true);
		expect(rt.latestState().status).toBe("active");

		await rt.handlers.get("tool_result")!(
			{
				toolName: "read",
				toolCallId: "same-plan-turn-work",
				input: { path: "goal-work" },
				content: [{ type: "text", text: "too early to count" }],
				isError: false,
				details: undefined,
			},
			rt.ctx,
		);
		await rt.handlers.get("tool_result")!(
			{
				toolName: "bash",
				toolCallId: "failed-work",
				input: { command: "failing command" },
				content: [{ type: "text", text: "failed" }],
				isError: true,
				details: undefined,
			},
			rt.ctx,
		);
		await rt.handlers.get("agent_end")!(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "[GOAL_COMPLETE] This marker is not a completion signal." }],
						stopReason: "stop",
					},
				],
			},
			rt.ctx,
		);
		expect(rt.latestState().iterations).toBe(1);
		expect(rt.latestState().workIterationsAfterPlan).toBe(0);
		expect(rt.latestState().status).toBe("active");
		expect(rt.sentMessages).toHaveLength(1);
		const noWork = (await rt.execute("goal_verify", {
			criterionId: "AC1",
			evidence: "No actual work was done",
		})) as any;
		expect(noWork.isError).toBe(true);
		expect(noWork.content[0].text).toContain("subsequent work iteration");

		await finishOneIteration(rt);
		expect(rt.latestState().workIterationsAfterPlan).toBe(1);
		const verifyFirst = (await rt.execute("goal_verify", { criterionId: "AC1", evidence: "Test A passed" })) as any;
		expect(verifyFirst.isError).not.toBe(true);
		const missingSecond = (await rt.execute("goal_complete", { summary: "Done" })) as any;
		expect(missingSecond.isError).toBe(true);
		expect(missingSecond.content[0].text).toContain("AC2");

		await rt.execute("goal_verify", { criterionId: "AC2", evidence: "Test suite passed" });
		expect(rt.latestState().acceptanceCriteria.every((criterion: any) => criterion.verified)).toBe(true);
		const completed = (await rt.execute("goal_complete", { summary: "Feature implemented" })) as any;
		expect(completed.details.status).toBe("completed");
		expect(completed.content[0].text).toContain("AC1: The lifecycle is enforced — Test A passed");
		expect(rt.latestState().status).toBe("completed");
	});

	test("rejects invalid verification and resets evidence when criteria change", async () => {
		const rt = runtime();
		await rt.execute("goal_set_plan", plan);
		await finishOneIteration(rt);

		const unknown = (await rt.execute("goal_verify", { criterionId: "AC9", evidence: "checked" })) as any;
		expect(unknown.isError).toBe(true);
		const emptyEvidence = (await rt.execute("goal_verify", { criterionId: "AC1", evidence: "  " })) as any;
		expect(emptyEvidence.isError).toBe(true);

		await rt.execute("goal_verify", { criterionId: "AC1", evidence: "Test passed" });
		const changed = (await rt.execute("goal_set_plan", {
			plan: ["Inspect", "Implement", "Validate"],
			acceptanceCriteria: ["The lifecycle is enforced", "The feature has documentation"],
		})) as any;
		expect(changed.details.phase).toBe("execution");
		expect(
			rt.latestState().acceptanceCriteria.every((criterion: any) => !criterion.verified && !criterion.evidence),
		).toBe(true);
		expect(rt.latestState().planSetIteration).toBe(1);
	});

	test("feedback forces a fresh plan, criteria, and work iteration", async () => {
		const rt = runtime();
		await rt.execute("goal_set_plan", plan);
		await finishOneIteration(rt);
		await rt.execute("goal_verify", { criterionId: "AC1", evidence: "Test A passed" });
		await rt.execute("goal_verify", { criterionId: "AC2", evidence: "Test B passed" });

		await rt.handlers.get("before_agent_start")!(
			{ systemPrompt: "system", prompt: "Please also handle the edge case." },
			rt.ctx,
		);
		expect(rt.latestState().acceptanceCriteria).toEqual([]);
		expect(rt.latestState().plan).toEqual([]);
		expect(rt.latestState().planSetIteration).toBe(1);
		const completion = (await rt.execute("goal_complete", { summary: "Done" })) as any;
		expect(completion.isError).toBe(true);
		expect(rt.latestState().status).toBe("active");
	});

	test("manual and paused feedback also force a fresh structured plan", async () => {
		const existingPlan = {
			plan: plan.plan,
			acceptanceCriteria: [
				{ id: "AC1", description: plan.acceptanceCriteria[0], verified: true, evidence: "prior check" },
			],
			iterations: 3,
			planSetIteration: 0,
			workIterationsAfterPlan: 1,
		};
		const manual = runtime(goalState(existingPlan));
		await manual.commands.get("goal").handler("feedback Add another edge case", manual.ctx);
		expect(manual.latestState().plan).toEqual([]);
		expect(manual.latestState().acceptanceCriteria).toEqual([]);
		expect(manual.latestState().status).toBe("active");

		const paused = runtime(goalState({ ...existingPlan, status: "paused" }));
		await paused.handlers.get("before_agent_start")!(
			{ systemPrompt: "system", prompt: "Please handle the edge case." },
			paused.ctx,
		);
		expect(paused.latestState().plan).toEqual([]);
		expect(paused.latestState().acceptanceCriteria).toEqual([]);
		expect(paused.latestState().status).toBe("active");
	});

	test("resets goal state when a new session has no active goal", async () => {
		const rt = runtime();
		await rt.execute("goal_set_plan", plan);
		rt.entries.splice(0);

		rt.handlers.get("session_start")!({}, rt.ctx);
		const completion = (await rt.execute("goal_complete", { summary: "Done" })) as any;
		expect(completion.details.status).toBe("idle");
		const planned = (await rt.execute("goal_set_plan", plan)) as any;
		expect(planned.details.status).toBe("idle");
	});

	test("restores verified criteria only when concrete evidence was persisted", async () => {
		const rt = runtime(
			goalState({
				plan: ["Run checks"],
				acceptanceCriteria: [
					{ id: "AC1", description: "Checks pass", verified: true, evidence: "bun test passed" },
					{ id: "AC2", description: "No evidence", verified: true, evidence: "  " },
				],
				iterations: 3,
				planSetIteration: 1,
			}),
		);
		await rt.handlers.get("turn_end")!(
			{
				message: { role: "assistant", content: [{ type: "text", text: "Restored goal" }] },
			},
			rt.ctx,
		);
		expect(rt.latestState().acceptanceCriteria).toEqual([
			{ id: "AC1", description: "Checks pass", verified: true, evidence: "bun test passed" },
			{ id: "AC2", description: "No evidence", verified: false, evidence: "" },
		]);
	});
});
