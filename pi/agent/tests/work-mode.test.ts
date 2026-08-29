import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import workModeExtension from "../extensions/work-mode/index.ts";
import {
	activeToolsForMode,
	canLaunchSubagents,
	getWorkMode,
	modePrompt,
	setWorkMode,
} from "../extensions/work-mode/state.ts";

const solModel = {
	provider: "openai-codex",
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	cost: { input: 5, output: 30 },
	contextWindow: 272000,
};

const lunaModel = {
	provider: "openai-codex",
	id: "gpt-5.6-luna",
	name: "GPT-5.6 Luna",
	cost: { input: 0.2, output: 1.2 },
	contextWindow: 272000,
};

type Handler = (...args: any[]) => any;

type MockRuntime = {
	activeTools: string[];
	currentModel: typeof solModel;
	thinking: string;
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: Handler }>;
	notifications: string[];
	entries: unknown[];
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
};

function mockRuntime(): MockRuntime {
	const runtime: MockRuntime = {
		activeTools: ["read", "subagent", "subagent_status", "subagent_wait"],
		currentModel: lunaModel,
		thinking: "max",
		handlers: new Map(),
		commands: new Map(),
		notifications: [],
		entries: [],
		pi: {},
		ctx: {},
	};

	runtime.pi = {
		on: (event: string, handler: Handler) => runtime.handlers.set(event, handler),
		registerCommand: (name: string, definition: { handler: Handler }) => runtime.commands.set(name, definition),
		getActiveTools: () => [...runtime.activeTools],
		setActiveTools: (tools: string[]) => {
			runtime.activeTools = [...tools];
		},
		getThinkingLevel: () => runtime.thinking,
		setThinkingLevel: (level: string) => {
			runtime.thinking = level;
		},
		setModel: async (model: typeof solModel) => {
			runtime.currentModel = model;
			(runtime.ctx as { model: typeof solModel }).model = model;
			return true;
		},
		appendEntry: (type: string, data: unknown) => runtime.entries.push({ type, data }),
	};
	runtime.ctx = {
		model: runtime.currentModel,
		modelRegistry: {
			getAvailable: () => [solModel, lunaModel],
			hasConfiguredAuth: () => true,
		},
		ui: {
			setStatus: () => {},
			notify: (message: string) => runtime.notifications.push(message),
		},
		sessionManager: { getBranch: () => [] },
	};
	return runtime;
}

describe("work mode policy", () => {
	test("switches tool availability and prompt policy by mode", () => {
		expect(activeToolsForMode("build", ["read", "subagent", "subagent_status"])).toEqual([
			"read",
			"subagent_status",
		]);
		expect(activeToolsForMode("orchestration", ["read"])).toEqual([
			"read",
			"subagent",
			"subagent_status",
			"subagent_wait",
		]);
		expect(canLaunchSubagents("build")).toBe(false);
		expect(canLaunchSubagents("orchestration")).toBe(true);
		expect(modePrompt("orchestration")).toContain("Use the `subagent` tool aggressively");
		expect(modePrompt("orchestration")).toContain("Always load and apply the full `subagent-orchestration` skill first");
		expect(modePrompt("build")).toContain("Do not call the `subagent` launch tool");
	});

	test("build mode blocks launch calls while orchestration mode enables them", async () => {
		setWorkMode("build");
		const runtime = mockRuntime();
		workModeExtension(runtime.pi as never);
		const sessionStart = runtime.handlers.get("session_start")!;
		await sessionStart({}, runtime.ctx);

		expect(runtime.activeTools).not.toContain("subagent");
		const blocked = await runtime.handlers.get("tool_call")!({ toolName: "subagent" }, runtime.ctx);
		expect(blocked?.block).toBe(true);

		await runtime.commands.get("mode")!.handler("orchestration", runtime.ctx);
		expect(runtime.currentModel.provider).toBe("openai-codex");
		expect(runtime.currentModel.id).toBe("gpt-5.6-sol");
		expect(runtime.thinking).toBe("low");
		expect(runtime.activeTools).toContain("subagent");
		const allowed = await runtime.handlers.get("tool_call")!({ toolName: "subagent" }, runtime.ctx);
		expect(allowed).toBeUndefined();

		const otherModel = { ...lunaModel, provider: "other-provider", id: "other-model" };
		runtime.currentModel = otherModel;
		(runtime.ctx as { model: typeof otherModel }).model = otherModel;
		await runtime.handlers.get("model_select")!({ model: otherModel }, runtime.ctx);
		expect(runtime.currentModel.id).toBe("gpt-5.6-sol");
		runtime.thinking = "high";
		await runtime.handlers.get("thinking_level_select")!({ level: "high" }, runtime.ctx);
		expect(runtime.thinking).toBe("low");

		const prompt = await runtime.handlers.get("before_agent_start")!(
			{
				systemPrompt: "base",
				systemPromptOptions: {
					skills: [
						{
							name: "subagent-orchestration",
							filePath: resolve(process.cwd(), "agent/skills/subagent-orchestration/SKILL.md"),
						},
					],
				},
			},
			runtime.ctx,
		);
		expect(prompt.systemPrompt).toContain("DELEGATE BY DEFAULT");
		expect(prompt.systemPrompt).toContain("## FULL SUBAGENT-ORCHESTRATION SKILL LOADED");
		expect(prompt.systemPrompt).toContain("Core rule: hand off context, not just a task");

		await runtime.commands.get("mode")!.handler("build", runtime.ctx);
		expect(runtime.activeTools).not.toContain("subagent");
		expect(runtime.currentModel.id).toBe("gpt-5.6-sol");
		const buildPrompt = await runtime.handlers.get("before_agent_start")!({ systemPrompt: "base" }, runtime.ctx);
		expect(buildPrompt.systemPrompt).toContain("WORK DIRECTLY");
	});

	test("does not enter orchestration mode without Sol authentication", async () => {
		setWorkMode("build");
		const runtime = mockRuntime();
		(runtime.ctx.modelRegistry as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => false;
		workModeExtension(runtime.pi as never);
		await runtime.commands.get("mode")!.handler("orchestration", runtime.ctx);

		expect(getWorkMode()).toBe("build");
		expect(runtime.currentModel.id).toBe("gpt-5.6-luna");
		expect(runtime.activeTools).toContain("subagent");
		expect(runtime.notifications.at(-1)).toContain("unavailable or unauthenticated");
	});

	test("restores persisted orchestration mode and pins Sol/low", async () => {
		setWorkMode("build");
		const runtime = mockRuntime();
		(runtime.ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [
			{ type: "custom", customType: "subagent-work-mode", data: { mode: "orchestration" } },
		];
		workModeExtension(runtime.pi as never);
		await runtime.handlers.get("session_start")!({}, runtime.ctx);

		expect(getWorkMode()).toBe("orchestration");
		expect(runtime.currentModel.id).toBe("gpt-5.6-sol");
		expect(runtime.thinking).toBe("low");
		expect(runtime.activeTools).toContain("subagent");
		setWorkMode("build");
	});

	test("falls back to build mode when persisted Sol authentication is missing", async () => {
		setWorkMode("build");
		const runtime = mockRuntime();
		(runtime.ctx.modelRegistry as { hasConfiguredAuth: () => boolean }).hasConfiguredAuth = () => false;
		(runtime.ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [
			{ type: "custom", customType: "subagent-work-mode", data: { mode: "orchestration" } },
		];
		workModeExtension(runtime.pi as never);
		await runtime.handlers.get("session_start")!({}, runtime.ctx);

		expect(getWorkMode()).toBe("build");
		expect(runtime.activeTools).not.toContain("subagent");
		expect(runtime.notifications.at(-1)).toContain("could not restore Sol/low");
	});
});
