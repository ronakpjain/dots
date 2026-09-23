/**
 * User-owned subagent model preferences.
 *
 * The model and thinking level used by subagents belong to the user, not the
 * agent that launches them. Preferences are keyed by subagent type (the
 * `agent` definition name, or `inline`/`default` for unnamed launches), so a
 * choice for one kind of subagent never silently changes another kind.
 * Either field can be set to "auto", which defers to the agent file or the
 * caller's per-task request.
 */

import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Session entry type used to restore choices when a session is reopened. */
export const SUBAGENT_PREFERENCE_ENTRY_TYPE = "subagent-model-preference";
/** Sentinel meaning "defer to the agent file or the caller's request". */
export const AUTO_VALUE = "auto";
/** Type used for a launch without an agent definition or inline prompt. */
export const DEFAULT_SUBAGENT_TYPE = "default";
/** Type used for a launch with an inline system prompt but no agent definition. */
export const INLINE_SUBAGENT_TYPE = "inline";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SubagentThinking = (typeof THINKING_LEVELS)[number];
export type SubagentThinkingChoice = SubagentThinking | typeof AUTO_VALUE;

export interface SubagentPreference {
	/** `provider/id`, or `auto` to defer to the agent file / task request. */
	model: string;
	/** A concrete thinking level, or `auto` to defer. */
	thinking: SubagentThinkingChoice;
}

export type SubagentPreferenceMap = Record<string, SubagentPreference>;

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

/** Normalize empty type labels to the unnamed-launch bucket. */
export function normalizeSubagentType(subagentType?: string): string {
	const normalized = subagentType?.trim();
	return normalized || DEFAULT_SUBAGENT_TYPE;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type SharedPreferenceState = { current?: SubagentPreferenceMap };

// Extensions are loaded through jiti with module caching disabled, so keep the
// live session choices on the process global to guarantee one source of truth.
const PREFERENCE_STATE_KEY = Symbol.for("pi.subagents.preference");
const globalState = globalThis as typeof globalThis & {
	[PREFERENCE_STATE_KEY]?: SharedPreferenceState;
};
const preferenceState = globalState[PREFERENCE_STATE_KEY] ?? (globalState[PREFERENCE_STATE_KEY] = {});

function currentPreferences(): SubagentPreferenceMap {
	const current = preferenceState.current;
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		preferenceState.current = {};
	} else {
		// A hot-reloaded extension may leave the old untyped preference object on
		// the process global. Migrate it into the unnamed bucket, never a wildcard.
		const legacy = parsePreference(current);
		if (legacy) preferenceState.current = { [DEFAULT_SUBAGENT_TYPE]: legacy };
	}
	return preferenceState.current!;
}

export function getSessionPreferences(): SubagentPreferenceMap {
	return { ...currentPreferences() };
}

export function setSessionPreferences(preferences: SubagentPreferenceMap | undefined): void {
	const next: SubagentPreferenceMap = {};
	for (const [subagentType, preference] of Object.entries(preferences ?? {})) {
		const parsed = parsePreference(preference);
		if (parsed) next[normalizeSubagentType(subagentType)] = parsed;
	}
	preferenceState.current = next;
}

/** Get the choice for one subagent type; no argument reads the unnamed bucket. */
export function getSessionPreference(subagentType?: string): SubagentPreference | undefined {
	return currentPreferences()[normalizeSubagentType(subagentType)];
}

/**
 * Set one typed choice. The one-argument form is retained for compatibility
 * with callers that used the old session-wide preference API; it writes the
 * unnamed bucket. Passing only `undefined` clears every session choice.
 */
export function setSessionPreference(preference: SubagentPreference | undefined): void;
export function setSessionPreference(subagentType: string, preference: SubagentPreference | undefined): void;
export function setSessionPreference(
	subagentTypeOrPreference: string | SubagentPreference | undefined,
	preference?: SubagentPreference,
): void {
	if (typeof subagentTypeOrPreference === "string") {
		const key = normalizeSubagentType(subagentTypeOrPreference);
		if (preference) {
			const parsed = parsePreference(preference);
			if (parsed) currentPreferences()[key] = parsed;
		} else {
			delete currentPreferences()[key];
		}
		return;
	}

	if (subagentTypeOrPreference === undefined) {
		preferenceState.current = {};
		return;
	}

	const parsed = parsePreference(subagentTypeOrPreference);
	if (parsed) currentPreferences()[DEFAULT_SUBAGENT_TYPE] = parsed;
}

// ---------------------------------------------------------------------------
// Parsing and persistence
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isThinkingChoice(value: unknown): value is SubagentThinkingChoice {
	return value === AUTO_VALUE || (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value));
}

export function parsePreference(value: unknown): SubagentPreference | undefined {
	if (!isRecord(value)) return undefined;
	const { model, thinking } = value;
	if (typeof model !== "string" || model.trim() === "") return undefined;
	if (!isThinkingChoice(thinking)) return undefined;
	return { model: model.trim(), thinking };
}

function storedPreference(value: unknown): { subagentType: string; preference: SubagentPreference } | undefined {
	if (!isRecord(value)) return undefined;
	const nested = parsePreference(value.preference);
	const preference = nested ?? parsePreference(value);
	if (!preference) return undefined;
	const type =
		typeof value.subagentType === "string"
			? value.subagentType
			: typeof value.agentType === "string"
				? value.agentType
				: typeof value.agent === "string"
					? value.agent
					: DEFAULT_SUBAGENT_TYPE;
	return { subagentType: normalizeSubagentType(type), preference };
}

/** Restore the latest valid choice for every subagent type in this branch. */
export function restoredPreferences(entries: readonly unknown[]): SubagentPreferenceMap {
	const restored: SubagentPreferenceMap = {};
	for (const rawEntry of entries) {
		const entry = rawEntry as { type?: string; customType?: string; data?: unknown } | undefined;
		if (!entry || entry.type !== "custom" || entry.customType !== SUBAGENT_PREFERENCE_ENTRY_TYPE) continue;
		const parsed = storedPreference(entry.data);
		if (parsed) restored[parsed.subagentType] = parsed.preference;
	}
	return restored;
}

/** Restore the latest valid choice for one type (legacy-compatible helper). */
export function restoredPreference(entries: readonly unknown[], subagentType?: string): SubagentPreference | undefined {
	return restoredPreferences(entries)[normalizeSubagentType(subagentType)];
}

export function preferencePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "subagent-model.json");
}

function parsePreferenceMap(value: unknown): SubagentPreferenceMap | undefined {
	if (!isRecord(value)) return undefined;

	// Version 1 stored one untyped preference at the top level. Keep it only in
	// the unnamed bucket; never use it as a wildcard for named subagent types.
	const legacy = parsePreference(value);
	if (legacy) return { [DEFAULT_SUBAGENT_TYPE]: legacy };

	const rawPreferences = isRecord(value.preferences) ? value.preferences : value;
	const preferences: SubagentPreferenceMap = {};
	for (const [subagentType, rawPreference] of Object.entries(rawPreferences)) {
		const preference = parsePreference(rawPreference);
		if (preference) preferences[normalizeSubagentType(subagentType)] = preference;
	}
	return Object.keys(preferences).length > 0 ? preferences : undefined;
}

export async function loadGlobalPreferences(path: string = preferencePath()): Promise<SubagentPreferenceMap | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return parsePreferenceMap(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/** Load the legacy unnamed preference bucket. */
export async function loadGlobalPreference(path: string = preferencePath()): Promise<SubagentPreference | undefined> {
	return (await loadGlobalPreferences(path))?.[DEFAULT_SUBAGENT_TYPE];
}

async function writePreferenceFile(
	value: unknown,
	path: string,
	shouldCancel?: () => boolean,
): Promise<boolean> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	if (shouldCancel?.()) return false;
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let moved = false;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		// Keep the cancellation check immediately before the synchronous rename:
		// once the rename starts, no session event can interleave with it.
		if (shouldCancel?.()) return false;
		renameSync(temporary, path);
		moved = true;
		return true;
	} finally {
		if (!moved) await unlink(temporary).catch(() => undefined);
	}
}

/** Serialize preference file mutations across concurrent calls and extension reloads. */
const PREFERENCE_WRITE_QUEUES_KEY = Symbol.for("pi.subagents.preferenceWriteQueues");
const writeQueueGlobal = globalThis as typeof globalThis & {
	[PREFERENCE_WRITE_QUEUES_KEY]?: Map<string, Promise<void>>;
};
const preferenceWriteQueues =
	writeQueueGlobal[PREFERENCE_WRITE_QUEUES_KEY] ?? (writeQueueGlobal[PREFERENCE_WRITE_QUEUES_KEY] = new Map());

async function withPreferenceWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = preferenceWriteQueues.get(path) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	preferenceWriteQueues.set(path, current);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (preferenceWriteQueues.get(path) === current) preferenceWriteQueues.delete(path);
	}
}

/** Save all typed choices in the version 2 global preference file. */
export async function saveGlobalPreferences(
	preferences: SubagentPreferenceMap,
	path: string = preferencePath(),
	shouldCancel?: () => boolean,
): Promise<boolean> {
	const parsed = parsePreferenceMap({ preferences }) ?? {};
	return withPreferenceWriteLock(path, () => writePreferenceFile({ version: 2, preferences: parsed }, path, shouldCancel));
}

/**
 * Save the old untyped form. It remains an unnamed-only choice, so existing
 * files and callers cannot accidentally become a wildcard preference.
 */
export async function saveGlobalPreference(
	preference: SubagentPreference,
	path: string = preferencePath(),
	shouldCancel?: () => boolean,
): Promise<boolean> {
	const parsed = parsePreference(preference);
	if (!parsed) throw new Error("Invalid subagent preference");
	return withPreferenceWriteLock(path, () => writePreferenceFile({ version: 1, ...parsed }, path, shouldCancel));
}

/** Merge one typed choice into the global preference file. */
export async function saveGlobalPreferenceForType(
	subagentType: string,
	preference: SubagentPreference,
	path: string = preferencePath(),
	shouldCancel?: () => boolean,
): Promise<boolean> {
	const parsed = parsePreference(preference);
	if (!parsed) throw new Error("Invalid subagent preference");
	return withPreferenceWriteLock(path, async () => {
		if (shouldCancel?.()) return false;
		const preferences = (await loadGlobalPreferences(path)) ?? {};
		if (shouldCancel?.()) return false;
		preferences[normalizeSubagentType(subagentType)] = parsed;
		return writePreferenceFile({ version: 2, preferences }, path, shouldCancel);
	});
}

async function unlinkPreferenceFile(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

/** Remove the saved global choice so the next session asks again. */
export async function clearGlobalPreference(path: string = preferencePath()): Promise<void> {
	await withPreferenceWriteLock(path, () => unlinkPreferenceFile(path));
}

/** Remove one typed global choice without disturbing the other types. */
export async function clearGlobalPreferenceForType(
	subagentType: string,
	path: string = preferencePath(),
): Promise<void> {
	await withPreferenceWriteLock(path, async () => {
		const preferences = await loadGlobalPreferences(path);
		if (!preferences) return;
		delete preferences[normalizeSubagentType(subagentType)];
		if (Object.keys(preferences).length === 0) {
			await unlinkPreferenceFile(path);
		} else {
			await writePreferenceFile({ version: 2, preferences }, path);
		}
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
	/** Whether the model supports reasoning; false means only `off` is valid. */
	reasoning?: boolean;
	/** Provider/model-specific mappings; null marks a level as unsupported. */
	thinkingLevelMap?: Partial<Record<SubagentThinking, string | null>>;
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

export function supportedThinkingLevels(model: SubagentModelInfo | undefined): SubagentThinking[] {
	// An unknown/custom model can safely be run with reasoning off, but no
	// concrete reasoning level can be offered without capability metadata.
	if (!model || model.reasoning !== true) return ["off"];

	const map = model.thinkingLevelMap;
	const supported = THINKING_LEVELS.filter((level) => {
		if (map?.[level] === null) return false;
		// The core model helpers require explicit mappings for the extended
		// levels; missing mappings mean xhigh/max are not supported.
		if ((level === "xhigh" || level === "max") && map?.[level] === undefined) return false;
		return true;
	});
	return supported.length > 0 ? supported : ["off"];
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
	modelRegistry: {
		getAvailable(): readonly SubagentModelInfo[];
		hasConfiguredAuth(model: SubagentModelInfo): boolean;
	};
	/** Session-scoped models (`--models` / `enabledModels`). Empty means unscoped. */
	scopedModels?: readonly { model: SubagentModelInfo }[];
}

/**
 * Models the user may pick: the session's scoped set when scoping is configured
 * (the same set `/scoped-models` shows), otherwise every authenticated model.
 * Models without configured auth are never offered.
 */
export function selectableModels(ctx: PreferenceDialogContext): SubagentModelInfo[] {
	const scoped = (ctx.scopedModels ?? []).map((entry) => entry.model);
	const catalogue = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
	return catalogue.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
}

function preferenceSubject(subagentType?: string): string {
	const type = normalizeSubagentType(subagentType);
	return type === DEFAULT_SUBAGENT_TYPE ? "subagents" : `the \"${type}\" subagent`;
}

export async function promptForPreference(
	ctx: PreferenceDialogContext,
	subagentType?: string,
): Promise<PreferencePromptResult> {
	const selectable = selectableModels(ctx);
	const choices = buildModelChoices(selectable);
	if (choices.length === 0) return { persistGlobally: false, cancelled: true };

	const subject = preferenceSubject(subagentType);
	const modelTitle = subject === "subagents" ? "Which model should subagents use?" : `Which model should ${subject} use?`;
	const thinkingTitle =
		subject === "subagents" ? "Which thinking level should subagents use?" : `Which thinking level should ${subject} use?`;
	const modelOptions = [
		...choices.map((choice) => `${choice.label} — ${choice.description}`),
		AUTO_MODEL_OPTION,
		OTHER_MODEL_OPTION,
	];
	const selected = await ctx.ui.select(modelTitle, modelOptions);
	if (selected === undefined) return { persistGlobally: false, cancelled: true };

	let model: string | undefined;
	let selectedModel: SubagentModelInfo | undefined;
	if (selected === AUTO_MODEL_OPTION) {
		model = AUTO_VALUE;
	} else if (selected === OTHER_MODEL_OPTION) {
		const custom = await ctx.ui.input("Subagent model", "provider/id");
		if (custom === undefined || custom.trim() === "") return { persistGlobally: false, cancelled: true };
		model = custom.trim();
		selectedModel = selectable.find(
			(candidate) =>
				`${candidate.provider}/${candidate.id}` === model || candidate.id === model || candidate.name === model,
		);
	} else {
		const match = choices.find((choice) => selected === `${choice.label} — ${choice.description}`);
		if (!match) return { persistGlobally: false, cancelled: true };
		model = match.value;
		selectedModel = selectable.find((candidate) => `${candidate.provider}/${candidate.id}` === model);
	}

	const thinkingOptions = [
		AUTO_THINKING_OPTION,
		...supportedThinkingLevels(selectedModel).map((level) => `${level} — ${THINKING_DESCRIPTIONS[level]}`),
	];
	const thinkingSelected = await ctx.ui.select(thinkingTitle, thinkingOptions);
	if (thinkingSelected === undefined) return { persistGlobally: false, cancelled: true };
	const thinking: SubagentThinkingChoice =
		thinkingSelected === AUTO_THINKING_OPTION
			? AUTO_VALUE
			: (THINKING_LEVELS.find((level) => thinkingSelected.startsWith(`${level} —`)) ?? AUTO_VALUE);

	const persistGlobally = await ctx.ui.confirm(
		"Remember this subagent choice?",
		`${describePreference({ model, thinking })}\n\nIt is remembered for ${subject}. Save it for future sessions too?`,
	);

	return { preference: { model, thinking }, persistGlobally, cancelled: false };
}

export type PreferenceSource = "session" | "global" | "prompted" | "unavailable" | "cancelled";

export interface PreferenceResolution {
	source: PreferenceSource;
	preference?: SubagentPreference;
}

export interface ResolvePreferenceOptions {
	/** Return true when the caller's session was replaced while resolving a choice. */
	shouldCancel?: () => boolean;
	/** Override the global lookup (tests). May return a legacy untyped choice. */
	loadGlobal?: () => Promise<SubagentPreferenceMap | SubagentPreference | undefined>;
	/** Override the global save (tests). The second argument identifies the type. */
	saveGlobal?: (preference: SubagentPreference, subagentType?: string) => Promise<void | boolean>;
	/** Override the interactive prompt (tests). */
	prompt?: (ctx: PreferenceDialogContext, subagentType?: string) => Promise<PreferencePromptResult>;
}

function preferenceMapFromValue(value: SubagentPreferenceMap | SubagentPreference | undefined): SubagentPreferenceMap {
	if (!value) return {};
	const legacy = parsePreference(value);
	if (legacy) return { [DEFAULT_SUBAGENT_TYPE]: legacy };
	return parsePreferenceMap(value) ?? {};
}

/**
 * Resolve the preference for one typed launch: the typed session choice first,
 * then the typed saved global choice, then ask the user. Returns `cancelled`
 * when the user aborts the prompt so the caller can stop instead of guessing.
 *
 * The two-argument `(ctx, options)` form remains supported for the unnamed
 * bucket used by older callers.
 */
export function resolvePreference(
	ctx: PreferenceDialogContext,
	options?: ResolvePreferenceOptions,
): Promise<PreferenceResolution>;
export function resolvePreference(
	ctx: PreferenceDialogContext,
	subagentType: string,
	options?: ResolvePreferenceOptions,
): Promise<PreferenceResolution>;
export async function resolvePreference(
	ctx: PreferenceDialogContext,
	subagentTypeOrOptions: string | ResolvePreferenceOptions = DEFAULT_SUBAGENT_TYPE,
	maybeOptions: ResolvePreferenceOptions = {},
): Promise<PreferenceResolution> {
	const subagentType = normalizeSubagentType(
		typeof subagentTypeOrOptions === "string" ? subagentTypeOrOptions : DEFAULT_SUBAGENT_TYPE,
	);
	const options = typeof subagentTypeOrOptions === "string" ? maybeOptions : subagentTypeOrOptions;

	if (options.shouldCancel?.()) return { source: "cancelled" };

	const session = getSessionPreference(subagentType);
	if (session) return { source: "session", preference: session };

	const loadGlobal = options.loadGlobal ?? (() => loadGlobalPreferences());
	const global = preferenceMapFromValue(await loadGlobal())[subagentType];
	if (options.shouldCancel?.()) return { source: "cancelled" };
	if (global) {
		setSessionPreference(subagentType, global);
		return { source: "global", preference: global };
	}

	if (!ctx.hasUI) return { source: "unavailable" };

	const prompt = options.prompt ?? promptForPreference;
	const result = await prompt(ctx, subagentType);
	if (options.shouldCancel?.()) return { source: "cancelled" };
	if (result.cancelled || !result.preference) return { source: "cancelled" };

	if (result.persistGlobally) {
		if (options.shouldCancel?.()) return { source: "cancelled" };
		const saveGlobal =
			options.saveGlobal ??
			((preference: SubagentPreference, type?: string) =>
				saveGlobalPreferenceForType(type ?? DEFAULT_SUBAGENT_TYPE, preference, undefined, options.shouldCancel));
		const saved = await saveGlobal(result.preference, subagentType);
		if (saved === false || options.shouldCancel?.()) return { source: "cancelled" };
	}
	if (options.shouldCancel?.()) return { source: "cancelled" };
	setSessionPreference(subagentType, result.preference);
	return { source: "prompted", preference: result.preference };
}
