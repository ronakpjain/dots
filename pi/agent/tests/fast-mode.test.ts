import { describe, expect, test } from "bun:test";
import fastModeExtension, {
	applyFastMode,
	FAST_MODE_ALIAS,
	FAST_MODE_COMMAND,
	FAST_MODE_SERVICE_TIER,
	FAST_MODE_SHORTCUT,
	isLunaModel,
	isOpenAIModel,
} from "../extensions/fast-mode.ts";

type Handler = (...args: any[]) => any;

type TestRuntime = {
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: Handler }>;
	shortcuts: Map<string, { handler: Handler }>;
	notifications: string[];
	statuses: Map<string, string | undefined>;
	pi: Record<string, unknown>;
	ctx: Record<string, any>;
};

function testRuntime(model: Record<string, unknown> = { provider: "openai-codex", id: "gpt-5.6-sol" }): TestRuntime {
	const runtime = {
		handlers: new Map<string, Handler>(),
		commands: new Map<string, { handler: Handler }>(),
		shortcuts: new Map<string, { handler: Handler }>(),
		notifications: [],
		statuses: new Map<string, string | undefined>(),
		pi: {},
		ctx: {},
	} as TestRuntime;

	runtime.pi = {
		on: (event: string, handler: Handler) => runtime.handlers.set(event, handler),
		registerCommand: (name: string, definition: { handler: Handler }) => runtime.commands.set(name, definition),
		registerShortcut: (shortcut: string, definition: { handler: Handler }) =>
			runtime.shortcuts.set(shortcut, definition),
	};
	runtime.ctx = {
		model,
		ui: {
			notify: (message: string) => runtime.notifications.push(message),
			setStatus: (key: string, value: string | undefined) => runtime.statuses.set(key, value),
		},
	};
	return runtime;
}

async function requestPayload(runtime: TestRuntime, payload: unknown): Promise<any> {
	const result = await runtime.handlers.get("before_provider_request")!({ payload }, runtime.ctx);
	return result === undefined ? payload : result;
}

describe("OpenAI fast mode", () => {
	test("recognizes native OpenAI providers only", () => {
		expect(isOpenAIModel({ provider: "openai" })).toBe(true);
		expect(isOpenAIModel({ provider: "openai-codex" })).toBe(true);
		expect(isOpenAIModel({ provider: "openrouter", api: "openai-responses" })).toBe(false);
		expect(isOpenAIModel({ provider: "azure-openai-responses" })).toBe(false);
		expect(isOpenAIModel(undefined)).toBe(false);
	});

	test("identifies Luna only on native OpenAI models", () => {
		expect(isLunaModel({ provider: "openai-codex", id: "gpt-5.6-luna" })).toBe(true);
		expect(isLunaModel({ provider: "openai", name: "GPT 5.6 Luna" })).toBe(true);
		expect(isLunaModel({ provider: "openai-codex", id: "gpt-5.6-sol" })).toBe(false);
		expect(isLunaModel({ provider: "openrouter", id: "gpt-5.6-luna" })).toBe(false);
		expect(isLunaModel({ provider: "anthropic", id: "claude-luna" })).toBe(false);
	});

	test("adds priority service tier without mutating the original payload", () => {
		const payload = { model: "gpt-5.6-luna" };
		const result = applyFastMode(payload, true) as Record<string, unknown>;

		expect(result).toEqual({ model: "gpt-5.6-luna", service_tier: FAST_MODE_SERVICE_TIER });
		expect(payload).toEqual({ model: "gpt-5.6-luna" });
	});

	test("removes the priority override when disabled", () => {
		const payload = { model: "gpt-5.6-luna", service_tier: FAST_MODE_SERVICE_TIER };
		const result = applyFastMode(payload, false) as Record<string, unknown>;

		expect(result).toEqual({ model: "gpt-5.6-luna" });
		expect(payload.service_tier).toBe(FAST_MODE_SERVICE_TIER);
	});

	test("automatically enforces fast mode for Luna even when manually disabled", async () => {
		const runtime = testRuntime({ provider: "openai-codex", id: "gpt-5.6-luna" });
		fastModeExtension(runtime.pi as never);
		await runtime.handlers.get("session_start")!({}, runtime.ctx);

		expect(runtime.statuses.get("fast-mode")).toBe("⚡ fast (Luna enforced)");
		expect(await requestPayload(runtime, { model: "gpt-5.6-luna", service_tier: "default" })).toEqual({
			model: "gpt-5.6-luna",
			service_tier: FAST_MODE_SERVICE_TIER,
		});

		await runtime.commands.get(FAST_MODE_COMMAND)!.handler("off", runtime.ctx);
		expect(runtime.statuses.get("fast-mode")).toBe("⚡ fast (Luna enforced)");
		expect(runtime.notifications.at(-1)).toContain("always uses fast mode");
		expect(await requestPayload(runtime, { model: "gpt-5.6-luna" })).toHaveProperty(
			"service_tier",
			FAST_MODE_SERVICE_TIER,
		);
	});

	test("toggles request rewriting and exposes the command and shortcut", async () => {
		const runtime = testRuntime();
		fastModeExtension(runtime.pi as never);
		await runtime.handlers.get("session_start")!({}, runtime.ctx);

		expect(runtime.commands.has(FAST_MODE_COMMAND)).toBe(true);
		expect(runtime.commands.has(FAST_MODE_ALIAS)).toBe(true);
		expect(runtime.shortcuts.has(FAST_MODE_SHORTCUT)).toBe(true);
		expect(await requestPayload(runtime, { model: "gpt-5.6-luna" })).toEqual({ model: "gpt-5.6-luna" });

		await runtime.shortcuts.get(FAST_MODE_SHORTCUT)!.handler(runtime.ctx);
		expect(runtime.statuses.get("fast-mode")).toBe("⚡ fast");
		expect(runtime.notifications.at(-1)).toContain("enabled");
		expect(await requestPayload(runtime, { model: "gpt-5.6-luna" })).toEqual({
			model: "gpt-5.6-luna",
			service_tier: FAST_MODE_SERVICE_TIER,
		});

		await runtime.commands.get(FAST_MODE_COMMAND)!.handler("off", runtime.ctx);
		expect(runtime.statuses.get("fast-mode")).toBeUndefined();
		expect(await requestPayload(runtime, { model: "gpt-5.6-luna" })).toEqual({ model: "gpt-5.6-luna" });
	});

	test("does not rewrite non-OpenAI requests", async () => {
		const runtime = testRuntime({ provider: "anthropic", id: "claude" });
		fastModeExtension(runtime.pi as never);
		await runtime.handlers.get("session_start")!({}, runtime.ctx);
		await runtime.commands.get(FAST_MODE_COMMAND)!.handler("on", runtime.ctx);

		const payload = { model: "claude", service_tier: "default" };
		expect(await requestPayload(runtime, payload)).toBe(payload);
		expect(runtime.statuses.get("fast-mode")).toBe("⚡ fast (OpenAI only)");
	});

	test("resets the toggle when a session starts", async () => {
		const runtime = testRuntime();
		fastModeExtension(runtime.pi as never);
		await runtime.handlers.get("session_start")!({}, runtime.ctx);
		await runtime.commands.get(FAST_MODE_COMMAND)!.handler("on", runtime.ctx);
		expect(await requestPayload(runtime, { model: "gpt-5.6-luna" })).toHaveProperty(
			"service_tier",
			FAST_MODE_SERVICE_TIER,
		);

		await runtime.handlers.get("session_start")!({}, runtime.ctx);
		expect(await requestPayload(runtime, { model: "gpt-5.6-luna" })).toEqual({ model: "gpt-5.6-luna" });
	});
});
