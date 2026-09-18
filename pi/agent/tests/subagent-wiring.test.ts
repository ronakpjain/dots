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

interface FakePi {
	tools: Map<string, { name: string; executionMode?: string }>;
	commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	entries: Array<{ customType: string; data: unknown }>;
	api: unknown;
}

function fakePi(): FakePi {
	const state: FakePi = {
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		entries: [],
		api: undefined,
	};
	state.api = {
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => state.handlers.set(event, handler),
		registerTool: (definition: { name: string; executionMode?: string }) =>
			state.tools.set(definition.name, definition),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) =>
			state.commands.set(name, options),
		appendEntry: (customType: string, data: unknown) => state.entries.push({ customType, data }),
		events: { emit: () => {} },
	};
	return state;
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

		expect([...pi.tools.keys()].sort()).toEqual(["subagent", "subagent_status", "subagent_wait"]);
		expect(pi.tools.get("subagent")!.executionMode).toBe("sequential");
		expect([...pi.commands.keys()].sort()).toEqual(["subagent-model", "subagents"]);
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

		setSessionPreference({ model: "openai-codex/gpt-5.6-luna", thinking: "medium" });
		const after = handler({ systemPrompt: "BASE" }, {}) as { systemPrompt: string };
		expect(after.systemPrompt).toContain("openai-codex/gpt-5.6-luna · medium thinking");
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
	});
});
