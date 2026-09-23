/**
 * Wiring smoke tests for the subagents extension registration: tools, commands,
 * the session preference restore, and the delegation prompt. These run without
 * a TUI by driving the registered handlers with fakes.
 * Run with: bun test agent/tests/subagent-wiring.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import subagentsExtension from "../extensions/subagents/index.ts";
import {
	SUBAGENT_PREFERENCE_ENTRY_TYPE,
	getSessionPreference,
	setSessionPreference,
} from "../extensions/subagents/preference.ts";

interface RegisteredTool {
	name: string;
	executionMode?: string;
	parameters?: { properties?: Record<string, unknown> };
	execute?: (...args: unknown[]) => Promise<unknown>;
}

interface FakePi {
	tools: Map<string, RegisteredTool>;
	commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	entries: Array<{ customType: string; data: unknown }>;
	messages: Array<{ message: unknown; options?: unknown }>;
	api: unknown;
}

function fakePi(): FakePi {
	const state: FakePi = {
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		entries: [],
		messages: [],
		api: undefined,
	};
	state.api = {
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => state.handlers.set(event, handler),
		registerTool: (definition: RegisteredTool) => state.tools.set(definition.name, definition),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) =>
			state.commands.set(name, options),
		appendEntry: (customType: string, data: unknown) => state.entries.push({ customType, data }),
		sendMessage: (message: unknown, options?: unknown) => state.messages.push({ message, options }),
		events: { emit: () => {} },
	};
	return state;
}

function toolThenHangProvider() {
	let calls = 0;
	return {
		streamSimple: async () => {
			if (calls++ > 0) return new Promise<never>(() => {});
			const message = {
				role: "assistant",
				content: [
					{ type: "text", text: "I found the live path." },
					{ type: "toolCall", id: "live-history-call", name: "bash", arguments: { command: "printf live-history-output" } },
				],
				api: "openai-completions",
				provider: "test",
				model: "model",
				usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const stream = (async function* () {
				yield { type: "start", partial: message };
				yield { type: "done", reason: "toolUse", message };
			})();
			(stream as any).result = () => message;
			return stream;
		},
	};
}

const interactiveUi = {
	select: async (title: string, options: string[]) => {
		if (title.startsWith("Which model")) return options[0]!;
		return options[0]!;
	},
	input: async () => undefined,
	confirm: async () => false,
	notify: () => {},
};

beforeEach(() => setSessionPreference(undefined));
afterEach(() => setSessionPreference(undefined));

describe("subagents extension wiring", () => {
	test("registers the subagent tools and user commands", () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);

		expect([...pi.tools.keys()].sort()).toEqual([
			"subagent",
			"subagent_cancel",
			"subagent_history",
			"subagent_status",
		]);
		expect(pi.tools.get("subagent")!.executionMode).toBe("sequential");
		expect([...pi.commands.keys()].sort()).toEqual(["subagent-model", "subagents"]);
	});

	test("always launches without a wait tool or background opt-in", () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);

		expect(pi.tools.has("subagent_wait")).toBe(false);
		expect(pi.tools.get("subagent")!.parameters?.properties?.background).toBeUndefined();
	});

	test("lets the main agent retrieve persisted subagent transcripts", async () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const storedRun = {
			runId: "run-history-1",
			groupId: "group-history-1",
			kind: "single",
			name: "worker",
			model: "test/model",
			task: "inspect the timeout implementation",
			status: "ok",
			startTime: Date.now() - 1_000,
			endTime: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			activities: [],
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "Verified: abort settlement is bounded." }] },
			],
		};
		const result = (await pi.tools.get("subagent_history")!.execute!(
			"history-1",
			{ runId: storedRun.runId, includeTranscript: true },
			undefined,
			undefined,
			{
				sessionManager: {
					getEntries: () => [{ type: "custom", customType: "subagent-run-detail", data: storedRun }],
				},
			},
		)) as { content: Array<{ text?: string }>; details: { runIds: string[] } };

		expect(result.details.runIds).toEqual([storedRun.runId]);
		expect(result.content[0]?.text).toContain("inspect the timeout implementation");
		expect(result.content[0]?.text).toContain("Verified: abort settlement is bounded.");
	});

	test("caps large transcript responses with an explicit truncation notice", async () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const storedRun = {
			runId: "run-large-history",
			groupId: "group-large-history",
			kind: "single",
			name: "worker",
			model: "test/model",
			task: "return a large transcript",
			status: "ok",
			startTime: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			activities: [],
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "transcript ".repeat(12_000) }] },
			],
		};
		const result = (await pi.tools.get("subagent_history")!.execute!(
			"history-large",
			{ runId: storedRun.runId, includeTranscript: true },
			undefined,
			undefined,
			{ sessionManager: { getEntries: () => [{ type: "custom", customType: "subagent-run-detail", data: storedRun }] } },
		)) as { content: Array<{ text?: string }> };
		const text = result.content[0]?.text ?? "";

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(text).toContain("history output truncated at 50 KiB");
	});

	test("returns a clear error for unknown run transcripts", async () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const result = (await pi.tools.get("subagent_history")!.execute!(
			"history-missing",
			{ runId: "does-not-exist" },
			undefined,
			undefined,
			{ sessionManager: { getEntries: () => [] } },
		)) as { content: Array<{ text?: string }>; isError?: boolean };

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("No subagent run found");
	});

	test("returns before the inline subagent finishes", async () => {
		setSessionPreference({ model: "test/model", thinking: "off" });
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const tool = pi.tools.get("subagent")!;

		const result = (await tool.execute!(
			"call-1",
			{ task: "this must run after the launch acknowledgement" },
			new AbortController().signal,
			undefined,
			{
				cwd: process.cwd(),
				hasUI: false,
				ui: {},
				sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
				modelRegistry: {
					getAvailable: () => [
						{ provider: "test", id: "model", name: "Test", contextWindow: 1024, maxTokens: 1024 },
					],
					getProvider: () => undefined,
					getApiKeyForProvider: async () => undefined,
				},
			},
		)) as { content: Array<{ type: string; text?: string }> };

		expect(result.content[0]?.text).toContain("Started non-blocking single group");
		expect(result.content[0]?.text).toContain("completed group result will be interjected automatically");
	});

	test("lets the main agent inspect and cancel a live subagent by runId", async () => {
		setSessionPreference({ model: "test/model", thinking: "off" });
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const hangingProvider = toolThenHangProvider();
		const context = {
			cwd: process.cwd(),
			hasUI: false,
			ui: {},
			sessionManager: {
				getSessionId: () => "cancel-test-session",
				getEntries: () => pi.entries.map((entry) => ({ type: "custom", ...entry })),
			},
			modelRegistry: {
				getAvailable: () => [
					{ provider: "test", id: "model", name: "Test", contextWindow: 1024, maxTokens: 1024 },
				],
				getProvider: () => hangingProvider,
				getApiKeyForProvider: async () => undefined,
			},
		};
		const launched = (await pi.tools.get("subagent")!.execute!(
			"launch-to-cancel",
			{ task: "remain active until canceled" },
			new AbortController().signal,
			undefined,
			context,
		)) as { content: Array<{ text?: string }> };
		const groupId = launched.content[0]?.text?.match(/group ([^ ]+)/)?.[1];
		expect(groupId).toBeTruthy();

		let statusText = "";
		for (let attempt = 0; attempt < 30 && !statusText.includes("runId "); attempt++) {
			const status = (await pi.tools.get("subagent_status")!.execute!("status", { groupId }, undefined, undefined, context)) as {
				content: Array<{ text?: string }>;
			};
			statusText = status.content[0]?.text ?? "";
			if (!statusText.includes("runId ")) await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const runId = statusText.match(/runId ([a-f0-9-]+)/)?.[1];
		expect(runId).toBeTruthy();

		let transcript = "";
		for (let attempt = 0; attempt < 40 && !transcript.includes("live-history-output"); attempt++) {
			const history = (await pi.tools.get("subagent_history")!.execute!(
				"live-history",
				{ runId, includeTranscript: true },
				undefined,
				undefined,
				context,
			)) as { content: Array<{ text?: string }> };
			transcript = history.content[0]?.text ?? "";
			if (!transcript.includes("live-history-output")) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(transcript).toContain("Live activity");
		expect(transcript).toContain("I found the live path.");
		expect(transcript).toContain("live-history-output");

		const cancel = pi.tools.get("subagent_cancel")!;
		const canceled = (await cancel.execute!("cancel-run", { runId }, undefined, undefined, context)) as {
			content: Array<{ text?: string }>;
		};
		expect(canceled.content[0]?.text).toContain(`Cancellation requested for run ${runId}`);
		const repeated = (await cancel.execute!("cancel-run-again", { runId }, undefined, undefined, context)) as {
			content: Array<{ text?: string }>;
		};
		expect(repeated.content[0]?.text).toContain("already requested");

		for (let attempt = 0; attempt < 80 && !pi.entries.some((entry) => entry.customType === "subagent-run-detail"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const detail = pi.entries.find((entry) => entry.customType === "subagent-run-detail")?.data as
			| { stopReason?: string; status?: string; errorMessage?: string }
			| undefined;
		expect(detail?.status).toBe("error");
		expect(detail?.stopReason).toBe("aborted");
		expect(detail?.errorMessage).toContain("did not settle");
	});

	test("group cancellation stops a chain before starting its next step", async () => {
		setSessionPreference({ model: "test/model", thinking: "off" });
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const context = {
			cwd: process.cwd(),
			hasUI: false,
			ui: {},
			sessionManager: {
				getSessionId: () => "cancel-chain-session",
				getEntries: () => pi.entries.map((entry) => ({ type: "custom", ...entry })),
			},
			modelRegistry: {
				getAvailable: () => [
					{ provider: "test", id: "model", name: "Test", contextWindow: 1024, maxTokens: 1024 },
				],
				getProvider: () => ({ streamSimple: () => new Promise<never>(() => {}) }),
				getApiKeyForProvider: async () => undefined,
			},
		};
		const launched = (await pi.tools.get("subagent")!.execute!(
			"launch-chain",
			{ chain: [{ task: "stay active until group cancellation" }, { task: "must not start after cancellation" }], onFailure: "continue" },
			new AbortController().signal,
			undefined,
			context,
		)) as { content: Array<{ text?: string }> };
		const groupId = launched.content[0]?.text?.match(/group ([^ ]+)/)?.[1];
		expect(groupId).toBeTruthy();

		let statusText = "";
		for (let attempt = 0; attempt < 30 && !statusText.includes("runId "); attempt++) {
			const status = (await pi.tools.get("subagent_status")!.execute!("status-chain", { groupId }, undefined, undefined, context)) as {
				content: Array<{ text?: string }>;
			};
			statusText = status.content[0]?.text ?? "";
			if (!statusText.includes("runId ")) await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(statusText).toContain("runId ");

		const cancel = pi.tools.get("subagent_cancel")!;
		const canceled = (await cancel.execute!("cancel-group", { groupId }, undefined, undefined, context)) as {
			content: Array<{ text?: string }>;
		};
		expect(canceled.content[0]?.text).toContain("queued work will not start");
		const repeated = (await cancel.execute!("cancel-group-again", { groupId }, undefined, undefined, context)) as {
			content: Array<{ text?: string }>;
		};
		expect(repeated.content[0]?.text).toContain("already requested");

		for (let attempt = 0; attempt < 80 && !pi.entries.some((entry) => entry.customType === "subagent-run-detail"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(pi.entries.filter((entry) => entry.customType === "subagent-run-detail")).toHaveLength(1);
	});

	test("rejects ambiguous and unknown subagent cancellation requests", async () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const cancel = pi.tools.get("subagent_cancel")!;
		const ctx = { sessionManager: { getEntries: () => [] } };
		const both = (await cancel.execute!("cancel-both", { runId: "r", groupId: "g" }, undefined, undefined, ctx)) as {
			isError?: boolean;
		};
		const missing = (await cancel.execute!("cancel-missing", { groupId: "unknown" }, undefined, undefined, ctx)) as {
			isError?: boolean;
		};
		expect(both.isError).toBe(true);
		expect(missing.isError).toBe(true);
	});

	test("interjects a completion message when a detached group finishes", async () => {
		setSessionPreference({ model: "missing/model", thinking: "off" });
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const tool = pi.tools.get("subagent")!;

		const launch = (await tool.execute!(
			"call-completion",
			{ task: "finish this in the background" },
			new AbortController().signal,
			undefined,
			{
				cwd: process.cwd(),
				hasUI: false,
				ui: {},
				sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
				modelRegistry: { getAvailable: () => [] },
			},
		)) as { content: Array<{ type: string; text?: string }> };

		const groupId = launch.content[0]?.text?.match(/group ([^ ]+)/)?.[1];
		expect(groupId).toBeTruthy();
		for (let attempt = 0; attempt < 20 && pi.messages.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		expect(pi.messages).toHaveLength(1);
		const sent = pi.messages[0]!;
		expect(sent.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(sent.message).toMatchObject({
			customType: "subagent-completion",
			display: true,
		});
		expect((sent.message as { content: string }).content).toContain(`group ${groupId} failed`);
	});

	test("does not interject a stale group after a session switch", async () => {
		setSessionPreference({ model: "missing/model", thinking: "off" });
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const tool = pi.tools.get("subagent")!;

		await tool.execute!(
			"call-stale-completion",
			{ task: "finish after the session changes" },
			new AbortController().signal,
			undefined,
			{
				cwd: process.cwd(),
				hasUI: false,
				ui: {},
				sessionManager: { getSessionId: () => "old-session", getEntries: () => [] },
				modelRegistry: { getAvailable: () => [] },
			},
		);

		pi.handlers.get("session_shutdown")!({}, {});
		pi.handlers.get("session_start")!({}, { sessionManager: { getBranch: () => [] } });
		for (let attempt = 0; attempt < 20; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));

		expect(pi.messages).toHaveLength(0);
	});

	test("retires prior-session groups and does not persist their late runs", async () => {
		setSessionPreference({ model: "test/model", thinking: "off" });
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const tool = pi.tools.get("subagent")!;
		const startSession = pi.handlers.get("session_start")!;
		let switched = false;
		await tool.execute!("call-retired", { task: "must not persist after session replacement" }, new AbortController().signal, undefined, {
			cwd: process.cwd(),
			hasUI: false,
			ui: {},
			sessionManager: { getSessionId: () => "old-session", getEntries: () => [] },
			modelRegistry: {
				getAvailable: () => [{ provider: "test", id: "model", name: "Test", contextWindow: 1024, maxTokens: 1024 }],
				getProvider: () => {
					if (!switched) {
						switched = true;
						startSession({}, { sessionManager: { getBranch: () => [] } });
					}
					return undefined;
				},
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(pi.entries.filter((entry) => entry.customType.startsWith("subagent-run"))).toHaveLength(0);
		const status = await pi.tools.get("subagent_status")!.execute!("status", {}, undefined, undefined, {});
		expect(status).toMatchObject({ content: [{ text: "No background subagent groups have been started in this session." }] });
	});

	test("ignores a model choice when the session changes during its final dialog", async () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const shutdown = pi.handlers.get("session_shutdown")!;
		const start = pi.handlers.get("session_start")!;
		const notices: string[] = [];
		const command = pi.commands.get("subagent-model")!;
		await command.handler("select worker", {
			hasUI: true,
			ui: {
				select: async (_title: string, options: string[]) => options[0]!,
				input: async () => undefined,
				confirm: async () => {
					shutdown({}, {});
					start({}, { sessionManager: { getBranch: () => [] } });
					return false;
				},
				notify: (message: string) => notices.push(message),
			},
			modelRegistry: {
				getAvailable: () => [{ provider: "test", id: "model", name: "Test", reasoning: true }],
				hasConfiguredAuth: () => true,
			},
		});

		expect(getSessionPreference("worker")).toBeUndefined();
		expect(pi.entries).toHaveLength(0);
		expect(notices).toHaveLength(0);
	});

	test("cancels a launch that crosses a session switch during setup", async () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const shutdown = pi.handlers.get("session_shutdown")!;
		const start = pi.handlers.get("session_start")!;
		let selections = 0;
		const result = (await pi.tools.get("subagent")!.execute!(
			"call-preflight-race",
			{ task: "must not launch across a session switch" },
			new AbortController().signal,
			undefined,
			{
				cwd: process.cwd(),
				hasUI: true,
				ui: {
					select: async (_title: string, options: string[]) => {
						if (selections++ === 0) {
							shutdown({}, {});
							start({}, { sessionManager: { getBranch: () => [] } });
						}
						return options[0];
					},
					input: async () => undefined,
					confirm: async () => false,
				},
				modelRegistry: {
					getAvailable: () => [
						{ provider: "test", id: "model", name: "Test", contextWindow: 1024, maxTokens: 1024 },
					],
					hasConfiguredAuth: () => true,
				},
			},
		)) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("session changed during setup");
		expect(pi.messages).toHaveLength(0);
	});

	test("restores the session preference on session start", () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);

		const handler = pi.handlers.get("session_start")!;
		handler({}, { sessionManager: { getBranch: () => [{ type: "custom", customType: SUBAGENT_PREFERENCE_ENTRY_TYPE, data: { model: "saved/model", thinking: "high" } }] } });
		expect(getSessionPreference()).toEqual({ model: "saved/model", thinking: "high" });
	});

	test("injects a delegation prompt that reflects the user's choice", () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const handler = pi.handlers.get("before_agent_start")!;

		const before = handler({ systemPrompt: "BASE" }, {}) as { systemPrompt: string };
		expect(before.systemPrompt).toContain("[SUBAGENT DELEGATION]");
		expect(before.systemPrompt).toContain("first launch of each session");
		expect(before.systemPrompt).toContain("Every subagent launch is non-blocking");
		expect(before.systemPrompt).toContain("Do not duplicate work assigned to a running subagent");
		expect(before.systemPrompt).toContain("use the subagent's completion result instead of recreating its work");
		expect(before.systemPrompt).toContain("automatically interject their capped result");

		setSessionPreference({ model: "openai-codex/gpt-5.6-luna", thinking: "medium" });
		const after = handler({ systemPrompt: "BASE" }, {}) as { systemPrompt: string };
		expect(after.systemPrompt).toContain("openai-codex/gpt-5.6-luna · medium thinking");
		expect(after.systemPrompt).toContain("subagent_history");
		expect(after.systemPrompt).toContain("subagent_cancel");
	});

	test("/subagent-model status and select wire into the preference", async () => {
		const pi = fakePi();
		(subagentsExtension as (api: unknown) => void)(pi.api);
		const command = pi.commands.get("subagent-model")!;

		const notices: string[] = [];
		const statusCtx = {
			hasUI: true,
			ui: { ...interactiveUi, notify: (message: string) => notices.push(message) },
		};
		await command.handler("status", statusCtx);
		expect(notices.join("\n")).toContain("Session: not chosen yet");

		let offered: string[] = [];
		const selectCtx = {
			hasUI: true,
			ui: {
				...interactiveUi,
				select: async (title: string, options: string[]) => {
					if (title.startsWith("Which model")) offered = options;
					return options[0]!;
				},
				notify: (message: string) => notices.push(message),
			},
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna", contextWindow: 200_000, cost: { input: 1, output: 8 } },
					{ provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", contextWindow: 400_000, cost: { input: 2, output: 16 } },
				],
				hasConfiguredAuth: () => true,
			},
			scopedModels: [
				{ model: { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna", contextWindow: 200_000, cost: { input: 1, output: 8 } } },
			],
		};
		await command.handler("", selectCtx);
		expect(offered.some((option) => option.includes("gpt-5.6-luna"))).toBe(true);
		expect(offered.some((option) => option.includes("gpt-5.6-sol"))).toBe(false);
		expect(getSessionPreference()).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "auto" });
		expect(pi.entries.at(-1)?.customType).toBe(SUBAGENT_PREFERENCE_ENTRY_TYPE);

		await command.handler("select worker", selectCtx);
		expect(getSessionPreference("worker")).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "auto" });
		expect(getSessionPreference("scout")).toBeUndefined();
		expect(pi.entries.at(-1)?.data).toMatchObject({ subagentType: "worker" });

		await command.handler("reviewer", selectCtx);
		expect(getSessionPreference("reviewer")).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "auto" });
		expect(pi.entries.at(-1)?.data).toMatchObject({ subagentType: "reviewer" });
	});
});
