/**
 * User-owned subagent model preference.
 *
 * The model and thinking level used by subagents belong to the user, not the
 * agent that launches them. The first subagent launch in a session asks for
 * both, remembers the answer for the rest of the session, and offers to save
 * it for future sessions. Either field can be set to "auto", which defers to
 * the agent file or the caller's per-task request.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Session entry type used to restore the choice when a session is reopened. */
export const SUBAGENT_PREFERENCE_ENTRY_TYPE = "subagent-model-preference";
/** Sentinel meaning "defer to the agent file or the caller's request". */
export const AUTO_VALUE = "auto";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SubagentThinking = (typeof THINKING_LEVELS)[number];
export type SubagentThinkingChoice = SubagentThinking | typeof AUTO_VALUE;

export interface SubagentPreference {
	/** `provider/id`, or `auto` to defer to the agent file / task request. */
	model: string;
	/** A concrete thinking level, or `auto` to defer. */
	thinking: SubagentThinkingChoice;
}

const AUTO_MODEL_OPTION = "Let the agent choose per task";
const OTHER_MODEL_OPTION = "Other (type provider/id)";
const AUTO_THINKING_OPTION = "auto — use each agent's default";
const MAX_MODEL_CHOICES = 25;

const THINKING_DESCRIPTIONS: Record<SubagentThinking, string> = {
	off: "no reasoning (cheapest)",
	minimal: "very light reasoning",
	low: "light reasoning",
	medium: "balanced reasoning",
	high: "heavy reasoning",
	xhigh: "very heavy reasoning",
	max: "maximum reasoning",
};

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type SharedPreferenceState = { current?: SubagentPreference };

// Extensions are loaded through jiti with module caching disabled, so keep the
// live session choice on the process global to guarantee one source of truth.
const PREFERENCE_STATE_KEY = Symbol.for("pi.subagents.preference");
const globalState = globalThis as typeof globalThis & {
	[PREFERENCE_STATE_KEY]?: SharedPreferenceState;
};
const preferenceState = globalState[PREFERENCE_STATE_KEY] ?? (globalState[PREFERENCE_STATE_KEY] = {});

export function getSessionPreference(): SubagentPreference | undefined {
	return preferenceState.current;
}

export function setSessionPreference(preference: SubagentPreference | undefined): void {
	preferenceState.current = preference;
}

// ---------------------------------------------------------------------------
// Parsing and persistence
// ---------------------------------------------------------------------------

function isThinkingChoice(value: unknown): value is SubagentThinkingChoice {
	return value === AUTO_VALUE || (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value));
}

export function parsePreference(value: unknown): SubagentPreference | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { model, thinking } = value as { model?: unknown; thinking?: unknown };
	if (typeof model !== "string" || model.trim() === "") return undefined;
	if (!isThinkingChoice(thinking)) return undefined;
	return { model: model.trim(), thinking };
}

/** Restore the most recent preference recorded in this session branch. */
export function restoredPreference(entries: readonly unknown[]): SubagentPreference | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (!entry || entry.type !== "custom" || entry.customType !== SUBAGENT_PREFERENCE_ENTRY_TYPE) continue;
		const parsed = parsePreference(entry.data);
		if (parsed) return parsed;
	}
	return undefined;
}

export function preferencePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "subagent-model.json");
}

export async function loadGlobalPreference(path: string = preferencePath()): Promise<SubagentPreference | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return parsePreference(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

export async function saveGlobalPreference(
	preference: SubagentPreference,
	path: string = preferencePath(),
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let moved = false;
	try {
		await writeFile(temporary, `${JSON.stringify({ version: 1, ...preference }, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, path);
		moved = true;
	} finally {
		if (!moved) await unlink(temporary).catch(() => undefined);
	}
}

/** Remove the saved global choice so the next session asks again. */
export async function clearGlobalPreference(path: string = preferencePath()): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

// ---------------------------------------------------------------------------
// Applying the preference
// ---------------------------------------------------------------------------

/** Override model/thinking from the user's choice, leaving other controls alone. */
export function applyPreference<T extends { model?: string; thinking?: string }>(
	controls: T,
	preference: SubagentPreference | undefined,
): T {
	if (!preference) return controls;
	return {
		...controls,
		model: preference.model === AUTO_VALUE ? controls.model : preference.model,
		thinking: preference.thinking === AUTO_VALUE ? controls.thinking : preference.thinking,
	};
}

export function describePreference(preference: SubagentPreference): string {
	const model = preference.model === AUTO_VALUE ? "agent-chosen model" : preference.model;
	const thinking = preference.thinking === AUTO_VALUE ? "agent default thinking" : `${preference.thinking} thinking`;
	return `${model} · ${thinking}`;
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

export interface SubagentModelInfo {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	cost?: { input?: number; output?: number };
}

export interface ModelChoice {
	value: string;
	label: string;
	description: string;
}

function costText(cost: SubagentModelInfo["cost"]): string | undefined {
	if (!cost || (cost.input === undefined && cost.output === undefined)) return undefined;
	const input = cost.input ?? 0;
	const output = cost.output ?? 0;
	if (input === 0 && output === 0) return "free";
	return `$${input}/$${output} per M tok`;
}

export function buildModelChoices(
	models: readonly SubagentModelInfo[],
	limit = MAX_MODEL_CHOICES,
): ModelChoice[] {
	const seen = new Set<string>();
	const choices: ModelChoice[] = [];
	for (const model of models) {
		const value = `${model.provider}/${model.id}`;
		if (seen.has(value)) continue;
		seen.add(value);
		const details: string[] = [];
		if (model.name && model.name !== model.id) details.push(model.name);
		if (model.contextWindow) details.push(`${Math.round(model.contextWindow / 1024)}k ctx`);
		const cost = costText(model.cost);
		if (cost) details.push(cost);
		choices.push({ value, label: value, description: details.join(" · ") || "model" });
	}
	choices.sort((a, b) => a.value.localeCompare(b.value));
	return choices.slice(0, limit);
}

export interface PreferencePromptResult {
	preference?: SubagentPreference;
	/** The user asked to remember the choice for future sessions. */
	persistGlobally: boolean;
	cancelled: boolean;
}

/** Dialogs needed to ask for the preference; kept narrow so tests can fake them. */
export interface PreferenceDialogContext {
	hasUI: boolean;
	ui: Pick<ExtensionContext["ui"], "select" | "input" | "confirm">;
	modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable" | "hasConfiguredAuth">;
}

export async function promptForPreference(ctx: PreferenceDialogContext): Promise<PreferencePromptResult> {
	const choices = buildModelChoices(
		ctx.modelRegistry.getAvailable().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model)),
	);
	if (choices.length === 0) return { persistGlobally: false, cancelled: true };

	const modelOptions = [
		...choices.map((choice) => `${choice.label} — ${choice.description}`),
		AUTO_MODEL_OPTION,
		OTHER_MODEL_OPTION,
	];
	const selected = await ctx.ui.select("Which model should subagents use?", modelOptions);
	if (selected === undefined) return { persistGlobally: false, cancelled: true };

	let model: string | undefined;
	if (selected === AUTO_MODEL_OPTION) {
		model = AUTO_VALUE;
	} else if (selected === OTHER_MODEL_OPTION) {
		const custom = await ctx.ui.input("Subagent model", "provider/id");
		if (custom === undefined || custom.trim() === "") return { persistGlobally: false, cancelled: true };
		model = custom.trim();
	} else {
		const match = choices.find((choice) => selected === `${choice.label} — ${choice.description}`);
		if (!match) return { persistGlobally: false, cancelled: true };
		model = match.value;
	}

	const thinkingOptions = [AUTO_THINKING_OPTION, ...THINKING_LEVELS.map((level) => `${level} — ${THINKING_DESCRIPTIONS[level]}`)];
	const thinkingSelected = await ctx.ui.select("Which thinking level should subagents use?", thinkingOptions);
	if (thinkingSelected === undefined) return { persistGlobally: false, cancelled: true };
	const thinking: SubagentThinkingChoice =
		thinkingSelected === AUTO_THINKING_OPTION
			? AUTO_VALUE
			: (THINKING_LEVELS.find((level) => thinkingSelected.startsWith(`${level} —`)) ?? AUTO_VALUE);

	const persistGlobally = await ctx.ui.confirm(
		"Remember this subagent choice?",
		`${describePreference({ model, thinking })}\n\nIt is remembered for this session. Save it for future sessions too?`,
	);

	return { preference: { model, thinking }, persistGlobally, cancelled: false };
}

export type PreferenceSource = "session" | "global" | "prompted" | "unavailable" | "cancelled";

export interface PreferenceResolution {
	source: PreferenceSource;
	preference?: SubagentPreference;
}

export interface ResolvePreferenceOptions {
	/** Override the global lookup (tests). */
	loadGlobal?: () => Promise<SubagentPreference | undefined>;
	/** Override the global save (tests). Defaults to the preference file. */
	saveGlobal?: (preference: SubagentPreference) => Promise<void>;
	/** Override the interactive prompt (tests). */
	prompt?: (ctx: PreferenceDialogContext) => Promise<PreferencePromptResult>;
}

/**
 * Resolve the subagent preference for this launch: session choice first, then
 * the saved global choice, then ask the user. Returns `cancelled` when the user
 * aborts the prompt so the caller can stop instead of guessing a model.
 */
export async function resolvePreference(
	ctx: PreferenceDialogContext,
	options: ResolvePreferenceOptions = {},
): Promise<PreferenceResolution> {
	const session = getSessionPreference();
	if (session) return { source: "session", preference: session };

	const loadGlobal = options.loadGlobal ?? (() => loadGlobalPreference());
	const global = await loadGlobal();
	if (global) {
		setSessionPreference(global);
		return { source: "global", preference: global };
	}

	if (!ctx.hasUI) return { source: "unavailable" };

	const prompt = options.prompt ?? promptForPreference;
	const result = await prompt(ctx);
	if (result.cancelled || !result.preference) return { source: "cancelled" };

	if (result.persistGlobally) {
		const saveGlobal = options.saveGlobal ?? ((preference: SubagentPreference) => saveGlobalPreference(preference));
		await saveGlobal(result.preference);
	}
	setSessionPreference(result.preference);
	return { source: "prompted", preference: result.preference };
}
