/**
 * Deterministic tests for the user-owned subagent model preference.
 * Run with: bun test agent/tests/preference.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SUBAGENT_PREFERENCE_ENTRY_TYPE,
	applyPreference,
	buildModelChoices,
	clearGlobalPreference,
	describePreference,
	loadGlobalPreference,
	parsePreference,
	promptForPreference,
	resolvePreference,
	restoredPreference,
	saveGlobalPreference,
	setSessionPreference,
	type PreferenceDialogContext,
} from "../extensions/subagents/preference.ts";

const luna = {
	provider: "openai-codex",
	id: "gpt-5.6-luna",
	name: "Luna",
	contextWindow: 200_000,
	cost: { input: 1, output: 8 },
};
const sol = {
	provider: "openai-codex",
	id: "gpt-5.6-sol",
	name: "Sol",
	contextWindow: 400_000,
	cost: { input: 2, output: 16 },
};

function ctx(overrides: Partial<PreferenceDialogContext> = {}): PreferenceDialogContext {
	return {
		hasUI: true,
		ui: {
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => false,
		},
		modelRegistry: {
			getAvailable: () => [sol, luna],
			hasConfiguredAuth: () => true,
		},
		...overrides,
	} as PreferenceDialogContext;
}

/**
 * Build a select stub that answers the model and thinking dialogs separately.
 * `model`/`thinking` receive the offered options and return the chosen string.
 */
function selecting(
	model: (options: string[]) => string,
	thinking: (options: string[]) => string = (options) => options.find((option) => option.startsWith("auto —"))!,
) {
	return async (title: string, options: string[]) =>
		title.startsWith("Which model") ? model(options) : thinking(options);
}

function modelOption(model: Parameters<typeof buildModelChoices>[0][number]): string {
	const choice = buildModelChoices([model])[0]!;
	return `${choice.label} — ${choice.description}`;
}

beforeEach(() => setSessionPreference(undefined));
afterEach(() => setSessionPreference(undefined));

describe("preference parsing and restoration", () => {
	test("accepts concrete and auto choices and rejects malformed values", () => {
		expect(parsePreference({ model: "openai-codex/gpt-5.6-luna", thinking: "medium" })).toEqual({
			model: "openai-codex/gpt-5.6-luna",
			thinking: "medium",
		});
		expect(parsePreference({ model: "auto", thinking: "auto" })).toEqual({ model: "auto", thinking: "auto" });
		expect(parsePreference({ model: "  spaced/id  ", thinking: "xhigh" })).toEqual({
			model: "spaced/id",
			thinking: "xhigh",
		});
		expect(parsePreference({ model: "", thinking: "low" })).toBeUndefined();
		expect(parsePreference({ model: "id", thinking: "bogus" })).toBeUndefined();
		expect(parsePreference({ thinking: "low" })).toBeUndefined();
		expect(parsePreference(null)).toBeUndefined();
	});

	test("restores the most recent valid session entry", () => {
		expect(
			restoredPreference([
				{ type: "custom", customType: SUBAGENT_PREFERENCE_ENTRY_TYPE, data: { model: "a/b", thinking: "low" } },
				{ type: "message", data: { model: "ignored/x", thinking: "low" } },
				{ type: "custom", customType: SUBAGENT_PREFERENCE_ENTRY_TYPE, data: { model: "c/d", thinking: "high" } },
			]),
		).toEqual({ model: "c/d", thinking: "high" });
		expect(restoredPreference([])).toBeUndefined();
	});
});

describe("applying the preference", () => {
	test("overrides model and thinking while leaving other controls alone", () => {
		expect(
			applyPreference(
				{ model: "agent/default", thinking: "off", tools: ["read"], maxTurns: 5 },
				{ model: "user/pick", thinking: "high" },
			),
		).toEqual({ model: "user/pick", thinking: "high", tools: ["read"], maxTurns: 5 });
	});

	test("auto defers to the agent file or caller request", () => {
		expect(
			applyPreference(
				{ model: "agent/default", thinking: "off" },
				{ model: "auto", thinking: "auto" },
			),
		).toEqual({ model: "agent/default", thinking: "off" });
	});

	test("returns the original controls when no preference is set", () => {
		const controls = { model: "agent/default", thinking: "off" };
		expect(applyPreference(controls, undefined)).toBe(controls);
	});

	test("describes concrete and delegated choices", () => {
		expect(describePreference({ model: "openai-codex/gpt-5.6-luna", thinking: "medium" })).toBe(
			"openai-codex/gpt-5.6-luna · medium thinking",
		);
		expect(describePreference({ model: "auto", thinking: "auto" })).toBe(
			"agent-chosen model · agent default thinking",
		);
	});
});

describe("model choices", () => {
	test("deduplicates, sorts, and describes available models", () => {
		const choices = buildModelChoices([sol, luna, luna]);
		expect(choices.map((choice) => choice.value)).toEqual(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"]);
		expect(choices[0]!.description).toContain("Luna");
		expect(choices[0]!.description).toContain("195k ctx");
		expect(choices[0]!.description).toContain("$1/$8 per M tok");
	});

	test("caps the list and marks free models", () => {
		const many = Array.from({ length: 30 }, (_, index) => ({
			provider: "p",
			id: `m${index}`,
			cost: { input: 0, output: 0 },
		}));
		const choices = buildModelChoices(many);
		expect(choices).toHaveLength(25);
		expect(choices[0]!.description).toBe("free");
	});
});

describe("prompting for the preference", () => {
	test("returns the chosen model, thinking level, and global-save intent", async () => {
		const prompts: string[] = [];
		const result = await promptForPreference(
			ctx({
				ui: {
					select: async (title: string, options: string[]) => {
						prompts.push(title);
						if (title.startsWith("Which model")) return modelOption(luna);
						return options.find((option) => option.startsWith("medium —"))!;
					},
					input: async () => undefined,
					confirm: async () => true,
				},
			}),
		);

		expect(result.cancelled).toBe(false);
		expect(result.preference).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "medium" });
		expect(result.persistGlobally).toBe(true);
		expect(prompts).toEqual(["Which model should subagents use?", "Which thinking level should subagents use?"]);
	});

	test("accepts a typed provider/id and the agent-choice escape hatch", async () => {
		const custom = await promptForPreference(
			ctx({
				ui: {
					select: selecting(() => "Other (type provider/id)"),
					input: async () => "my-provider/my-model",
					confirm: async () => false,
				},
			}),
		);
		expect(custom.preference).toEqual({ model: "my-provider/my-model", thinking: "auto" });
		expect(custom.persistGlobally).toBe(false);

		const auto = await promptForPreference(
			ctx({
				ui: {
					select: selecting((options) => options.find((option) => option.startsWith("Let the agent"))!),
					input: async () => undefined,
					confirm: async () => false,
				},
			}),
		);
		expect(auto.preference).toEqual({ model: "auto", thinking: "auto" });
	});

	test("treats an empty typed model or a cancelled dialog as cancelled", async () => {
		const empty = await promptForPreference(
			ctx({
				ui: {
					select: selecting(() => "Other (type provider/id)"),
					input: async () => "   ",
					confirm: async () => false,
				},
			}),
		);
		expect(empty.cancelled).toBe(true);

		const cancelled = await promptForPreference(ctx());
		expect(cancelled.cancelled).toBe(true);
	});

	test("offers no prompt when no model has configured auth", async () => {
		const result = await promptForPreference(
			ctx({
				modelRegistry: {
					getAvailable: () => [luna],
					hasConfiguredAuth: () => false,
				} as unknown as PreferenceDialogContext["modelRegistry"],
			}),
		);
		expect(result.cancelled).toBe(true);
	});
});

describe("resolving the preference for a launch", () => {
	test("uses the session choice without prompting", async () => {
		setSessionPreference({ model: "openai-codex/gpt-5.6-luna", thinking: "low" });
		let prompted = false;
		const resolution = await resolvePreference(ctx(), {
			prompt: async () => {
				prompted = true;
				return { persistGlobally: false, cancelled: true };
			},
		});
		expect(resolution.source).toBe("session");
		expect(resolution.preference).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "low" });
		expect(prompted).toBe(false);
	});

	test("adopts the saved global choice into the session", async () => {
		const resolution = await resolvePreference(ctx(), {
			loadGlobal: async () => ({ model: "saved/model", thinking: "high" }),
		});
		expect(resolution.source).toBe("global");
		expect(resolution.preference).toEqual({ model: "saved/model", thinking: "high" });
	});

	test("prompts when nothing is set and persists globally on request", async () => {
		const saved: Array<{ model: string; thinking: string }> = [];
		const resolution = await resolvePreference(ctx(), {
			loadGlobal: async () => undefined,
			saveGlobal: async (preference) => {
				saved.push({ ...preference });
			},
			prompt: async () => ({
				preference: { model: "chosen/model", thinking: "medium" },
				persistGlobally: true,
				cancelled: false,
			}),
		});
		expect(resolution.source).toBe("prompted");
		expect(resolution.preference).toEqual({ model: "chosen/model", thinking: "medium" });
		expect(saved).toEqual([{ model: "chosen/model", thinking: "medium" }]);
	});

	test("reports unavailable without a UI and cancelled when the user aborts", async () => {
		expect((await resolvePreference(ctx({ hasUI: false }))).source).toBe("unavailable");
		const cancelled = await resolvePreference(ctx(), {
			loadGlobal: async () => undefined,
			prompt: async () => ({ persistGlobally: false, cancelled: true }),
		});
		expect(cancelled.source).toBe("cancelled");
		expect(cancelled.preference).toBeUndefined();
	});
});

describe("global preference storage", () => {
	test("round-trips through the preference file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-subagent-pref-"));
		const path = join(dir, "subagent-model.json");
		try {
			expect(await loadGlobalPreference(path)).toBeUndefined();
			await saveGlobalPreference({ model: "openai-codex/gpt-5.6-sol", thinking: "medium" }, path);
			expect(await loadGlobalPreference(path)).toEqual({
				model: "openai-codex/gpt-5.6-sol",
				thinking: "medium",
			});
			const raw = JSON.parse(await readFile(path, "utf8"));
			expect(raw.version).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("clearGlobalPreference removes the saved choice and tolerates a missing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-subagent-pref-"));
		const path = join(dir, "subagent-model.json");
		try {
			await saveGlobalPreference({ model: "saved/model", thinking: "low" }, path);
			expect(await loadGlobalPreference(path)).toEqual({ model: "saved/model", thinking: "low" });
			await clearGlobalPreference(path);
			expect(await loadGlobalPreference(path)).toBeUndefined();
			await clearGlobalPreference(path);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
