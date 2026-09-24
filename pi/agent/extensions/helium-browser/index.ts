import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { apwStatus, getApwCredential, listApwLogins, type ApwLoginMetadata } from "./apw.ts";
import { registerApwAliasTool } from "./apw-alias-tool.ts";
import { createToolResultRenderer } from "../tool-results/render.ts";
import {
	focusedSensitiveFieldEvaluator,
	loginFormEvaluator,
	snapshotEvaluator,
	type LoginFormDescriptor,
	type SnapshotDescriptor,
} from "./renderer-evaluators.ts";

export {
	clickabilityEvaluator,
	focusedSensitiveFieldEvaluator,
	inputActionEvaluator,
	loginFormEvaluator,
	snapshotEvaluator,
} from "./renderer-evaluators.ts";

export function discoverLoginFormEvaluator(): LoginFormDescriptor | undefined {
	const result = loginFormEvaluator("discover");
	return result && typeof result === "object" ? result : undefined;
}

import {
	ActionCanceledError,
	ActionUnknownOutcomeError,
	checkInputHandle,
	clickElementHandle,
	currentHttpsOrigin,
	discoverCurrentLoginForm,
	fillApwOnPage,
	fillHandle,
	pageIsHidden,
	throwIfActionNotAborted,
	typeInBackgroundHandle,
	withElementActionTimeout,
	withTabMutation,
	type HeliumActionContext,
} from "./page-actions.ts";

export {
	ActionCanceledError,
	ActionUnknownOutcomeError,
	clickElementHandle,
	fillApwOnPage,
	withTabMutation,
} from "./page-actions.ts";
export { ELEMENT_ACTION_TIMEOUT_MS } from "./page-actions.ts";
export type { HeliumActionContext } from "./page-actions.ts";

import {
	awaitRefDisposalDuringShutdown,
	cacheRefHandles,
	clearSnapshotCursorsForPage,
	deleteSnapshotCursor,
	detachAllRefMaps,
	disposeDetachedRefMaps,
	getCachedRefHandle,
	getRefStateHandleCount,
	getRefStateIds,
	getSnapshotCursor,
	invalidateRefs,
	isCurrentRefState,
	pruneRefCache,
	removeEmptyRefState,
	setSnapshotCursor,
	trackRefDisposal,
	type RefMap,
	type RefState,
	type SnapshotCursor,
} from "./page-state.ts";

export {
	disposeAllRefs,
	getHeliumRefCacheStats,
	getSnapshotCursorCount,
	MAX_SNAPSHOT_CURSORS,
	MAX_SNAPSHOT_CURSORS_PER_TAB,
	SNAPSHOT_CURSOR_TTL_MS,
} from "./page-state.ts";
export { disposeRefHandles } from "./page-state.ts";

/**
 * Helium browser control over its Chromium DevTools endpoint.
 *
 * This extension only ever attaches to an existing browser. The optional
 * /helium start command launches Helium with the user's normal profile, but
 * only after confirming that no Helium process is running.
 */

export const HELIUM_APP_PATH = "/Applications/Helium.app";
export const HELIUM_EXECUTABLE_PATH = "/Applications/Helium.app/Contents/MacOS/Helium";
export const HELIUM_BUNDLE_ID = "net.imput.helium";
export const HELIUM_CDP_URL = "http://127.0.0.1:9222";
export const HELIUM_CDP_VERSION_URL = `${HELIUM_CDP_URL}/json/version`;
export const HELIUM_PROFILE_DIRECTORY = "Default";
const LOCK_USER = typeof process.getuid === "function" ? String(process.getuid()) : (process.env.USER ?? "user");
export const HELIUM_START_LOCK_DIR = join(tmpdir(), `pi-helium-browser-start-${LOCK_USER}.lock`);

const MAX_TEXT_CHARS = 10_000;
const MAX_SELECTOR_CHARS = 500;
const MAX_SNAPSHOT_CHARS = 30_000;
/** Bounds both renderer-side candidate work and retained remote object handles. */
export const MAX_SNAPSHOT_REFS = 256;
const MAX_SNAPSHOT_CANDIDATES = 1_024;
const SNAPSHOT_HANDLE_CONCURRENCY = 8;
const MAX_SCREENSHOT_BASE64_CHARS = 8_000_000;
/** Conservative Chromium capture limits: at most ~200 MiB of raw RGBA pixels. */
export const MAX_SCREENSHOT_PIXELS = 50_000_000;
export const MAX_SCREENSHOT_DIMENSION = 32_768;
const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const BROWSER_TARGET_REFRESH_TIMEOUT_MS = 1_000;
const MAX_TABS_OUTPUT = 50;
/** Keep tab metadata work and model-facing details bounded independently. */
export const MAX_TABS_DETAILS = 50;
const TAB_METADATA_CONCURRENCY = 8;
const MAX_NOTIFICATION_TITLE_CHARS = 120;
const MAX_NOTIFICATION_BODY_CHARS = 300;
const INTERVENTION_COOLDOWN_MS = 60_000;
export const MAX_INTERVENTION_COOLDOWNS = 256;
export const OWNERSHIP_STATE_VERSION = 1;
const HELIUM_USER_DATA_DIR = join(homedir(), "Library", "Application Support", HELIUM_BUNDLE_ID);

export type TabOwnership = "pi" | "user" | "unknown";
export type OwnershipState = {
	version: typeof OWNERSHIP_STATE_VERSION;
	browserInstanceId: string;
	windowId: number;
};

export function heliumOwnershipStatePath(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
		"state",
		"helium-browser",
		"ownership.json",
	);
}

export function heliumOwnershipLockPath(): string {
	return join(dirname(heliumOwnershipStatePath()), "ownership.lock");
}

export function heliumPiTabReservationsPath(): string {
	return join(dirname(heliumOwnershipStatePath()), "tab-reservations.json");
}

type Browser = import("puppeteer-core").Browser;
type Page = import("puppeteer-core").Page;
type RefHandle = import("puppeteer-core").ElementHandle<Element>;
type PuppeteerKeyInput = import("puppeteer-core").KeyInput;

type CdpVersion = {
	Browser?: string;
	"Protocol-Version"?: string;
	webSocketDebuggerUrl?: string;
};

type ProcessState = "running" | "not-running" | "unknown";
export type CdpOwnerState = "helium" | "missing" | "foreign" | "ambiguous" | "unknown";

type CdpOwner = {
	state: CdpOwnerState;
	detail: string;
	pid?: string;
};

export type TabInfo = {
	id: string;
	title: string;
	url: string;
	windowId?: number;
	ownership: TabOwnership;
};

export type PiWindowState = "owned" | "not-created" | "stale" | "unavailable";


type BrowserStatus = {
	cdpAvailable: boolean;
	process: ProcessState;
	browser?: string;
	protocol?: string;
	tabs: TabInfo[];
	piWindowState: PiWindowState;
	piWindowId?: number;
	piTabCount: number;
	userTabCount: number;
	error?: string;
};

let browser: Browser | undefined;
let browserInstanceId: string | undefined;
let connectPromise: Promise<Browser> | undefined;
let browserRefreshPromise: Promise<Browser> | undefined;
let startPromise: Promise<string> | undefined;
type OwnershipWindow = { page: Page; windowId: number; targetId?: string };
export type PiWindowAction = "adopted" | "created" | "recovered";
type EnsurePiWindowResult = OwnershipWindow & { createdInitial: boolean; action: PiWindowAction };
type OwnershipCreationTask = {
	promise: Promise<EnsurePiWindowResult>;
	cancel(error: Error): void;
};
const ownershipCreationPromises = new Map<string, OwnershipCreationTask>();
const piTabOpenPromises = new Map<string, Promise<void>>();
const piTabOpenQueueCounts = new Map<string, number>();
const piTabOpenReservedPages = new Map<string, Set<string>>();
const piTabOpenReservedBrowsers = new Map<string, Browser>();
let nextFallbackTabId = 1;
const fallbackTabIds = new WeakMap<object, string>();
const trackedPages = new WeakSet<object>();

const emptyParams = Type.Object({});
const tabsParams = Type.Object({
	scope: Type.Optional(
		StringEnum(["all", "pi", "user"] as const, {
			description: "Which tabs to list; defaults to all",
		}),
	),
});
const elementTargetParams = Type.Object({
	tabId: Type.Optional(
		Type.String({ minLength: 1, maxLength: 200, description: "Tab id from helium_tabs or helium_snapshot" }),
	),
	ref: Type.Optional(
		Type.String({ minLength: 1, maxLength: 50, description: "Stable ref returned by helium_snapshot" }),
	),
	selector: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_SELECTOR_CHARS,
			description: "CSS selector for one visible element",
		}),
	),
});
const navigateParams = Type.Object({
	tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Tab id from helium_tabs" })),
	url: Type.String({ minLength: 1, maxLength: 2_048, description: "An http(s) URL, or about:blank" }),
});
const openTabParams = Type.Object({
	url: Type.Optional(Type.String({ maxLength: 2_048, description: "Target http(s) URL; defaults to about:blank" })),
});
const snapshotParams = Type.Object({
	tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Tab id from helium_tabs" })),
	maxChars: Type.Optional(
		Type.Integer({ minimum: 1_000, maximum: MAX_SNAPSHOT_CHARS, description: "Maximum readable snapshot size" }),
	),
	includeRefs: Type.Optional(
		Type.Boolean({ description: "Include stable refs for interactive controls; defaults to true" }),
	),
	cursor: Type.Optional(
		Type.String({ minLength: 1, maxLength: 300, description: "Opaque continuation cursor returned by helium_snapshot" }),
	),
	scope: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_SELECTOR_CHARS,
			description: "Optional CSS selector limiting bounded snapshot traversal to one subtree",
		}),
	),
});
const fillParams = Type.Object({
	tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	ref: Type.Optional(
		Type.String({ minLength: 1, maxLength: 50, description: "Stable ref returned by helium_snapshot" }),
	),
	selector: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_SELECTOR_CHARS,
			description: "CSS selector for one visible element",
		}),
	),
	text: Type.String({ maxLength: MAX_TEXT_CHARS, description: "Replacement value" }),
});
const typeParams = Type.Object({
	tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	ref: Type.Optional(
		Type.String({ minLength: 1, maxLength: 50, description: "Stable ref returned by helium_snapshot" }),
	),
	selector: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_SELECTOR_CHARS,
			description: "CSS selector for one visible element",
		}),
	),
	text: Type.String({ maxLength: MAX_TEXT_CHARS, description: "Text to type into the focused element" }),
});
/**
 * Keyboard input is deliberately limited to named navigation/control keys. A
 * printable key would be a second, unbounded text-entry API (and could edit a
 * password field simply because it happened to have focus). Control+A is kept
 * as the one useful printable-looking exception: with Control/Meta it is a
 * selection command, not text insertion. Paste/cut shortcuts are never
 * accepted.
 */
export const SAFE_HELIUM_KEY_PATTERN =
	/^(?:(?:(?:Control|Ctrl|Alt|Shift|Meta|Command)\+)*(?:Enter|Escape|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Home|End|Page(?:Up|Down)|F(?:[1-9]|1[0-2]))|(?:(?:Control|Ctrl|Alt|Meta|Command)\+)*Insert|(?:(?:Control|Ctrl|Meta|Command)\+)(?:Shift\+)?A)$/;
const namedHeliumControlKeys = new Set([
	"Enter",
	"Escape",
	"Tab",
	"Backspace",
	"Delete",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"Insert",
	...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);
const heliumKeyModifiers = new Set(["Control", "Ctrl", "Alt", "Shift", "Meta", "Command"]);

export function validateHeliumKey(value: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 50 || !SAFE_HELIUM_KEY_PATTERN.test(value)) {
		throw new Error(
			"Invalid key; use a named navigation/control key (Enter, Escape, Arrow*, Tab, Backspace, Delete, Home, End, PageUp/PageDown, Insert, F1-F12) or Control/Meta+A. Printable text and paste shortcuts are not allowed.",
		);
	}
	const parts = value.split("+");
	const finalKey = parts.pop()!;
	const modifiers = parts;
	if (new Set(modifiers).size !== modifiers.length || modifiers.some((modifier) => !heliumKeyModifiers.has(modifier))) {
		throw new Error("Invalid key modifiers; duplicate or unknown modifiers are not allowed.");
	}
	if (finalKey === "A" && !modifiers.some((modifier) => modifier === "Control" || modifier === "Ctrl" || modifier === "Meta" || modifier === "Command")) {
		throw new Error("Printable key combinations are only allowed for Control/Meta+A selection.");
	}
	if (finalKey === "V" || finalKey === "X") throw new Error("Paste and cut shortcuts are not allowed.");
	// Shift+Insert is the legacy paste shortcut on Linux/Windows terminals and
	// desktop applications. It is otherwise a named control key, so reject it
	// explicitly rather than allowing a paste into a focused credential field.
	if (finalKey === "Insert" && modifiers.includes("Shift")) throw new Error("Paste shortcuts are not allowed.");
	if (finalKey !== "A" && !namedHeliumControlKeys.has(finalKey)) throw new Error("Only navigation/control keys are allowed.");
	return value;
}

const keyParams = Type.Object({
	tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	key: Type.String({
		minLength: 1,
		maxLength: 50,
		pattern: SAFE_HELIUM_KEY_PATTERN.source,
		description: "A named navigation/control key such as Enter, Escape, ArrowDown, Tab, or Control+A; text and paste keys are rejected",
	}),
});
const screenshotParams = Type.Object({
	tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page; defaults to false" })),
});
const interventionParams = Type.Object({
	kind: StringEnum(
		["login", "signup", "mfa", "passkey", "captcha", "payment", "consent", "other"] as const,
		{ description: "Manual action required in the current Helium tab" },
	),
	tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	focus: Type.Optional(Type.Boolean({ default: false })),
});
const apwFillParams = Type.Object({
	tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

type ElementTarget = Static<typeof elementTargetParams>;
type FillInput = Static<typeof fillParams>;
type TabsInput = Static<typeof tabsParams>;
type TypeInput = Static<typeof typeParams>;
type KeyInput = Static<typeof keyParams>;
type InterventionInput = Static<typeof interventionParams>;
type ApwFillInput = Static<typeof apwFillParams>;

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 40))}\n… [truncated; ${value.length - max} more characters]`;
}


function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse and validate persisted ownership without trusting arbitrary JSON on disk. */
export function classifyOwnershipRecord(
	state: OwnershipState | undefined,
	instanceId: string,
	liveWindowId?: number,
): { state: PiWindowState; windowId?: number } {
	if (!state) return { state: "not-created" };
	if (state.browserInstanceId !== instanceId) return { state: "stale" };
	if (liveWindowId === state.windowId) return { state: "owned", windowId: state.windowId };
	return { state: "stale", windowId: state.windowId };
}

export function parseOwnershipState(value: unknown): OwnershipState | undefined {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object") return undefined;
	if (!("version" in value) || value.version !== OWNERSHIP_STATE_VERSION) return undefined;
	if (!("browserInstanceId" in value) || typeof value.browserInstanceId !== "string" || !value.browserInstanceId)
		return undefined;
	if (!("windowId" in value) || typeof value.windowId !== "number" || !Number.isInteger(value.windowId))
		return undefined;
	return {
		version: OWNERSHIP_STATE_VERSION,
		browserInstanceId: value.browserInstanceId,
		windowId: value.windowId,
	};
}

async function readOwnershipState(): Promise<OwnershipState | undefined> {
	try {
		return parseOwnershipState(JSON.parse(await readFile(heliumOwnershipStatePath(), "utf8")));
	} catch {
		return undefined;
	}
}

async function removeOwnershipState(expected?: OwnershipState): Promise<void> {
	const current = await readOwnershipState();
	if (
		!current ||
		!expected ||
		(current.browserInstanceId === expected.browserInstanceId && current.windowId === expected.windowId)
	) {
		await rm(heliumOwnershipStatePath(), { force: true }).catch(() => {});
	}
}

async function writeOwnershipState(state: OwnershipState): Promise<void> {
	const path = heliumOwnershipStatePath();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

/** Parse machine-readable lsof PID output without trusting the command name. */
export function parseLsofPids(output: string): string[] {
	return [
		...new Set(
			output
				.split(/\r?\n/)
				.filter((line) => line.startsWith("p"))
				.map((line) => line.slice(1).trim())
				.filter((pid) => /^\d+$/.test(pid)),
		),
	];
}

/** Parse machine-readable lsof file-name output (the `n` records). */
export function parseLsofNames(output: string): string[] {
	return output
		.split(/\r?\n/)
		.filter((line) => line.startsWith("n"))
		.map((line) => line.slice(1).trim())
		.filter(Boolean);
}

function parsePidLines(output: string): string[] {
	return [
		...new Set(
			output
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((pid) => /^\d+$/.test(pid)),
		),
	];
}

export function classifyCdpExecutables(paths: string[]): CdpOwnerState {
	// On macOS, `lsof -d txt` reports the main executable first, followed by
	// every mapped framework and shared library. Identity is determined by the
	// first text entry; treating all subsequent mappings as executables makes a
	// valid Helium process appear ambiguous.
	if (paths.length === 0) return "unknown";
	return paths[0] === HELIUM_EXECUTABLE_PATH ? "helium" : "foreign";
}

async function inspectCdpOwner(pi: ExtensionAPI): Promise<CdpOwner> {
	if (globalThis.process.platform !== "darwin") {
		return { state: "unknown", detail: "CDP listener identity verification requires macOS lsof." };
	}
	try {
		const listener = await pi.exec("lsof", ["-nP", "-iTCP:9222", "-sTCP:LISTEN", "-Fp"], { timeout: 2_000 });
		if (listener.code === 1) return { state: "missing", detail: "No process is listening on TCP port 9222." };
		if (listener.code !== 0)
			return { state: "unknown", detail: listener.stderr.trim() || "lsof could not inspect TCP port 9222." };
		const pids = parseLsofPids(listener.stdout);
		if (pids.length === 0) return { state: "unknown", detail: "lsof reported a listener without a PID." };
		if (pids.length > 1)
			return {
				state: "ambiguous",
				detail: `Multiple processes listen on TCP port 9222 (PIDs ${pids.join(", ")}).`,
			};

		const executable = await pi.exec("lsof", ["-nP", "-a", "-p", pids[0], "-d", "txt", "-Fn"], { timeout: 2_000 });
		if (executable.code !== 0) {
			return {
				state: "unknown",
				detail: executable.stderr.trim() || `Could not identify listener PID ${pids[0]}.`,
				pid: pids[0],
			};
		}
		const names = parseLsofNames(executable.stdout);
		const state = classifyCdpExecutables(names);
		if (state === "helium") return { state, detail: `Verified Helium listener PID ${pids[0]}.`, pid: pids[0] };
		if (state === "foreign")
			return { state, detail: `Port 9222 is owned by ${names[0]}, not Helium (PID ${pids[0]}).`, pid: pids[0] };
		return { state, detail: `Could not unambiguously identify listener PID ${pids[0]}.`, pid: pids[0] };
	} catch (error) {
		return { state: "unknown", detail: `Listener identity check failed: ${errorText(error)}` };
	}
}

function cdpOwnerMessage(owner: CdpOwner): string {
	if (owner.state === "missing") return cdpUnavailableMessage();
	if (owner.state === "foreign") return `Refusing Helium CDP access: ${owner.detail}`;
	if (owner.state === "ambiguous") return `Refusing Helium CDP access: ${owner.detail}`;
	return `Refusing Helium CDP access: ${owner.detail}`;
}

export async function profileLockState(
	lockPath = join(HELIUM_USER_DATA_DIR, "SingletonLock"),
): Promise<"locked" | "clear" | "unknown"> {
	try {
		// Chromium's SingletonLock is commonly a dangling symlink containing the
		// host/PID. lstat checks whether the directory entry exists without
		// following that symlink.
		await lstat(lockPath);
		return "locked";
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "clear";
		return "unknown";
	}
}

type StartLockOwner = { pid: number; token: string; startedAt: string };
export type HeliumStartLock = { release(): Promise<void> };

function lockErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function processIsAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = lockErrorCode(error);
		if (code === "ESRCH") return false;
		return code === "EPERM" ? true : undefined;
	}
}

function parseStartLockOwner(value: unknown): StartLockOwner | undefined {
	if (
		value &&
		typeof value === "object" &&
		"pid" in value &&
		typeof value.pid === "number" &&
		Number.isInteger(value.pid) &&
		value.pid > 0 &&
		"token" in value &&
		typeof value.token === "string" &&
		"startedAt" in value &&
		typeof value.startedAt === "string"
	) {
		return value as StartLockOwner;
	}
	return undefined;
}

async function readStartLockOwner(lockDir: string): Promise<StartLockOwner | undefined> {
	try {
		return parseStartLockOwner(JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")));
	} catch {}
	return undefined;
}

type StartLockOwnerSnapshot = {
	owner?: StartLockOwner;
	metadata: "valid" | "missing" | "invalid";
};

async function readStartLockOwnerSnapshot(lockDir: string): Promise<StartLockOwnerSnapshot> {
	try {
		const raw = await readFile(join(lockDir, "owner.json"), "utf8");
		const owner = parseStartLockOwner(JSON.parse(raw));
		return owner ? { owner, metadata: "valid" } : { metadata: "invalid" };
	} catch (error) {
		return lockErrorCode(error) === "ENOENT" ? { metadata: "missing" } : { metadata: "invalid" };
	}
}

/** Acquire a temp-directory lock without touching Chromium's profile lock files. */
export async function acquireHeliumStartLock(lockDir = HELIUM_START_LOCK_DIR): Promise<HeliumStartLock> {
	for (;;) {
		const token = randomUUID();
		const owner: StartLockOwner = { pid: process.pid, token, startedAt: new Date().toISOString() };
		// Publish only a fully initialized directory. This removes the crash
		// window where a reclaimer could mistake our just-created empty directory
		// for an ownerless stale lock, and prevents failed initialization from
		// deleting a different contender's lock.
		const candidate = `${lockDir}.candidate-${token}`;
		await mkdir(candidate, { mode: 0o700 });
		try {
			await writeFile(join(candidate, "owner.json"), JSON.stringify(owner), {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
		} catch (error) {
			await rm(candidate, { recursive: true, force: true }).catch(() => {});
			throw new Error(`Could not initialize Helium start lock ${lockDir}: ${errorText(error)}`);
		}

		try {
			await rename(candidate, lockDir);
		} catch (error) {
			await rm(candidate, { recursive: true, force: true }).catch(() => {});
			if (lockErrorCode(error) !== "EEXIST" && lockErrorCode(error) !== "ENOTEMPTY") throw error;

			// Never rename a possibly-live lock away from its canonical pathname:
			// that would create a gap in which a third contender could acquire it
			// while the original owner continues working. Inspect in place, and
			// reclaim only a definitively dead owner by removing its marker and then
			// atomically removing the now-empty directory. Until rmdir succeeds,
			// every contender still observes the lock directory.
			const snapshot = await readStartLockOwnerSnapshot(lockDir);
			if (snapshot.metadata === "valid" && processIsAlive(snapshot.owner!.pid) !== false) {
				throw new Error(
					`Another Helium start is in progress (lock ${lockDir}; owner metadata is active or uncertain).`,
				);
			}
			if (snapshot.metadata === "invalid") {
				throw new Error(
					`Another Helium start is in progress (lock ${lockDir}; owner metadata is missing or invalid).`,
				);
			}

			// A published lock contains exactly owner.json. An ownerless crash
			// remnant must be empty; unknown extra entries are left in place.
			let entries: string[];
			try {
				entries = await readdir(lockDir);
			} catch (readError) {
				if (lockErrorCode(readError) === "ENOENT") continue;
				throw new Error(`Could not inspect stale Helium start lock ${lockDir}: ${errorText(readError)}`);
			}
			const expectedEntries = snapshot.metadata === "valid" ? ["owner.json"] : [];
			if (entries.length !== expectedEntries.length || entries.some((entry) => !expectedEntries.includes(entry))) {
				throw new Error(
					`Another Helium start is in progress (lock ${lockDir}; owner metadata is missing or invalid).`,
				);
			}
			if (snapshot.metadata === "valid") {
				try {
					await unlink(join(lockDir, "owner.json"));
				} catch (unlinkError) {
					if (lockErrorCode(unlinkError) !== "ENOENT")
						throw new Error(`Could not reclaim stale Helium start lock ${lockDir}: ${errorText(unlinkError)}`);
				}
			}
			try {
				await rmdir(lockDir);
			} catch (removeError) {
				if (lockErrorCode(removeError) === "ENOENT" || lockErrorCode(removeError) === "ENOTEMPTY") continue;
				throw new Error(`Could not reclaim stale Helium start lock ${lockDir}: ${errorText(removeError)}`);
			}
			continue;
		}

		let released = false;
		return {
			release: async () => {
				if (released) return;
				released = true;
				const current = await readStartLockOwner(lockDir);
				if (current?.token === token) await rm(lockDir, { recursive: true, force: true });
			},
		};
	}
}

export async function acquireHeliumOwnershipLock(lockDir = heliumOwnershipLockPath()): Promise<HeliumStartLock> {
	await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
	return acquireHeliumStartLock(lockDir);
}

async function acquireHeliumOwnershipLockForMutation(timeoutMs = 5_000): Promise<HeliumStartLock> {
	let lastError: unknown;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await acquireHeliumOwnershipLock();
		} catch (error) {
			lastError = error;
			if (!errorText(error).startsWith("Another Helium start is in progress")) throw error;
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await sleep(Math.min(25, remaining));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Could not acquire the Helium ownership lock.");
}

/** Validate navigation before passing it to Chromium. javascript: and file: are intentionally excluded. */
export function normalizeNavigationUrl(value: string): string {
	const url = value.trim();
	if (url === "about:blank") return url;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("URL must be a valid http(s) URL or about:blank.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Only http(s) URLs and about:blank are allowed for navigation.");
	}
	return parsed.toString();
}

/** URLs Chromium uses for an unused new tab. Keep this allowlist conservative. */
export function isReusableEmptyPageUrl(value: string): boolean {
	const url = value.trim().toLowerCase().replace(/\/+$/, "");
	return [
		"about:blank",
		"chrome://newtab",
		"chrome://new-tab-page",
		"chrome-search://local-ntp/local-ntp.html",
	].includes(url);
}

export async function openHeliumTab(browserInstance: Pick<Browser, "newPage">, rawUrl?: string): Promise<Page> {
	const url = rawUrl?.trim() ? normalizeNavigationUrl(rawUrl) : "about:blank";
	const page = await browserInstance.newPage();
	try {
		if (url !== "about:blank") {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
		}
		return page;
	} catch (error) {
		try {
			await page.close();
		} catch {}
		throw error;
	}
}

export async function waitForCausalPopup(opener: Page): Promise<Page> {
	const events = opener as unknown as {
		on?(event: string, listener: (page: Page) => void): void;
		once(event: string, listener: (page: Page) => void): void;
		off?(event: string, listener: (page: Page) => void): void;
	};
	const openerTarget = opener.target();
	const popupName = `pi-helium-popup-${randomUUID()}`;
	let candidate: Page | undefined;
	let listener: ((page: Page) => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let registeredWithOn = false;
	const popup = new Promise<Page>((resolve, reject) => {
		listener = (page) => {
			void (async () => {
				const popupTarget = page.target() as unknown as { opener?: () => unknown };
				if (typeof popupTarget.opener !== "function" || popupTarget.opener() !== openerTarget) return;

				// The opener relationship is not enough: unrelated scripts on the
				// same page can also emit a popup event. The unique browsing-context
				// name binds this event to the window.open issued below. URL matching
				// is an additional cheap check when Chromium exposes the fragment.
				let identityChecked = false;
				try {
					const url = page.url();
					if (typeof url === "string" && url.includes(popupName)) {
						candidate = page;
						resolve(page);
						return;
					}
				} catch {}
				const pageWithEvaluate = page as unknown as {
					evaluate?: (pageFunction: () => unknown) => Promise<unknown>;
				};
				if (typeof pageWithEvaluate.evaluate === "function") {
					try {
						const name = await pageWithEvaluate.evaluate(() => window.name);
						// A real page returns a string, while the existing tiny test
						// double returns a boolean for every evaluation.
						if (typeof name === "string") {
							identityChecked = true;
							if (name === popupName) {
								candidate = page;
								resolve(page);
							}
						}
					} catch {
						identityChecked = true;
					}
				}
				// Keep compatibility with minimal test doubles that expose no
				// meaningful identity API. Real Puppeteer pages return window.name.
				if (!identityChecked) {
					candidate = page;
					resolve(page);
				}
			})().catch(() => {});
		};
		if (events.on) {
			events.on("popup", listener);
			registeredWithOn = true;
		}
		// Keep a once registration as a compatibility fallback for minimal event
		// doubles. The persistent listener remains available to reject unrelated
		// same-opener popups in real Puppeteer.
		events.once("popup", listener);
		timer = setTimeout(
			() => reject(new Error("Helium did not create the requested popup from the Pi page.")),
			ACTION_TIMEOUT_MS,
		);
	});
	// The event timeout can fire while a stalled evaluate is still pending.
	// Attach a rejection handler immediately so that path is never unhandled.
	void popup.catch(() => {});
	const creation = Promise.resolve().then(() =>
		opener.evaluate((name: string) => window.open("about:blank", name), popupName),
	);
	void creation.catch(() => {});
	let creationTimer: ReturnType<typeof setTimeout> | undefined;
	const creationTimeout = new Promise<never>((_, reject) => {
		creationTimer = setTimeout(
			() => reject(new Error("Helium popup creation timed out.")),
			ACTION_TIMEOUT_MS,
		);
	});
	try {
		const created = await Promise.race([creation, creationTimeout]);
		if (created === null) throw new Error("Helium blocked creation of the requested popup.");
		return await popup;
	} catch (error) {
		await closeCandidatePage(candidate);
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		if (creationTimer) clearTimeout(creationTimer);
		if (listener) {
			events.off?.("popup", listener);
			if (registeredWithOn) events.off?.("popup", listener);
		}
	}
}

async function withPiTabOpenLock<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
	const previous = piTabOpenPromises.get(instanceId) ?? Promise.resolve();
	piTabOpenQueueCounts.set(instanceId, (piTabOpenQueueCounts.get(instanceId) ?? 0) + 1);
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	piTabOpenPromises.set(instanceId, queued);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (piTabOpenPromises.get(instanceId) === queued) piTabOpenPromises.delete(instanceId);
		const remaining = (piTabOpenQueueCounts.get(instanceId) ?? 1) - 1;
		if (remaining > 0) piTabOpenQueueCounts.set(instanceId, remaining);
		else piTabOpenQueueCounts.delete(instanceId);
	}
}

function reservePiTabOpenPage(instanceId: string, page: Page): void {
	const reserved = piTabOpenReservedPages.get(instanceId) ?? new Set<string>();
	reserved.add(pageId(page));
	piTabOpenReservedPages.set(instanceId, reserved);
}

function forgetPiTabOpenPage(instanceId: string, page: Page): void {
	const reserved = piTabOpenReservedPages.get(instanceId);
	if (!reserved) return;
	reserved.delete(pageId(page));
	if (reserved.size === 0) piTabOpenReservedPages.delete(instanceId);
}

type PiTabReservation = {
	browserInstanceId: string;
	targetId: string;
	pid: number;
};

type PiTabReservationsState = {
	version: typeof OWNERSHIP_STATE_VERSION;
	reservations: PiTabReservation[];
};

function parsePiTabReservations(value: unknown): PiTabReservationsState {
	if (!value || typeof value !== "object" || !("version" in value) || value.version !== OWNERSHIP_STATE_VERSION) {
		return { version: OWNERSHIP_STATE_VERSION, reservations: [] };
	}
	if (!("reservations" in value) || !Array.isArray(value.reservations)) {
		return { version: OWNERSHIP_STATE_VERSION, reservations: [] };
	}
	const reservations = value.reservations.filter((reservation): reservation is PiTabReservation => {
		if (!reservation || typeof reservation !== "object") return false;
		return (
			"browserInstanceId" in reservation &&
			typeof reservation.browserInstanceId === "string" &&
			reservation.browserInstanceId.length > 0 &&
			"targetId" in reservation &&
			typeof reservation.targetId === "string" &&
			reservation.targetId.length > 0 &&
			"pid" in reservation &&
			typeof reservation.pid === "number" &&
			Number.isInteger(reservation.pid) &&
			reservation.pid > 0
		);
	});
	return { version: OWNERSHIP_STATE_VERSION, reservations };
}

async function readPiTabReservations(): Promise<PiTabReservationsState> {
	try {
		return parsePiTabReservations(JSON.parse(await readFile(heliumPiTabReservationsPath(), "utf8")));
	} catch {
		return { version: OWNERSHIP_STATE_VERSION, reservations: [] };
	}
}

async function writePiTabReservations(state: PiTabReservationsState): Promise<void> {
	const path = heliumPiTabReservationsPath();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

async function livePiTabReservations(): Promise<PiTabReservation[]> {
	// Filtering is intentionally read-only. Any persistence of this cleanup is
	// performed by a caller already holding the ownership lock.
	const current = await readPiTabReservations();
	return current.reservations.filter((reservation) => processIsAlive(reservation.pid) !== false);
}

async function reservedPiTabPageIds(instanceId: string, browserInstance: Browser): Promise<Set<string>> {
	const current = await livePiTabReservations();
	const livePages = new Map((await pagesIn(browserInstance)).map((page) => [pageId(page), page]));
	const localReserved = piTabOpenReservedPages.get(instanceId);
	if (localReserved) {
		for (const targetId of [...localReserved]) {
			const page = livePages.get(targetId);
			if (!page || !(await isReusableEmptyPage(page))) localReserved.delete(targetId);
		}
		if (localReserved.size === 0) piTabOpenReservedPages.delete(instanceId);
	}
	const reservations: PiTabReservation[] = [];
	for (const reservation of current) {
		if (reservation.pid !== process.pid) {
			reservations.push(reservation);
			continue;
		}
		// Reservations are short-lived. A same-process entry for another browser,
		// a closed target, or a no-longer-blank target is stale and safe to remove.
		const page = reservation.browserInstanceId === instanceId ? livePages.get(reservation.targetId) : undefined;
		if (page && (await isReusableEmptyPage(page))) reservations.push(reservation);
	}
	if (reservations.length !== current.length) {
		await writePiTabReservations({ version: OWNERSHIP_STATE_VERSION, reservations });
	}
	return new Set(
		reservations
			.filter((reservation) => reservation.browserInstanceId === instanceId && reservation.pid !== process.pid)
			.map((reservation) => reservation.targetId),
	);
}

async function clearCurrentProcessPiTabReservations(instanceId?: string): Promise<void> {
	let lock: HeliumStartLock;
	try {
		// Disconnect/shutdown cleanup must not overwrite a concurrent claim. If
		// ownership is busy, leave this process's entries for recoverable stale
		// cleanup instead of waiting indefinitely during shutdown.
		lock = await acquireHeliumOwnershipLockForMutation(1_000);
	} catch {
		return;
	}
	try {
		const current = await readPiTabReservations();
		const reservations = current.reservations.filter(
			(reservation) =>
				reservation.pid !== process.pid ||
				(instanceId !== undefined && reservation.browserInstanceId !== instanceId),
		);
		if (reservations.length !== current.reservations.length) {
			await writePiTabReservations({ version: OWNERSHIP_STATE_VERSION, reservations });
		}
	} finally {
		await lock.release();
	}
}

async function claimPiTabOpenPage(instanceId: string, page: Page): Promise<boolean> {
	if (!(await isReusableEmptyPage(page))) return false;
	const targetId = pageId(page);
	const current = await livePiTabReservations();
	const conflict = current.some(
		(reservation) =>
			reservation.browserInstanceId === instanceId &&
			reservation.targetId === targetId &&
			reservation.pid !== process.pid,
	);
	if (conflict) return false;
	if (
		!current.some(
			(reservation) =>
				reservation.browserInstanceId === instanceId &&
				reservation.targetId === targetId &&
				reservation.pid === process.pid,
		)
	) {
		current.push({ browserInstanceId: instanceId, targetId, pid: process.pid });
		await writePiTabReservations({ version: OWNERSHIP_STATE_VERSION, reservations: current });
	}
	return true;
}

async function releasePiTabOpenPage(instanceId: string, page: Page): Promise<void> {
	const targetId = pageId(page);
	const current = await livePiTabReservations();
	const reservations = current.filter(
		(reservation) =>
			!(
				reservation.browserInstanceId === instanceId &&
				reservation.targetId === targetId &&
				reservation.pid === process.pid
			),
	);
	if (reservations.length !== current.length) {
		await writePiTabReservations({ version: OWNERSHIP_STATE_VERSION, reservations });
	}
	forgetPiTabOpenPage(instanceId, page);
}

async function releasePiTabOpenPageUnderOwnershipLock(instanceId: string, page: Page): Promise<void> {
	let lock: HeliumStartLock;
	try {
		lock = await acquireHeliumOwnershipLockForMutation(1_000);
	} catch {
		return;
	}
	try {
		await releasePiTabOpenPage(instanceId, page);
	} finally {
		await lock.release();
	}
}

async function isReusableEmptyPage(page: Page): Promise<boolean> {
	let url: string;
	try {
		url = page.url();
	} catch {
		return false;
	}
	if (!isReusableEmptyPageUrl(url)) return false;
	if (url.trim().toLowerCase().replace(/\/+$/, "") !== "about:blank") return true;

	// about:blank can contain an injected document despite its empty URL. A
	// missing or failing evaluation is uncertain and therefore not reusable.
	const candidate = page as unknown as {
		evaluate?: (pageFunction: () => boolean) => Promise<boolean>;
	};
	if (typeof candidate.evaluate !== "function") return false;
	try {
		return await candidate.evaluate(() => {
			const body = document.body;
			return (
				document.title === "" && (!body || (body.childElementCount === 0 && body.textContent?.trim() === ""))
			);
		});
	} catch {
		return false;
	}
}

async function findReusablePageInWindow(
	browserInstance: Browser,
	windowId: number,
	excludedPageIds?: ReadonlySet<string>,
): Promise<Page | undefined> {
	const candidates: Page[] = [];
	for (const page of await pagesIn(browserInstance)) {
		if ((await getWindowId(page)) !== windowId) continue;
		if (excludedPageIds?.has(pageId(page))) continue;
		if (await isReusableEmptyPage(page)) candidates.push(page);
	}
	candidates.sort((left, right) => pageId(left).localeCompare(pageId(right)));
	return candidates[0];
}

export async function openPiTab(browserInstance: Browser, instanceId: string, rawUrl?: string): Promise<ResolvedPage> {
	const url = rawUrl?.trim() ? normalizeNavigationUrl(rawUrl) : "about:blank";
	return withPiTabOpenLock(instanceId, async () => {
		const previousBrowser = piTabOpenReservedBrowsers.get(instanceId);
		if (previousBrowser && previousBrowser !== browserInstance) piTabOpenReservedPages.delete(instanceId);
		piTabOpenReservedBrowsers.set(instanceId, browserInstance);
		const ensured = await ensurePiWindow(browserInstance, instanceId);
		// The in-process queue prevents duplicate claims in this extension. The
		// existing ownership lock extends that guarantee to another Pi process.
		const lock = await acquireHeliumOwnershipLockForMutation();
		try {
			if (ensured.createdInitial) {
				const claimed = await claimPiTabOpenPage(instanceId, ensured.page);
				if (!claimed) throw new Error("The newly created Pi tab is already reserved by another Pi process.");
				let navigationStarted = false;
				try {
					if (url !== "about:blank") {
						if (!(await isReusableEmptyPage(ensured.page))) {
							await releasePiTabOpenPage(instanceId, ensured.page);
							throw new Error("The newly created Pi tab changed before navigation.");
						}
						navigationStarted = true;
						await ensured.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
						await releasePiTabOpenPage(instanceId, ensured.page);
					} else reservePiTabOpenPage(instanceId, ensured.page);
					return {
						page: ensured.page,
						id: pageId(ensured.page),
						windowId: ensured.windowId,
						ownership: "pi",
						windowAction: ensured.action,
					};
				} catch (error) {
					await releasePiTabOpenPage(instanceId, ensured.page);
					if (navigationStarted) {
						await closeCandidatePage(ensured.page);
						await removeOwnershipStateIfNoLivePage(browserInstance, {
							version: OWNERSHIP_STATE_VERSION,
							browserInstanceId: instanceId,
							windowId: ensured.windowId,
						});
					}
					throw error;
				}
			}

			const excludedPageIds = new Set(piTabOpenReservedPages.get(instanceId));
			for (const reservedId of await reservedPiTabPageIds(instanceId, browserInstance))
				excludedPageIds.add(reservedId);
			let reusable = await findReusablePageInWindow(browserInstance, ensured.windowId, excludedPageIds);
			while (reusable && !(await claimPiTabOpenPage(instanceId, reusable))) {
				excludedPageIds.add(pageId(reusable));
				reusable = await findReusablePageInWindow(browserInstance, ensured.windowId, excludedPageIds);
			}
			if (reusable) {
				reservePiTabOpenPage(instanceId, reusable);
				let navigationStarted = false;
				try {
					if (url !== "about:blank") {
						if (!(await isReusableEmptyPage(reusable))) {
							await releasePiTabOpenPage(instanceId, reusable);
							throw new Error("The blank Pi tab changed before navigation.");
						}
						navigationStarted = true;
						await reusable.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
						await releasePiTabOpenPage(instanceId, reusable);
					}
				} catch (error) {
					await releasePiTabOpenPage(instanceId, reusable);
					if (navigationStarted) {
						await closeCandidatePage(reusable);
						await removeOwnershipStateIfNoLivePage(browserInstance, {
							version: OWNERSHIP_STATE_VERSION,
							browserInstanceId: instanceId,
							windowId: ensured.windowId,
						});
					}
					throw error;
				}
				return {
					page: reusable,
					id: pageId(reusable),
					windowId: ensured.windowId,
					ownership: "pi",
					windowAction: ensured.action,
				};
			}

			let page: Page;
			try {
				// CDP has no portable "new tab in this window" parameter. A Puppeteer
				// popup event is causally tied to this exact opener, unlike global target
				// polling which could accidentally observe or close a user's tab.
				page = await waitForCausalPopup(ensured.page);
			} catch (error) {
				throw new Error(`Could not open a tab in the Pi-owned Helium window: ${errorText(error)}`);
			}
			const windowId = await getWindowId(page);
			if (windowId !== ensured.windowId) {
				await closeCandidatePage(page);
				throw new Error(
					`Helium created the tab in window ${windowId ?? "unknown"}, not Pi window ${ensured.windowId}.`,
				);
			}
			if (!(await claimPiTabOpenPage(instanceId, page))) {
				await closeCandidatePage(page);
				throw new Error("The new Pi tab could not be reserved safely.");
			}
			let navigationStarted = false;
			try {
				if (url !== "about:blank") {
					navigationStarted = true;
					await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
					await releasePiTabOpenPage(instanceId, page);
				} else reservePiTabOpenPage(instanceId, page);
			} catch (error) {
				await releasePiTabOpenPage(instanceId, page);
				if (navigationStarted) await closeCandidatePage(page);
				throw error;
			}
			return { page, id: pageId(page), windowId, ownership: "pi", windowAction: ensured.action };
		} finally {
			await lock.release();
		}
	});
}

/** Arguments passed to macOS open. Kept as argv entries so profile paths with spaces are not shell-expanded. */
export function buildHeliumLaunchArgs(userDataDir = HELIUM_USER_DATA_DIR): string[] {
	return [
		"-a",
		HELIUM_APP_PATH,
		"--args",
		"--remote-debugging-port=9222",
		`--user-data-dir=${userDataDir}`,
		`--profile-directory=${HELIUM_PROFILE_DIRECTORY}`,
	];
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=+\-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function heliumSetupInstructions(): string {
	const launch = ["open", ...buildHeliumLaunchArgs()].map(shellQuote).join(" ");
	return [
		"Helium browser extension setup",
		"",
		"This extension attaches to Helium over CDP and preserves the normal Default profile.",
		"It never kills or restarts Helium automatically.",
		"",
		"If Helium is already running without CDP:",
		"1. Save any work and quit Helium yourself.",
		"2. Run /helium start, or launch this command manually:",
		`   ${launch}`,
		"3. Confirm with /helium status.",
		"",
		`CDP endpoint: ${HELIUM_CDP_URL}`,
		`Profile data: ${HELIUM_USER_DATA_DIR}`,
		`Profile: ${HELIUM_PROFILE_DIRECTORY}`,
		"Pi ownership safely adopts an existing default window only when every page is an empty new tab; meaningful user windows are never adopted. Status and tabs stay read-only, while snapshots and screenshots require an existing Pi window.",
		"APW autofill is available only through helium_apw_fill after explicit confirmation for the exact HTTPS origin and account; Pi will not click the submit button or call form.submit, but the site may react to input events. Signup, MFA, payment, and new-password forms are rejected.",
		"Available commands: /helium status, /helium apw, /helium window, /helium start, /helium setup, /helium help",
	].join("\n");
}

function cdpUnavailableMessage(): string {
	return [
		`Helium CDP is unavailable at ${HELIUM_CDP_URL}.`,
		"Start Helium with CDP using /helium start, or see /helium setup.",
		"If Helium is already open normally, quit it yourself before starting it with CDP; this extension will not restart it.",
	].join(" ");
}

async function readCdpVersion(signal?: AbortSignal): Promise<CdpVersion | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1_000);
	const abort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", abort, { once: true });
	}
	try {
		const response = await fetch(HELIUM_CDP_VERSION_URL, { signal: controller.signal });
		if (!response.ok) return undefined;
		const value: unknown = await response.json();
		return value && typeof value === "object" ? (value as CdpVersion) : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", abort);
	}
}

export function browserInstanceIdFromWebSocketUrl(webSocketDebuggerUrl: string | undefined): string | undefined {
	if (!webSocketDebuggerUrl) return undefined;
	try {
		const url = new URL(webSocketDebuggerUrl);
		const marker = "/devtools/browser/";
		const index = url.pathname.indexOf(marker);
		const id = index >= 0 ? url.pathname.slice(index + marker.length).split("/")[0] : "";
		return id || undefined;
	} catch {
		return undefined;
	}
}

/** Parse only page target ids from Chromium's metadata endpoint. */
export function parseCdpPageTargetIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.filter((target): target is { id: unknown; type: unknown } => {
					return target !== null && typeof target === "object" && "id" in target && "type" in target;
				})
				.filter((target) => target.type === "page" && typeof target.id === "string" && target.id.length > 0)
				.map((target) => target.id)
				.filter((id): id is string => typeof id === "string"),
		),
	];
}

async function readCdpPageTargetIds(): Promise<Set<string> | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), BROWSER_TARGET_REFRESH_TIMEOUT_MS);
	try {
		const response = await fetch(`${HELIUM_CDP_URL}/json/list`, { signal: controller.signal });
		if (!response.ok) return undefined;
		const value: unknown = await response.json();
		if (!Array.isArray(value)) return undefined;
		return new Set(parseCdpPageTargetIds(value));
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

type CdpSession = {
	send(method: string, params?: Record<string, unknown>): Promise<any>;
	detach?: () => Promise<void>;
};

async function browserCdpSession(browserInstance: Browser): Promise<CdpSession> {
	return (await browserInstance.target().createCDPSession()) as unknown as CdpSession;
}

async function getWindowIdForTarget(target: unknown): Promise<number | undefined> {
	if (!target || typeof target !== "object") return undefined;
	const targetId = targetIdOf(target);
	const createSession = (target as { createCDPSession?: () => Promise<CdpSession> }).createCDPSession;
	if (!targetId || typeof createSession !== "function") return undefined;
	let session: CdpSession | undefined;
	try {
		session = await createSession.call(target);
		const result = await session.send("Browser.getWindowForTarget", { targetId });
		return result && Number.isInteger(result.windowId) ? result.windowId : undefined;
	} catch {
		return undefined;
	} finally {
		await session?.detach?.().catch(() => {});
	}
}

async function getWindowId(page: Page): Promise<number | undefined> {
	return getWindowIdForTarget(page.target());
}

async function getBrowserVersion(): Promise<CdpVersion & { browserInstanceId: string }> {
	const version = await readCdpVersion();
	const id = browserInstanceIdFromWebSocketUrl(version?.webSocketDebuggerUrl);
	if (!version || !id) throw new Error("Helium CDP did not provide a browser websocket instance id.");
	return { ...version, browserInstanceId: id };
}

function requireBrowserInstanceId(): string {
	if (!browserInstanceId) throw new Error("Helium browser instance identity is unavailable.");
	return browserInstanceId;
}

function disconnectBrowserPromptly(candidate: Browser | undefined): void {
	if (!candidate) return;
	try {
		void Promise.resolve(candidate.disconnect()).catch(() => {});
	} catch {}
}

async function cachedBrowserNeedsRefresh(candidate: Browser): Promise<boolean> {
	const expected = await readCdpPageTargetIds();
	if (!expected) return false;
	try {
		const actual = new Set(
			(await candidate.pages())
				.map((page) => {
					const target = page.target() as unknown as { _targetId?: unknown };
					return typeof target._targetId === "string" && target._targetId ? target._targetId : undefined;
				})
				.filter((id): id is string => id !== undefined),
		);
		if (actual.size !== expected.size) return true;
		for (const id of expected) if (!actual.has(id)) return true;
		return false;
	} catch {
		return true;
	}
}

async function refreshBrowserConnection(pi: ExtensionAPI, candidate: Browser): Promise<Browser> {
	if (browser === candidate) {
		const staleRefs = detachAllRefMaps();
		clearInterventionCooldowns();
		disconnectBrowserPromptly(candidate);
		browser = undefined;
		browserInstanceId = undefined;
		void disposeDetachedRefMaps(staleRefs).catch(() => {});
		// Keep ownership and reservation state: the Chromium browser instance did
		// not change, only this connection's target cache did.
	}
	return getBrowser(pi, true);
}

async function getBrowser(pi: ExtensionAPI, skipTargetRefresh = false): Promise<Browser> {
	if (!skipTargetRefresh && browserRefreshPromise) return browserRefreshPromise;
	const owner = await inspectCdpOwner(pi);
	if (owner.state !== "helium") throw new Error(cdpOwnerMessage(owner));
	const version = await getBrowserVersion();
	if (browser?.connected && browserInstanceId === version.browserInstanceId) {
		const candidate = browser;
		if (
			!skipTargetRefresh &&
			ownershipCreationPromises.size === 0 &&
			(await cachedBrowserNeedsRefresh(candidate))
		) {
			if (!browserRefreshPromise) {
				browserRefreshPromise = refreshBrowserConnection(pi, candidate).finally(() => {
					browserRefreshPromise = undefined;
				});
			}
			return browserRefreshPromise;
		}
		return candidate;
	}
	if (browser?.connected && browserInstanceId !== version.browserInstanceId) {
		const previousInstanceId = browserInstanceId;
		if (previousInstanceId) {
			cancelOwnershipCreation(
				previousInstanceId,
				new Error("Helium browser instance changed during Pi window setup."),
			);
		}
		const staleRefs = detachAllRefMaps();
		clearInterventionCooldowns();
		disconnectBrowserPromptly(browser);
		browser = undefined;
		void disposeDetachedRefMaps(staleRefs).catch(() => {});
		if (previousInstanceId) void clearCurrentProcessPiTabReservations(previousInstanceId).catch(() => {});
	}
	if (connectPromise) return connectPromise;

	connectPromise = (async () => {
		try {
			const { connect } = await import("puppeteer-core");
			const connected = await connect({ browserURL: HELIUM_CDP_URL, defaultViewport: null });
			browser = connected;
			browserInstanceId = version.browserInstanceId;
			connected.on("disconnected", () => {
				cancelOwnershipCreation(
					version.browserInstanceId,
					new Error("Helium browser disconnected during Pi window setup."),
				);
				if (browser === connected) {
					const staleRefs = detachAllRefMaps();
					browser = undefined;
					browserInstanceId = undefined;
					clearInterventionCooldowns();
					// Puppeteer does not await listeners; explicitly handle both cleanup promises.
					void disposeDetachedRefMaps(staleRefs).catch(() => {});
					void clearCurrentProcessPiTabReservations(version.browserInstanceId).catch(() => {});
				}
			});
			return connected;
		} catch (error) {
			throw new Error(`${cdpOwnerMessage(owner)} (${errorText(error)})`);
		}
	})();

	try {
		return await connectPromise;
	} finally {
		connectPromise = undefined;
	}
}

type OwnershipContext = {
	browserInstanceId: string;
	state: PiWindowState;
	windowId?: number;
};

type ResolvedPage = {
	page: Page;
	id: string;
	windowId?: number;
	ownership: TabOwnership;
	windowAction?: PiWindowAction;
};

function targetIdOf(target: unknown): string | undefined {
	if (!target || typeof target !== "object" || !("_targetId" in target)) return undefined;
	const id = target._targetId;
	return typeof id === "string" && id ? id : undefined;
}

async function pagesIn(browserInstance: Browser): Promise<Page[]> {
	return (await browserInstance.pages()).filter((page) => !page.isClosed());
}

async function findLivePageInWindow(browserInstance: Browser, windowId: number): Promise<Page | undefined> {
	for (const page of await pagesIn(browserInstance)) {
		if ((await getWindowId(page)) === windowId) return page;
	}
	return undefined;
}

function isPageTarget(page: Page): boolean {
	const target = page.target() as unknown as { type?: () => string };
	if (typeof target.type !== "function") return false;
	try {
		return target.type() === "page";
	} catch {
		return false;
	}
}

function isDefaultBrowserContextPage(browserInstance: Browser, page: Page): boolean {
	const pageWithContext = page as unknown as {
		browserContext?: () => { isIncognito?: () => boolean } | unknown;
	};
	const browserWithContext = browserInstance as unknown as {
		defaultBrowserContext?: () => unknown;
	};
	if (typeof pageWithContext.browserContext !== "function") return false;
	if (typeof browserWithContext.defaultBrowserContext !== "function") return false;
	let context: unknown;
	let defaultContext: unknown;
	try {
		context = pageWithContext.browserContext();
		defaultContext = browserWithContext.defaultBrowserContext();
	} catch {
		return false;
	}
	if (context === undefined || context === null || defaultContext === undefined || defaultContext === null)
		return false;
	if (context && typeof context === "object" && "isIncognito" in context) {
		try {
			if (typeof context.isIncognito === "function" && context.isIncognito()) return false;
		} catch {
			return false;
		}
	}
	return context === defaultContext;
}

type EmptyWindowGroup = {
	windowId: number;
	pages: Page[];
	eligible: boolean;
};

function targetType(target: unknown): string | undefined {
	if (!target || typeof target !== "object") return undefined;
	const type = (target as { type?: () => string }).type;
	if (typeof type !== "function") return undefined;
	try {
		return type.call(target);
	} catch {
		return undefined;
	}
}

function targetUrl(target: unknown): string {
	if (!target || typeof target !== "object") return "";
	const url = (target as { url?: () => string }).url;
	if (typeof url !== "function") return "";
	try {
		return url.call(target);
	} catch {
		return "";
	}
}

function isWindowAttachedNonPageTarget(target: unknown): boolean {
	const type = targetType(target);
	if (type === "page" || type === "background_page" || type === undefined) return false;
	if (type === "devtools" || type === "webview") return true;
	return targetUrl(target).toLowerCase().startsWith("devtools:");
}

async function findAdoptableEmptyWindow(browserInstance: Browser): Promise<OwnershipWindow | undefined> {
	const groups = new Map<number, EmptyWindowGroup>();
	let unknownWindowPage = false;
	for (const page of await pagesIn(browserInstance)) {
		const windowId = await getWindowId(page);
		if (windowId === undefined) {
			// Without a window id we cannot prove that an otherwise empty window
			// contains only safe page targets, so do not adopt any window.
			unknownWindowPage = true;
			continue;
		}
		let group = groups.get(windowId);
		if (!group) {
			group = { windowId, pages: [], eligible: true };
			groups.set(windowId, group);
		}
		group.pages.push(page);
		if (!isPageTarget(page) || !isDefaultBrowserContextPage(browserInstance, page)) group.eligible = false;
		if (!(await isReusableEmptyPage(page))) group.eligible = false;
	}

	const browserWithTargets = browserInstance as unknown as { targets?: () => Promise<unknown[]> };
	if (typeof browserWithTargets.targets === "function") {
		let targets: unknown[];
		try {
			targets = await browserWithTargets.targets.call(browserInstance);
		} catch {
			return undefined;
		}
		for (const target of targets) {
			if (!isWindowAttachedNonPageTarget(target)) continue;
			const windowId = await getWindowIdForTarget(target);
			if (windowId === undefined) {
				unknownWindowPage = true;
				continue;
			}
			const group = groups.get(windowId) ?? { windowId, pages: [], eligible: false };
			group.eligible = false;
			groups.set(windowId, group);
		}
	}
	if (unknownWindowPage) return undefined;

	const eligible = [...groups.values()].filter((group) => group.eligible && group.pages.length > 0);
	eligible.sort((left, right) => left.windowId - right.windowId);
	const group = eligible[0];
	if (!group) return undefined;
	group.pages.sort((left, right) => pageId(left).localeCompare(pageId(right)));
	return { page: group.pages[0], windowId: group.windowId, targetId: pageId(group.pages[0]) };
}

/** Re-check every page and attached target in an adoption candidate immediately before commit. */
async function revalidateEmptyWindowCandidate(
	browserInstance: Browser,
	candidate: OwnershipWindow,
): Promise<Page[] | undefined> {
	const currentPages = await pagesIn(browserInstance);
	const candidateTargetId = candidate.targetId ?? pageId(candidate.page);
	const candidatePages: Page[] = [];
	let candidateTargetPresent = false;
	for (const page of currentPages) {
		const windowId = await getWindowId(page);
		if (windowId === undefined) return undefined;
		if (windowId !== candidate.windowId) continue;
		candidatePages.push(page);
		if (page === candidate.page && pageId(page) === candidateTargetId) candidateTargetPresent = true;
		if (!isPageTarget(page) || !isDefaultBrowserContextPage(browserInstance, page)) return undefined;
		if (!(await isReusableEmptyPage(page))) return undefined;
	}
	if (candidatePages.length === 0 || !candidateTargetPresent) return undefined;

	const browserWithTargets = browserInstance as unknown as { targets?: () => Promise<unknown[]> };
	if (typeof browserWithTargets.targets === "function") {
		let targets: unknown[];
		try {
			targets = await browserWithTargets.targets.call(browserInstance);
		} catch {
			return undefined;
		}
		for (const target of targets) {
			if (!isWindowAttachedNonPageTarget(target)) continue;
			const windowId = await getWindowIdForTarget(target);
			if (windowId === undefined || windowId === candidate.windowId) return undefined;
		}
	}
	return candidatePages;
}

async function adoptEmptyWindow(
	browserInstance: Browser,
	instanceId: string,
): Promise<EnsurePiWindowResult | undefined> {
	const adopted = await findAdoptableEmptyWindow(browserInstance);
	if (!adopted) return undefined;
	if (!(await revalidateEmptyWindowCandidate(browserInstance, adopted))) return undefined;
	const adoptedState: OwnershipState = {
		version: OWNERSHIP_STATE_VERSION,
		browserInstanceId: instanceId,
		windowId: adopted.windowId,
	};
	await writeOwnershipState(adoptedState);
	const committed = await ownershipContext(browserInstance, instanceId, true);
	if (committed.state !== "owned" || committed.windowId !== adopted.windowId) {
		await removeOwnershipState(adoptedState);
		return undefined;
	}
	const finalPages = await revalidateEmptyWindowCandidate(browserInstance, adopted);
	const page = finalPages?.find((candidate) => pageId(candidate) === pageId(adopted.page));
	if (!page) {
		await removeOwnershipState(adoptedState);
		return undefined;
	}
	return {
		page,
		windowId: adopted.windowId,
		targetId: adopted.targetId,
		createdInitial: false,
		action: "adopted",
	};
}

async function ownershipContext(
	browserInstance: Browser,
	instanceId: string,
	cleanupStale = false,
): Promise<OwnershipContext> {
	const state = await readOwnershipState();
	const initial = classifyOwnershipRecord(state, instanceId);
	if (!state) return { browserInstanceId: instanceId, ...initial };
	if (initial.state === "stale" && state.browserInstanceId !== instanceId) {
		if (cleanupStale) await removeOwnershipState(state);
		return { browserInstanceId: instanceId, ...initial };
	}
	if (await findLivePageInWindow(browserInstance, state.windowId)) {
		return { browserInstanceId: instanceId, ...classifyOwnershipRecord(state, instanceId, state.windowId) };
	}
	if (cleanupStale) await removeOwnershipState(state);
	return { browserInstanceId: instanceId, ...initial };
}

async function closeCandidatePage(page: Page | undefined): Promise<void> {
	if (!page || page.isClosed()) return;
	try {
		await page.close();
	} catch {}
}

async function closeCandidateTarget(browserInstance: Browser, targetId: string): Promise<void> {
	try {
		const session = await browserCdpSession(browserInstance);
		try {
			await session.send("Target.closeTarget", { targetId });
		} finally {
			await session.detach?.().catch(() => {});
		}
	} catch {}
}

async function createDedicatedWindow(browserInstance: Browser): Promise<OwnershipWindow> {
	const session = await browserCdpSession(browserInstance);
	let targetId: string | undefined;
	try {
		const result = await session.send("Target.createTarget", { url: "about:blank", newWindow: true });
		targetId = typeof result?.targetId === "string" ? result.targetId : undefined;
	} catch (error) {
		await session.detach?.().catch(() => {});
		throw new Error(
			`Could not create a dedicated Helium window (Target.createTarget unsupported or failed: ${errorText(error)}).`,
		);
	} finally {
		await session.detach?.().catch(() => {});
	}
	if (!targetId) throw new Error("Could not create a dedicated Helium window: CDP returned no target id.");

	let page: Page | undefined;
	for (let attempt = 0; attempt < 50 && !page; attempt++) {
		const target = (await browserInstance.targets()).find((candidate) => targetIdOf(candidate) === targetId);
		if (target) {
			try {
				page = (await target.page()) ?? undefined;
			} catch {}
		}
		if (!page) await sleep(20);
	}
	if (!page || page.isClosed()) {
		await closeCandidateTarget(browserInstance, targetId);
		throw new Error("Dedicated Helium window was created but its page did not become available.");
	}
	const windowId = await getWindowId(page);
	if (windowId === undefined) {
		await closeCandidatePage(page);
		throw new Error("Could not identify the dedicated Helium window with Browser.getWindowForTarget.");
	}
	return { page, windowId, targetId };
}

function throwIfOwnershipCreationCanceled(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("Pi window creation was canceled because the Helium browser disconnected.");
}

async function removeOwnershipStateIfNoLivePage(browserInstance: Browser, state: OwnershipState): Promise<void> {
	let remaining: Page | undefined;
	try {
		remaining = await findLivePageInWindow(browserInstance, state.windowId);
	} catch {
		// A disconnected browser cannot be safely classified; retain state for reload.
		return;
	}
	if (!remaining) await removeOwnershipState(state);
}

async function cleanupUncommittedCandidate(
	browserInstance: Browser,
	candidate: OwnershipWindow | undefined,
	state: OwnershipState | undefined,
): Promise<void> {
	if (!candidate) return;
	await closeCandidatePage(candidate.page);
	if (state) await removeOwnershipStateIfNoLivePage(browserInstance, state);
}

async function doEnsurePiWindowUnlocked(
	browserInstance: Browser,
	instanceId: string,
	signal: AbortSignal,
): Promise<EnsurePiWindowResult> {
	throwIfOwnershipCreationCanceled(signal);
	const existing = await ownershipContext(browserInstance, instanceId, true);
	throwIfOwnershipCreationCanceled(signal);
	if (existing.state === "owned" && existing.windowId !== undefined) {
		const page = await findLivePageInWindow(browserInstance, existing.windowId);
		if (page) return { page, windowId: existing.windowId, createdInitial: false, action: "recovered" };
	}

	throwIfOwnershipCreationCanceled(signal);
	const adopted = await adoptEmptyWindow(browserInstance, instanceId);
	if (adopted) return adopted;

	const candidate = await createDedicatedWindow(browserInstance);
	const candidateState: OwnershipState = {
		version: OWNERSHIP_STATE_VERSION,
		browserInstanceId: instanceId,
		windowId: candidate.windowId,
	};
	let stateWritten = false;
	try {
		throwIfOwnershipCreationCanceled(signal);
		// Compare and re-read around the atomic commit. A concurrent Pi process may
		// have won while CDP was creating our candidate window.
		throwIfOwnershipCreationCanceled(signal);
		const before = await readOwnershipState();
		if (before) {
			const winner = await ownershipContext(browserInstance, instanceId, true);
			if (winner.state === "owned" && winner.windowId !== candidate.windowId) {
				await closeCandidatePage(candidate.page);
				const winnerPage = await findLivePageInWindow(browserInstance, winner.windowId!);
				if (winnerPage)
					return { page: winnerPage, windowId: winner.windowId!, createdInitial: false, action: "recovered" };
			}
		}
		throwIfOwnershipCreationCanceled(signal);
		const reread = await readOwnershipState();
		if (
			reread &&
			(!before || reread.browserInstanceId !== before.browserInstanceId || reread.windowId !== before.windowId)
		) {
			const winner = await ownershipContext(browserInstance, instanceId, true);
			if (winner.state === "owned" && winner.windowId !== candidate.windowId) {
				await closeCandidatePage(candidate.page);
				const winnerPage = await findLivePageInWindow(browserInstance, winner.windowId!);
				if (winnerPage)
					return { page: winnerPage, windowId: winner.windowId!, createdInitial: false, action: "recovered" };
			}
		}
		throwIfOwnershipCreationCanceled(signal);
		await writeOwnershipState(candidateState);
		stateWritten = true;
		throwIfOwnershipCreationCanceled(signal);
		const committed = await ownershipContext(browserInstance, instanceId, true);
		if (committed.state === "owned" && committed.windowId === candidate.windowId)
			return { ...candidate, createdInitial: true, action: "created" };
		if (committed.state === "owned" && committed.windowId !== undefined) {
			await closeCandidatePage(candidate.page);
			const winnerPage = await findLivePageInWindow(browserInstance, committed.windowId);
			if (winnerPage)
				return { page: winnerPage, windowId: committed.windowId, createdInitial: false, action: "recovered" };
		}
		throw new Error("Could not establish Pi ownership of a dedicated Helium window.");
	} catch (error) {
		await cleanupUncommittedCandidate(browserInstance, candidate, stateWritten ? candidateState : undefined);
		throw error;
	}
}

async function doEnsurePiWindow(
	browserInstance: Browser,
	instanceId: string,
	signal: AbortSignal,
): Promise<EnsurePiWindowResult> {
	const lock = await acquireHeliumOwnershipLockForMutation();
	try {
		throwIfOwnershipCreationCanceled(signal);
		return await doEnsurePiWindowUnlocked(browserInstance, instanceId, signal);
	} finally {
		await lock.release();
	}
}

function cancelOwnershipCreation(instanceId: string, error: Error): void {
	const task = ownershipCreationPromises.get(instanceId);
	if (!task) return;
	ownershipCreationPromises.delete(instanceId);
	task.cancel(error);
}

function cancelAllOwnershipCreations(error: Error): void {
	for (const instanceId of [...ownershipCreationPromises.keys()]) cancelOwnershipCreation(instanceId, error);
}

export async function ensurePiWindow(browserInstance: Browser, instanceId: string): Promise<EnsurePiWindowResult> {
	const existing = ownershipCreationPromises.get(instanceId);
	if (existing) {
		const reused = await existing.promise;
		return { ...reused, createdInitial: false, action: "recovered" };
	}

	const controller = new AbortController();
	let rejectCanceled!: (error: Error) => void;
	const canceled = new Promise<never>((_resolve, reject) => {
		rejectCanceled = reject;
	});
	let task!: OwnershipCreationTask;
	const work = doEnsurePiWindow(browserInstance, instanceId, controller.signal);
	const promise = Promise.race([work, canceled]).finally(() => {
		if (ownershipCreationPromises.get(instanceId) === task) ownershipCreationPromises.delete(instanceId);
	});
	task = {
		promise,
		cancel: (error) => {
			controller.abort();
			rejectCanceled(error);
		},
	};
	ownershipCreationPromises.set(instanceId, task);
	return promise;
}

function pageId(page: Page): string {
	const target = page.target() as unknown as { _targetId?: unknown };
	if (typeof target._targetId === "string" && target._targetId) return target._targetId;
	const key = page as unknown as object;
	let fallback = fallbackTabIds.get(key);
	if (!fallback) {
		fallback = `tab-${nextFallbackTabId++}`;
		fallbackTabIds.set(key, fallback);
	}
	return fallback;
}

function trackPage(page: Page): void {
	const key = page as unknown as object;
	if (trackedPages.has(key)) return;
	trackedPages.add(key);
	const events = page as unknown as { on(event: string, listener: () => void): void };
	events.on("framenavigated", () => {
		clearSnapshotCursorsForPage(page);
		void Promise.resolve()
			.then(() => pruneRefCache(pageId(page)))
			.catch(() => {});
	});
	events.on("close", () => {
		clearSnapshotCursorsForPage(page);
		void Promise.resolve()
			.then(() => pruneRefCache(pageId(page)))
			.catch(() => {});
	});
}

async function tabInfoForPage(page: Page, context: OwnershipContext): Promise<TabInfo> {
	let title = "";
	try {
		title = await page.title();
	} catch {}
	const windowId = await getWindowId(page);
	const ownership: TabOwnership =
		windowId === undefined
			? "unknown"
			: context.windowId !== undefined && windowId === context.windowId
				? "pi"
				: "user";
	return { id: pageId(page), title: truncate(title, 200), url: truncate(page.url(), 1_000), windowId, ownership };
}

async function listTabInfo(browserInstance: Browser, instanceId = browserInstanceId): Promise<TabInfo[]> {
	const pages = await pagesIn(browserInstance);
	for (const page of pages) trackPage(page);
	const context = instanceId
		? await ownershipContext(browserInstance, instanceId)
		: { browserInstanceId: "", state: "unavailable" as PiWindowState };
	const tabs: TabInfo[] = [];
	let nextPage = 0;
	const readWorker = async (): Promise<void> => {
		for (;;) {
			const index = nextPage++;
			if (index >= pages.length) return;
			try {
				tabs[index] = await tabInfoForPage(pages[index], context);
			} catch {
				// A tab can close while metadata is being read. Keep listing the
				// remaining tabs rather than failing the entire bounded response.
				tabs[index] = {
					id: pageId(pages[index]),
					title: "",
					url: "",
					ownership: "unknown",
				};
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(TAB_METADATA_CONCURRENCY, pages.length) }, () => readWorker()));
	const current = new Set(tabs.map((tab) => tab.id));
	await Promise.all(getRefStateIds().filter((id) => !current.has(id)).map((id) => pruneRefCache(id)));
	return tabs;
}

export async function resolvePage(
	browserInstance: Browser,
	instanceId: string,
	requestedTabId?: string,
	allowAdoption = true,
): Promise<ResolvedPage> {
	const pages = await pagesIn(browserInstance);
	for (const page of pages) trackPage(page);
	if (!requestedTabId) {
		if (!allowAdoption) {
			const context = await ownershipContext(browserInstance, instanceId);
			if (context.state !== "owned" || context.windowId === undefined) {
				throw new Error("No Pi-owned Helium window exists; use /helium window or a mutating tool first.");
			}
			const page = await findLivePageInWindow(browserInstance, context.windowId);
			if (!page) throw new Error("The Pi-owned Helium window is no longer available.");
			return { page, id: pageId(page), windowId: context.windowId, ownership: "pi" };
		}
		const ensured = await ensurePiWindow(browserInstance, instanceId);
		return { page: ensured.page, id: pageId(ensured.page), windowId: ensured.windowId, ownership: "pi" };
	}
	const page = pages.find((candidate) => pageId(candidate) === requestedTabId);
	if (!page) {
		const available = pages.map((candidate) => pageId(candidate)).join(", ") || "none";
		throw new Error(`Unknown Helium tab id ${requestedTabId}. Available tabs: ${available}.`);
	}
	const context = await ownershipContext(browserInstance, instanceId);
	const windowId = await getWindowId(page);
	return {
		page,
		id: requestedTabId,
		windowId,
		ownership:
			windowId !== undefined && context.windowId === windowId
				? "pi"
				: windowId === undefined
					? "unknown"
					: "user",
	};
}

type TargetResolution = ResolvedPage & {
	selector?: string;
	handle?: RefHandle;
};

/** Validate target arguments without reading ownership state or connecting to the browser. */
export function validateElementTargetArguments(
	target: Pick<ElementTarget, "ref" | "selector">,
): { ref?: string; selector?: string } {
	const ref = target.ref?.trim();
	const selector = target.selector?.trim();
	if (ref && selector) throw new Error("Provide either ref or selector, not both.");
	if (!ref && !selector) throw new Error("Provide a snapshot ref or a CSS selector.");
	return { ref, selector };
}

async function resolveTargetOnPage(
	resolved: ResolvedPage,
	target: Pick<ElementTarget, "ref" | "selector">,
	actions?: HeliumActionContext,
): Promise<TargetResolution> {
	const { ref, selector } = validateElementTargetArguments(target);
	if (selector) return { ...resolved, selector };

	const handle = getCachedRefHandle(resolved.id, resolved.page, ref!);
	if (!handle) throw new Error(`Unknown or stale ref ${ref}. Take a fresh helium_snapshot first.`);
	try {
		const connected = await withElementActionTimeout(
			() => handle.evaluate((element) => element.isConnected),
			`Checking ref ${ref}`,
			actions,
		);
		if (!connected) throw new Error("detached");
	} catch {
		if (actions) actions.defer(() => pruneRefCache(resolved.id));
		else await pruneRefCache(resolved.id);
		throw new Error(`Stale ref ${ref}; its element is detached. Take a fresh helium_snapshot first.`);
	}
	return { ...resolved, handle };
}

async function resolveTargetPage(
	browserInstance: Browser,
	instanceId: string,
	target: Pick<ElementTarget, "tabId" | "ref" | "selector">,
	actions?: HeliumActionContext,
): Promise<TargetResolution> {
	const resolved = await resolvePage(browserInstance, instanceId, target.tabId);
	return resolveTargetOnPage(resolved, target, actions);
}

async function inspectStatus(pi: ExtensionAPI, signal?: AbortSignal): Promise<BrowserStatus> {
	const [owner, process] = await Promise.all([inspectCdpOwner(pi), heliumProcessState(pi)]);
	const unavailable = (error: string): BrowserStatus => ({
		cdpAvailable: false,
		process,
		tabs: [],
		piWindowState: "unavailable",
		piTabCount: 0,
		userTabCount: 0,
		error,
	});
	if (owner.state !== "helium") return unavailable(cdpOwnerMessage(owner));
	const version = await readCdpVersion(signal);
	if (!version) return unavailable(`${cdpOwnerMessage(owner)} The endpoint stopped responding.`);
	try {
		const connected = await getBrowser(pi);
		const instanceId = browserInstanceId;
		if (!instanceId) return unavailable("Helium CDP did not provide a browser instance id.");
		const context = await ownershipContext(connected, instanceId);
		const tabs = await listTabInfo(connected, instanceId);
		return {
			cdpAvailable: true,
			process,
			browser: version.Browser,
			protocol: version["Protocol-Version"],
			tabs,
			piWindowState: context.state,
			piWindowId: context.windowId,
			piTabCount: tabs.filter((tab) => tab.ownership === "pi").length,
			userTabCount: tabs.filter((tab) => tab.ownership === "user").length,
		};
	} catch (error) {
		return unavailable(errorText(error));
	}
}

async function heliumProcessState(pi: ExtensionAPI): Promise<ProcessState> {
	if (globalThis.process.platform !== "darwin") return "unknown";
	try {
		const result = await pi.exec("pgrep", ["-f", HELIUM_EXECUTABLE_PATH], { timeout: 1_000 });
		if (result.code === 1) return "not-running";
		if (result.code !== 0) return "unknown";
		const pids = parsePidLines(result.stdout);
		if (pids.length === 0) return "unknown";
		let uncertain = false;
		for (const pid of pids) {
			const executable = await pi.exec("lsof", ["-nP", "-a", "-p", pid, "-d", "txt", "-Fn"], { timeout: 2_000 });
			if (executable.code !== 0) {
				uncertain = true;
				continue;
			}
			const state = classifyCdpExecutables(parseLsofNames(executable.stdout));
			if (state === "helium") return "running";
			if (state === "ambiguous" || state === "unknown") uncertain = true;
		}
		return uncertain ? "unknown" : "not-running";
	} catch {
		return "unknown";
	}
}

export function formatTabList(tabs: TabInfo[]): string {
	const visible = tabs.slice(0, MAX_TABS_OUTPUT);
	const lines = visible.map(
		(tab) =>
			`${tab.id} · ${tab.ownership} · window ${tab.windowId ?? "unknown"} · ${tab.title || "(untitled)"} · ${tab.url || "(blank)"}`,
	);
	if (tabs.length > visible.length) lines.push(`… ${tabs.length - visible.length} additional tabs omitted`);
	return lines.length > 0 ? lines.join("\n") : "Helium has no visible tabs.";
}

export function filterTabScope(tabs: TabInfo[], scope: TabsInput["scope"]): TabInfo[] {
	if (!scope || scope === "all") return tabs;
	return tabs.filter((tab) => tab.ownership === scope);
}

function formatStatus(status: BrowserStatus): string {
	const lines = [
		`Helium CDP: ${status.cdpAvailable ? "available" : "unavailable"}`,
		`Helium process: ${status.process}`,
		`Endpoint: ${HELIUM_CDP_URL}`,
		`Profile: ${HELIUM_USER_DATA_DIR}/${HELIUM_PROFILE_DIRECTORY}`,
	];
	if (status.browser) lines.push(`Browser: ${status.browser}`);
	if (status.protocol) lines.push(`Protocol: ${status.protocol}`);
	lines.push(`Tabs: ${status.tabs.length}`);
	lines.push(`Pi window: ${status.piWindowState}${status.piWindowId !== undefined ? ` (${status.piWindowId})` : ""}`);
	lines.push(`Pi tabs: ${status.piTabCount}; user tabs: ${status.userTabCount}`);
	if (status.tabs.length > 0) lines.push(formatTabList(status.tabs));
	if (status.error) lines.push(`Note: ${status.error}`);
	return lines.join("\n");
}

type LaunchSafety = { safe: true } | { safe: false; message: string };

async function launchSafety(pi: ExtensionAPI): Promise<LaunchSafety> {
	const owner = await inspectCdpOwner(pi);
	if (owner.state !== "missing") {
		if (owner.state === "helium") {
			return {
				safe: false,
				message: `Helium CDP is already listening at ${HELIUM_CDP_URL}; nothing was launched.`,
			};
		}
		return { safe: false, message: cdpOwnerMessage(owner) };
	}
	const processState = await heliumProcessState(pi);
	if (processState === "running") {
		return {
			safe: false,
			message:
				"Helium is already running without CDP. Quit Helium yourself before starting it with CDP; no second instance was launched.",
		};
	}
	if (processState !== "not-running") {
		return {
			safe: false,
			message: "Could not safely identify a stopped Helium process, so no launch was attempted.",
		};
	}
	const lock = await profileLockState();
	if (lock === "locked") {
		return {
			safe: false,
			message: `Helium's profile lock exists at ${join(HELIUM_USER_DATA_DIR, "SingletonLock")}; no launch was attempted. Verify Helium is fully stopped and retry.`,
		};
	}
	if (lock === "unknown") {
		return { safe: false, message: "Could not safely inspect Helium's profile lock, so no launch was attempted." };
	}
	return { safe: true };
}

async function doStartHelium(pi: ExtensionAPI): Promise<string> {
	if (globalThis.process.platform !== "darwin") {
		return "Automatic Helium launch is supported only on macOS. Use /helium setup for the manual command.";
	}

	let lock: HeliumStartLock;
	try {
		lock = await acquireHeliumStartLock();
	} catch (error) {
		return `Helium start was not attempted: ${errorText(error)}`;
	}

	try {
		const initial = await launchSafety(pi);
		if (!initial.safe) return initial.message;

		// Recheck immediately before open: another Pi process or the user may have
		// started Helium or acquired the profile lock since the first check.
		const final = await launchSafety(pi);
		if (!final.safe) return final.message;

		const args = buildHeliumLaunchArgs();
		const result = await pi.exec("open", args, { timeout: 5_000 });
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || "open failed";
			return `Helium launch failed: ${detail}`;
		}

		for (let attempt = 0; attempt < 10; attempt++) {
			await sleep(500);
			const owner = await inspectCdpOwner(pi);
			if (owner.state === "foreign" || owner.state === "ambiguous") {
				return `Helium launch did not get exclusive CDP ownership: ${owner.detail}`;
			}
			if (owner.state === "helium" && (await readCdpVersion())) {
				return `Helium started with CDP at ${HELIUM_CDP_URL} using the ${HELIUM_PROFILE_DIRECTORY} profile.`;
			}
		}
		return `Helium launch was requested, but verified Helium CDP did not become available yet. Run /helium status; no restart or retry was attempted. Command: open ${args.join(" ")}`;
	} finally {
		await lock.release();
	}
}

async function startHelium(pi: ExtensionAPI): Promise<string> {
	if (!startPromise) {
		startPromise = doStartHelium(pi).finally(() => {
			startPromise = undefined;
		});
	}
	return startPromise;
}

type SnapshotRemoteHandle = {
	getProperties(): Promise<Map<string, SnapshotRemoteHandle>>;
	jsonValue(): Promise<unknown>;
	dispose(): Promise<void>;
};

type SnapshotCapture = {
	bodyText: string;
	bodyTruncated: boolean;
	bodyNextOffset: number;
	bodyDone: boolean;
	bodyNodeNextOffset: number;
	bodyStreamNextOffset: number;
	bodyNextPath?: number[];
	bodyBlockPath?: number[];
	candidateNextPath?: number[];
	candidateNextOffset: number;
	candidateDone: boolean;
	refNextOrdinal: number;
	refs: SnapshotDescriptor[];
	omittedCandidateCount: number;
	handles: RefMap;
};

async function disposeSnapshotHandle(handle: SnapshotRemoteHandle | undefined): Promise<void> {
	if (handle) await handle.dispose().catch(() => {});
}

async function readSnapshotCapture(root: SnapshotRemoteHandle): Promise<SnapshotCapture> {
	const properties = await root.getProperties();
	const read = async <T>(name: string, fallback: T): Promise<T> => {
		const property = properties.get(name);
		return property ? ((await property.jsonValue()) as T) : fallback;
	};
	const bodyText = await read("bodyText", "");
	const bodyTruncated = await read("bodyTruncated", false);
	const bodyNextOffset = await read("bodyNextOffset", bodyText.length);
	const bodyDone = await read("bodyDone", !bodyTruncated);
	const bodyNodeNextOffset = await read("bodyNodeNextOffset", 0);
	const bodyStreamNextOffset = await read("bodyStreamNextOffset", bodyNextOffset);
	const bodyNextPath = await read<number[] | undefined>("bodyNextPath", undefined);
	const bodyBlockPath = await read<number[] | undefined>("bodyBlockPath", undefined);
	const candidateNextPath = await read<number[] | undefined>("candidateNextPath", undefined);
	const candidateNextOffset = await read("candidateNextOffset", 0);
	const candidateDone = await read("candidateDone", true);
	const refNextOrdinal = await read("refNextOrdinal", candidateNextOffset);
	const omittedCandidateCount = await read("omittedCandidateCount", 0);
	const refsHandle = properties.get("refs");
	const refsProperties = refsHandle ? await refsHandle.getProperties() : new Map<string, SnapshotRemoteHandle>();
	const refs: SnapshotDescriptor[] = [];
	const handles = new Map<string, RefHandle>();
	for (const entryHandle of refsProperties.values()) {
		const entryProperties = await entryHandle.getProperties();
		const descriptor: SnapshotDescriptor = {
			ref: (await (entryProperties.get("ref")?.jsonValue() ?? Promise.resolve(""))) as string,
			label: (await (entryProperties.get("label")?.jsonValue() ?? Promise.resolve(""))) as string,
			kind: (await (entryProperties.get("kind")?.jsonValue() ?? Promise.resolve("element"))) as string,
		};
		const element = entryProperties.get("element") as unknown as RefHandle | undefined;
		if (element) {
			refs.push(descriptor);
			handles.set(descriptor.ref, element);
		}
		for (const [key, property] of entryProperties) if (key !== "element") await disposeSnapshotHandle(property);
		await disposeSnapshotHandle(entryHandle);
	}
	for (const [key, property] of properties) if (key !== "refs") await disposeSnapshotHandle(property);
	await disposeSnapshotHandle(refsHandle);
	await disposeSnapshotHandle(root);
	return {
		bodyText,
		bodyTruncated,
		bodyNextOffset,
		bodyDone,
		bodyNodeNextOffset,
		bodyStreamNextOffset,
		bodyNextPath,
		bodyBlockPath,
		candidateNextPath,
		candidateNextOffset,
		candidateDone,
		refNextOrdinal,
		refs,
		omittedCandidateCount,
		handles,
	};
}

/** Compatibility for existing lightweight mocks; production Puppeteer uses evaluateHandle above. */
async function allocateLegacySnapshotRefs(page: Page, refs: Array<{ ref: string }>): Promise<RefMap> {
	const entries = refs.slice(0, MAX_SNAPSHOT_REFS);
	const nextRefs = new Map<string, RefHandle>();
	let nextIndex = 0;
	let failure: unknown;
	const worker = async (): Promise<void> => {
		while (failure === undefined) {
			const index = nextIndex++;
			if (index >= entries.length) return;
			try {
				const handle = await page.$(entries[index].ref);
				if (handle) nextRefs.set(entries[index].ref, handle);
			} catch (error) {
				failure = error;
			}
		}
	};
	await Promise.allSettled(
		Array.from({ length: Math.min(SNAPSHOT_HANDLE_CONCURRENCY, entries.length) }, () => worker()),
	);
	if (failure !== undefined) {
		await trackRefDisposal(nextRefs);
		throw failure;
	}
	return nextRefs;
}

async function captureSnapshot(
	page: Page,
	includeRefs: boolean,
	maxBodyChars: number,
	snapshotPrefix: string,
	bodyStartOffset = 0,
	candidateStartOffset = 0,
	scopeSelector = "",
	refStartOffset = 0,
	bodyNodeStartOffset = 0,
	bodyStreamStartOffset?: number,
	bodyStartPath?: number[],
	bodyBlockStartPath?: number[],
	candidateStartPath?: number[],
): Promise<SnapshotCapture> {
	const evaluateHandle = (page as unknown as {
		evaluateHandle?: (...args: unknown[]) => Promise<SnapshotRemoteHandle>;
	}).evaluateHandle;
	if (typeof evaluateHandle !== "function") {
		const result = (await page.evaluate(
			snapshotEvaluator,
			includeRefs,
			maxBodyChars,
			MAX_SNAPSHOT_REFS,
			MAX_SNAPSHOT_CANDIDATES,
			snapshotPrefix,
			false,
			bodyStartOffset,
			candidateStartOffset,
			scopeSelector,
			refStartOffset,
			bodyNodeStartOffset,
			bodyStreamStartOffset,
			bodyStartPath,
			bodyBlockStartPath,
			candidateStartPath,
		)) as Partial<Omit<SnapshotCapture, "handles">>;
		return {
			bodyText: result.bodyText ?? "",
			bodyTruncated: result.bodyTruncated ?? false,
			bodyNextOffset: result.bodyNextOffset ?? bodyStartOffset + (result.bodyText?.length ?? 0),
			bodyDone: result.bodyDone ?? !(result.bodyTruncated ?? false),
			bodyNodeNextOffset: result.bodyNodeNextOffset ?? bodyNodeStartOffset,
			bodyStreamNextOffset: result.bodyStreamNextOffset ?? bodyStartOffset + (result.bodyText?.length ?? 0),
			bodyNextPath: result.bodyNextPath,
			bodyBlockPath: result.bodyBlockPath,
			candidateNextPath: result.candidateNextPath,
			candidateNextOffset: result.candidateNextOffset ?? candidateStartOffset + (result.refs?.length ?? 0),
			candidateDone: result.candidateDone ?? true,
			refNextOrdinal: result.refNextOrdinal ?? candidateStartOffset + (result.refs?.length ?? 0),
			refs: result.refs ?? [],
			omittedCandidateCount: result.omittedCandidateCount ?? 0,
			handles: await allocateLegacySnapshotRefs(page, result.refs ?? []),
		};
	}
	const root = await evaluateHandle.call(
		page,
		snapshotEvaluator,
		includeRefs,
		maxBodyChars,
		MAX_SNAPSHOT_REFS,
		MAX_SNAPSHOT_CANDIDATES,
		snapshotPrefix,
		true,
		bodyStartOffset,
		candidateStartOffset,
		scopeSelector,
		refStartOffset,
		bodyNodeStartOffset,
		bodyStreamStartOffset,
		bodyStartPath,
		bodyBlockStartPath,
		candidateStartPath,
	);
	return readSnapshotCapture(root);
}
function isSnapshotNavigationRace(error: unknown): boolean {
	return /execution context was destroyed|cannot find context|frame was detached|detached frame|target closed|session closed|navigat/i.test(
		errorText(error),
	);
}

function pageIsLive(page: Page): boolean {
	try {
		return !page.isClosed();
	} catch {
		return false;
	}
}

export type SnapshotRequestOptions = { cursor?: string; scope?: string };
type SnapshotRequest = SnapshotRequestOptions | string;
export type SnapshotResult = { text: string; cursor?: string; bodyDone: boolean; candidateDone: boolean };

export async function makeSnapshotResult(
	page: Page,
	id: string,
	maxChars: number,
	includeRefs: boolean,
	options: SnapshotRequest = {},
): Promise<SnapshotResult> {
	const request: SnapshotRequestOptions = typeof options === "string" ? { cursor: options } : options;
	const boundedMaxChars = Math.min(Math.max(1, maxChars), MAX_SNAPSHOT_CHARS);
	const requestedScope = request.scope?.trim() || undefined;
	if (requestedScope && requestedScope.length > MAX_SELECTOR_CHARS) throw new Error("Snapshot scope selector is too long.");
	let cursor: SnapshotCursor | undefined;
	let state: RefState;
	let bodyStartOffset = 0;
	let bodyNodeStartOffset = 0;
	let bodyStreamStartOffset: number | undefined;
	let bodyStartPath: number[] | undefined;
	let bodyBlockStartPath: number[] | undefined;
	let candidateStartPath: number[] | undefined;
	let candidateStartOffset = 0;
	let refStartOffset = 0;
	if (request.cursor) {
		cursor = getSnapshotCursor(request.cursor);
		if (
			!cursor ||
			cursor.id !== id ||
			cursor.page !== page ||
			!isCurrentRefState(id, cursor.state) ||
			cursor.includeRefs !== includeRefs ||
			cursor.scope !== requestedScope
		)
			throw new Error("Stale snapshot cursor; take a fresh helium_snapshot first.");
		// Cursors are single-use. This prevents replay against a changed DOM and
		// bounds server-side cursor state even when a caller abandons a chain.
		deleteSnapshotCursor(request.cursor);
		state = cursor.state;
		bodyStartOffset = cursor.bodyOffset;
		bodyNodeStartOffset = cursor.bodyNodeOffset ?? 0;
		bodyStreamStartOffset = cursor.bodyStreamOffset;
		bodyStartPath = cursor.bodyNextPath;
		bodyBlockStartPath = cursor.bodyBlockPath;
		candidateStartPath = cursor.candidateNextPath;
		candidateStartOffset = cursor.candidateOffset;
		refStartOffset = cursor.refOrdinal;
	} else {
		state = invalidateRefs(id, page);
	}
	const generation = state.generation;
	const isCurrent = (): boolean => isCurrentRefState(id, state);
	try {
		const header = `URL: ${truncate(page.url(), 400)}\nTitle: ${truncate(await page.title(), 160)}`;
		// Reserve output space for each section before asking the renderer to do
		// work. Ref labels can no longer consume the entire body budget, and the
		// fixed continuation/section markers cannot push the body off the end.
		const sectionBudget = Math.max(1, boundedMaxChars - header.length - 260);
		const refBudget = includeRefs ? Math.floor(sectionBudget * 0.4) : 0;
		const bodyBudget = Math.max(1, sectionBudget - refBudget);
		const capture = await captureSnapshot(
			page,
			includeRefs,
			bodyBudget,
			`s${generation}`,
			bodyStartOffset,
			candidateStartOffset,
			requestedScope ?? "",
			refStartOffset,
			bodyNodeStartOffset,
			bodyStreamStartOffset,
			bodyStartPath,
			bodyBlockStartPath,
			candidateStartPath,
		);
		const bodyText = capture.bodyText.replace(/\r/g, "").trim();
		const descriptors = includeRefs
			? capture.refs.slice(0, MAX_SNAPSHOT_REFS).map((entry, index) => {
				const expected = `s${generation}-e${refStartOffset + index + 1}`;
				return { ...entry, ref: entry.ref.startsWith(`s${generation}-e`) ? entry.ref : expected };
			})
			: [];
		const descriptorHandles = new Map<string, RefHandle>();
		for (const [ref, handle] of capture.handles) {
			const index = capture.refs.findIndex((entry) => entry.ref === ref);
			if (index >= 0) descriptorHandles.set(descriptors[index]?.ref ?? ref, handle);
		}
		const omittedCandidates = capture.omittedCandidateCount ?? 0;
		const truncation = [
			omittedCandidates > 0 ? "Interactive candidates truncated; use the returned cursor to continue." : "",
			capture.bodyTruncated ? "Page text continues; use the returned cursor." : "",
		]
			.filter(Boolean)
			.join("\n");
		const refEntries = descriptors
			.map((entry) => `- ${entry.ref} ${entry.kind}${entry.label ? `: ${entry.label}` : ""}`)
			.join("\n");
		const refText = truncate(
			descriptors.length > 0 ? `Interactive refs:\n${refEntries}` : "Interactive refs: none",
			Math.max(24, refBudget),
		);
		const nextCursorNeeded = !capture.bodyDone || !capture.candidateDone;
		let nextCursor: string | undefined;
		if (nextCursorNeeded && isCurrent()) {
			nextCursor = randomUUID();
			setSnapshotCursor({
				token: nextCursor,
				id,
				page,
				state,
				includeRefs,
				scope: requestedScope,
				// Keep the text coordinate separate from the monotonic compatibility
				// offset used by renderer callers that lack child-path checkpoints.
				bodyOffset: capture.bodyStreamNextOffset,
				candidateOffset: capture.candidateNextOffset,
				refOrdinal: capture.refNextOrdinal,
				bodyNodeOffset: capture.bodyNodeNextOffset,
				bodyStreamOffset: capture.bodyStreamNextOffset,
				bodyNextPath: capture.bodyNextPath,
				bodyBlockPath: capture.bodyBlockPath,
				candidateNextPath: capture.candidateNextPath,
			});
		}
		if (isCurrent() && descriptorHandles.size > 0 && pageIsLive(page)) {
			cacheRefHandles(id, state, descriptorHandles);
		} else if (descriptorHandles.size > 0) await trackRefDisposal(descriptorHandles);
		if (isCurrent() && !nextCursorNeeded && getRefStateHandleCount(state) === 0) removeEmptyRefState(id, state);
		const cursorText = nextCursor ? `\nContinuation cursor: ${nextCursor}` : "";
		const text = `${header}${truncation ? `\n${truncation}` : ""}${cursorText}\n\n${refText}\n\nPage text:\n${bodyText || "(empty)"}`;
		return { text: truncate(text, boundedMaxChars), cursor: nextCursor, bodyDone: capture.bodyDone, candidateDone: capture.candidateDone };
	} catch (error) {
		if (isCurrent()) await pruneRefCache(id);
		if (cursor && pageIsLive(page) && isSnapshotNavigationRace(error)) throw new Error("Snapshot became stale during navigation; take a fresh helium_snapshot.");
		throw error;
	}
}

export async function makeSnapshot(
	page: Page,
	id: string,
	maxChars: number,
	includeRefs: boolean,
	options?: SnapshotRequest,
): Promise<string> {
	return (await makeSnapshotResult(page, id, maxChars, includeRefs, options)).text;
}
type ScreenshotDimensions = { width: number; height: number };

export function assertScreenshotDimensions({ width, height }: ScreenshotDimensions): void {
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0 ||
		width > MAX_SCREENSHOT_DIMENSION ||
		height > MAX_SCREENSHOT_DIMENSION ||
		width * height > MAX_SCREENSHOT_PIXELS
	) {
		throw new Error(
			`Screenshot dimensions are too large (${Math.ceil(width)}×${Math.ceil(height)} pixels); capture a smaller viewport or page.`,
		);
	}
}

async function preflightScreenshot(page: Page, fullPage: boolean): Promise<ScreenshotDimensions> {
	const dimensions = await page.evaluate((captureFullPage) => {
		const root = document.documentElement;
		const body = document.body;
		const cssWidth = captureFullPage
			? Math.max(root?.scrollWidth ?? 0, root?.clientWidth ?? 0, body?.scrollWidth ?? 0)
			: Math.max(window.innerWidth || 0, root?.clientWidth ?? 0);
		const cssHeight = captureFullPage
			? Math.max(root?.scrollHeight ?? 0, root?.clientHeight ?? 0, body?.scrollHeight ?? 0)
			: Math.max(window.innerHeight || 0, root?.clientHeight ?? 0);
		const scale = Math.max(1, window.devicePixelRatio || 1);
		return { width: Math.ceil(cssWidth * scale), height: Math.ceil(cssHeight * scale) };
	}, fullPage);
	assertScreenshotDimensions(dimensions);
	return dimensions;
}

async function preflightFullPageScreenshot(page: Page): Promise<ScreenshotDimensions> {
	return preflightScreenshot(page, true);
}

const interventionCooldowns = new Map<string, number>();

function interventionCooldownActive(key: string, now = Date.now()): boolean {
	for (const [candidate, timestamp] of interventionCooldowns) {
		if (now - timestamp >= INTERVENTION_COOLDOWN_MS) interventionCooldowns.delete(candidate);
	}
	const previous = interventionCooldowns.get(key);
	return previous !== undefined && now - previous < INTERVENTION_COOLDOWN_MS;
}

/** Returns true when a notification should be sent and records a bounded cooldown. */
export function recordInterventionCooldown(key: string, now = Date.now()): boolean {
	if (interventionCooldownActive(key, now)) return false;
	while (interventionCooldowns.size >= MAX_INTERVENTION_COOLDOWNS) {
		const oldest = interventionCooldowns.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		interventionCooldowns.delete(oldest);
	}
	interventionCooldowns.set(key, now);
	return true;
}

export function clearInterventionCooldowns(): void {
	interventionCooldowns.clear();
}

export function getInterventionCooldownCount(): number {
	return interventionCooldowns.size;
}

export function escapeAppleScriptString(value: string, maxChars: number): string {
	return truncate(value, maxChars)
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/[\u0000-\u001f\u007f]/g, " ");
}

export function buildNativeNotificationScript(title: string, body: string, focus: boolean): string {
	const safeTitle = escapeAppleScriptString(title, MAX_NOTIFICATION_TITLE_CHARS);
	const safeBody = escapeAppleScriptString(body, MAX_NOTIFICATION_BODY_CHARS);
	const notification = `display notification "${safeBody}" with title "${safeTitle}"`;
	return focus ? `${notification}\ntell application id "${HELIUM_BUNDLE_ID}" to activate` : notification;
}

async function sendNativeNotification(title: string, body: string, focus: boolean): Promise<boolean> {
	if (globalThis.process.platform !== "darwin") return false;
	const script = buildNativeNotificationScript(title, body, focus);
	return new Promise<boolean>((resolve) => {
		execFile(
			"/usr/bin/osascript",
			["-e", script],
			{ timeout: 5_000, maxBuffer: 16_384 },
			(error) => resolve(!error),
		);
	});
}

type HeliumUiContext = Pick<ExtensionContext, "hasUI" | "ui">;
type InterventionDetails = {
	status: "notified" | "deduplicated" | "unavailable";
	kind: InterventionInput["kind"];
	delivery?: "pi-ui" | "native" | "pi-ui+native" | "unavailable";
};

async function executeIntervention(
	params: InterventionInput,
	ctx: HeliumUiContext,
	pi: ExtensionAPI,
): Promise<{ content: ReturnType<typeof textContent>[]; details: InterventionDetails }> {
	const connected = await getBrowser(pi);
	const resolved = await resolvePage(connected, requireBrowserInstanceId(), params.tabId, false);
	const rawUrl = resolved.page.url();
	let origin = "unknown origin";
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin;
	} catch {}
	const key = `${requireBrowserInstanceId()}\0${resolved.id}\0${origin}\0${params.kind}`;
	if (interventionCooldownActive(key)) {
		return {
			content: [textContent("Manual-action notification already sent recently.")],
			details: { status: "deduplicated", kind: params.kind },
		};
	}
	// Keep both UI and native notification content bounded and origin-only.
	const body = truncate(`Manual ${params.kind} action may be required in Helium on ${origin}.`, MAX_NOTIFICATION_BODY_CHARS);
	let uiDelivered = false;
	if (ctx.hasUI) {
		try {
			ctx.ui.notify(body, "warning");
			uiDelivered = true;
		} catch {}
	}
	const nativeDelivered = await sendNativeNotification("Helium needs your attention", body, params.focus === true);
	if (!uiDelivered && !nativeDelivered) {
		return {
			content: [textContent("Manual-action notification could not be delivered; retry when Pi UI or native notifications are available.")],
			details: { status: "unavailable", kind: params.kind, delivery: "unavailable" },
		};
	}
	// A failed delivery does not consume the cooldown, so a later call can retry.
	recordInterventionCooldown(key);
	const delivery = uiDelivered
		? nativeDelivered
			? "pi-ui+native"
			: "pi-ui"
		: "native";
	return {
		content: [textContent("Manual-action notification delivered.")],
		details: { status: "notified", kind: params.kind, delivery },
	};
}

export async function confirmApwLogin(
	origin: string,
	logins: readonly ApwLoginMetadata[],
	confirm: (title: string, message: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<ApwLoginMetadata | undefined> {
	for (const login of logins) {
		throwIfActionNotAborted(signal, "APW confirmation");
		const approved = await confirm(
			"Fill saved login?",
			`Origin: ${origin}\nUsername: ${login.username}\nPi will not click the submit button or call form.submit; the site may react to input events.`,
		);
		throwIfActionNotAborted(signal, "APW confirmation");
		if (approved) return login;
	}
	throwIfActionNotAborted(signal, "APW confirmation");
	return undefined;
}

async function executeApwFill(
	params: ApwFillInput,
	ctx: HeliumUiContext,
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<{ content: ReturnType<typeof textContent>[]; details: { status: string } }> {
	if (!ctx.hasUI) throw new Error("APW autofill requires an interactive UI confirmation and is unavailable here.");
	throwIfActionNotAborted(signal, "APW autofill");
	const connected = await getBrowser(pi);
	const instanceId = requireBrowserInstanceId();
	const resolved = await resolvePage(connected, instanceId, params.tabId, false);
	throwIfActionNotAborted(signal, "APW autofill");
	return withTabMutation(resolved.id, signal, async (actions) => {
		const origin = currentHttpsOrigin(resolved.page);
		const discovered = await actions.run(
			() => discoverCurrentLoginForm(resolved.page),
			"APW form discovery",
			{ timeoutMs: ACTION_TIMEOUT_MS },
		);
		actions.assertNotAborted("APW autofill");
		let logins: ApwLoginMetadata[];
		try {
			logins = await actions.run(
				() => listApwLogins(origin, { signal }),
				"APW lookup",
				{ timeoutMs: ACTION_TIMEOUT_MS },
			);
		} catch (error) {
			if (error instanceof ActionCanceledError || error instanceof ActionUnknownOutcomeError) throw error;
			throw new Error("APW lookup failed. Use helium_apw_alias to inspect saved-hostname mismatches; authentication or daemon failures may also cause this error.");
		}
		// Do not let an abort that arrived while APW was queried reach the UI.
		actions.assertNotAborted("APW autofill");
		if (logins.length === 0) throw new Error("APW has no saved login for this exact HTTPS origin.");

		const selected = await confirmApwLogin(
			origin,
			logins,
			(title, message) => actions.run(() => ctx.ui.confirm(title, message), "APW confirmation", { timeoutMs: ACTION_TIMEOUT_MS }),
			signal,
		);
		actions.assertNotAborted("APW autofill");
		if (!selected)
			return {
				content: [textContent("APW autofill canceled; no fields were changed.")],
				details: { status: "canceled" },
			};

		let credential: { username: string; password: string } | undefined;
		try {
			try {
				credential = await actions.run(
					() => getApwCredential(origin, selected.username, { signal }),
					"APW credential retrieval",
					{ timeoutMs: ACTION_TIMEOUT_MS },
				);
			} catch (error) {
				if (error instanceof ActionCanceledError || error instanceof ActionUnknownOutcomeError) throw error;
				throw new Error("APW lookup failed.");
			}
			// Retrieval can complete after an abort signal was delivered. Never fill
			// with a credential obtained after cancellation.
			actions.assertNotAborted("APW autofill");
			try {
				await actions.run(
					() => fillApwOnPage(resolved.page, origin, discovered, credential!.username, credential!.password, signal),
					"APW fill",
					{ timeoutMs: ACTION_TIMEOUT_MS },
				);
			} catch (error) {
				if (error instanceof ActionCanceledError || error instanceof ActionUnknownOutcomeError) throw error;
				throw new Error("APW autofill failed safely; no credential details were exposed.");
			}
			actions.assertNotAborted("APW autofill");
			return {
				content: [
					textContent(
						"APW autofill completed. Pi did not click the submit button or call form.submit; the site may react to input events.",
					),
				],
				details: { status: "filled" },
			};
		} finally {
			if (credential) {
				// Strings are immutable; clearing these object slots is best-effort only
				// and cannot erase renderer copies or values already observed by the site.
				credential.password = "";
				credential.username = "";
			}
			actions.defer(() => pruneRefCache(resolved.id));
		}
	});
}

async function executeCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const action = args.trim().toLowerCase().split(/\s+/)[0] || "status";
	try {
		if (action === "help" || action === "setup") {
			ctx.ui.notify(heliumSetupInstructions(), "info");
			return;
		}
		if (action === "status") {
			ctx.ui.notify(formatStatus(await inspectStatus(pi, ctx.signal)), "info");
			return;
		}
		if (action === "apw") {
			const status = await apwStatus();
			ctx.ui.notify(
				[
					`APW installed: ${status.installed ? "yes" : "no"}`,
					`APW path: ${status.path}`,
					`APW socket: ${status.socket}`,
					`APW authentication: ${status.authenticated}`,
				].join("\n"),
				status.installed ? "info" : "warning",
			);
			return;
		}
		if (action === "window") {
			const connected = await getBrowser(pi);
			if (!browserInstanceId) throw new Error("Helium browser instance identity is unavailable.");
			const ensured = await ensurePiWindow(connected, browserInstanceId);
			ctx.ui.notify(
				`Pi-owned Helium window ${ensured.action}: ${ensured.windowId} (tab ${pageId(ensured.page)}).`,
				"info",
			);
			return;
		}
		if (action === "start") {
			ctx.ui.notify(await startHelium(pi), "info");
			return;
		}
		ctx.ui.notify("Usage: /helium [status|apw|window|start|setup|help]", "warning");
	} catch (error) {
		ctx.ui.notify(`Helium command failed: ${errorText(error)}`, "error");
	}
}

export default function heliumBrowserExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n[HELIUM BROWSER CAPABILITY] Helium browser tools attach to the user's already-running Helium over CDP. Use helium_status or helium_tabs first. Pi-owned operations safely adopt an existing default window only when every page is an empty new tab; meaningful user windows are left untouched. Status and tabs are read-only; snapshots and screenshots use an existing Pi window only. Omitted tabId on mutating tools may lazily ensure that window, while explicit tabId may target a user tab. helium_open_tab reuses an unused blank Pi tab when possible and otherwise opens a same-window tab. Use helium_snapshot before interacting with a page. Use helium_request_intervention whenever manual login, signup, MFA, passkey, CAPTCHA, payment, consent, or other user action blocks progress. Never use helium_fill or helium_type for passwords, OTPs, API keys, payment data, or any other credentials; use helium_apw_fill only after its per-origin, per-account confirmation. Pi will not click the submit button or call form.submit during APW autofill, but the site may react to input events. Use /helium window to ensure or recover the dedicated window. Do not assume CDP is enabled; tell the user to run /helium setup if unavailable.`,
	}));

	pi.registerCommand("helium", {
		description: "Inspect, set up, or start safe CDP access to the Helium browser",
		getArgumentCompletions: (prefix) =>
			["status", "apw", "window", "start", "setup", "help"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => executeCommand(args, ctx, pi),
	});

	pi.registerTool({
		name: "helium_request_intervention",
		renderResult: createToolResultRenderer("helium_request_intervention"),
		label: "Helium: Request user action",
		description:
			"Notify the user that a bounded manual action is required in a Helium tab; use this instead of inventing a reason or message.",
		promptSnippet: "Notify the user about a blocked manual browser action",
		promptGuidelines: [
			"Use helium_request_intervention when progress is blocked by login, signup, MFA, passkey, CAPTCHA, payment, consent, or another manual user action.",
			"Keep helium_request_intervention calls free of secrets or arbitrary reasons; its notification contains only the action kind and page origin.",
		],
		parameters: interventionParams,
		executionMode: "sequential",
		async execute(_id, params: InterventionInput, _signal, _onUpdate, ctx) {
			return executeIntervention(params, ctx, pi);
		},
	});

	registerApwAliasTool(pi, async (tabId) => {
		const connected = await getBrowser(pi);
		const resolved = await resolvePage(connected, requireBrowserInstanceId(), tabId, false);
		return currentHttpsOrigin(resolved.page);
	});

	pi.registerTool({
		name: "helium_apw_fill",
		renderResult: createToolResultRenderer("helium_apw_fill"),
		label: "Helium: Fill saved login",
		description:
			"After mandatory interactive confirmation for an exact HTTPS origin and saved account, fill one visible login form from APW. Pi will not click the submit button or call form.submit; the site may react to input events.",
		promptSnippet: "Confirm and fill an exact-origin saved login from APW",
		promptGuidelines: [
			"Use helium_apw_fill only for a visible top-frame current-login form with exactly one password field and at most one username/email field. Prefer autocomplete=current-password; otherwise the same form must show strong login/sign-in evidence.",
			"Never use helium_apw_fill for signup, reset/recovery, new-password, MFA/OTP, payment, or other credential forms. Pi will not click submit or call form.submit, but sites may react to input events.",
			"helium_apw_fill requires UI confirmation and never returns a password, OTP, or credential identifier.",
			"If helium_apw_fill lookup fails due to a saved hostname mismatch, use helium_apw_alias to inspect candidates and request approval, then retry.",
		],
		parameters: apwFillParams,
		executionMode: "sequential",
		async execute(_id, params: ApwFillInput, signal, _onUpdate, ctx) {
			return executeApwFill(params, ctx, pi, signal);
		},
	});

	pi.registerTool({
		name: "helium_status",
		renderResult: createToolResultRenderer("helium_status"),
		label: "Helium: Status",
		description:
			"Read Helium CDP status, Pi-owned window state, and tab counts without creating or changing browser state.",
		promptSnippet: "Check Helium CDP and browser status",
		parameters: emptyParams,
		async execute(_id, _params, signal) {
			const status = await inspectStatus(pi, signal);
			return { content: [textContent(formatStatus(status))], details: status };
		},
	});

	pi.registerTool({
		name: "helium_tabs",
		renderResult: createToolResultRenderer("helium_tabs"),
		label: "Helium: List tabs",
		description:
			"Read visible Helium tabs (all by default), including ownership and Chromium window ids; never creates a Pi window.",
		promptSnippet: "List Helium tabs by all, Pi-owned, or user scope",
		parameters: tabsParams,
		async execute(_id, params: TabsInput) {
			const connected = await getBrowser(pi);
			const tabs = filterTabScope(await listTabInfo(connected), params.scope);
			const detailsTabs = tabs.slice(0, MAX_TABS_DETAILS);
			return {
				content: [textContent(formatTabList(tabs))],
				details: {
					tabs: detailsTabs,
					scope: params.scope ?? "all",
					truncated: tabs.length > detailsTabs.length,
					omitted: Math.max(0, tabs.length - detailsTabs.length),
				},
			};
		},
	});

	pi.registerTool({
		name: "helium_open_tab",
		renderResult: createToolResultRenderer("helium_open_tab"),
		label: "Helium: Open tab",
		description:
			"Safely adopt an entirely blank default window when possible, then reuse an unused blank Pi tab; otherwise open a same-window tab, optionally navigating to a safe http(s) URL.",
		promptSnippet: "Open or reuse a Pi-owned Helium tab",
		parameters: openTabParams,
		executionMode: "sequential",
		async execute(_id, params) {
			// Normalize before connecting: malformed URLs must not adopt/create a window.
			const url = params.url?.trim() ? normalizeNavigationUrl(params.url) : undefined;
			const connected = await getBrowser(pi);
			if (!browserInstanceId) throw new Error("Helium browser instance identity is unavailable.");
			const opened = await openPiTab(connected, browserInstanceId, url);
			return {
				content: [
					textContent(
						`Opened Pi-owned Helium tab ${opened.id} in window ${opened.windowId} (${opened.windowAction ?? "recovered"}): ${opened.page.url() || "(blank)"}`,
					),
				],
				details: {
					id: opened.id,
					url: opened.page.url(),
					ownership: opened.ownership,
					windowId: opened.windowId,
					windowAction: opened.windowAction,
				},
			};
		},
	});

	pi.registerTool({
		name: "helium_navigate",
		renderResult: createToolResultRenderer("helium_navigate"),
		label: "Helium: Navigate",
		description: "Navigate an existing Helium tab to an http(s) URL or about:blank.",
		promptSnippet: "Navigate a Helium tab",
		parameters: navigateParams,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const url = normalizeNavigationUrl(params.url);
			throwIfActionNotAborted(signal, "Navigation");
			const connected = await getBrowser(pi);
			const instanceId = requireBrowserInstanceId();
			const resolved = await resolvePage(connected, instanceId, params.tabId);
			throwIfActionNotAborted(signal, "Navigation");
			return withTabMutation(resolved.id, signal, async (actions) => {
				actions.defer(() => pruneRefCache(resolved.id));
				try {
					await actions.run(
						() => resolved.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
						"Navigation",
						{ timeoutMs: NAVIGATION_TIMEOUT_MS },
					);
				} finally {
					// A returned blank-tab claim lasts until navigation. Release it only
					// through the same cross-process ownership protocol as claims.
					actions.defer(() => releasePiTabOpenPageUnderOwnershipLock(instanceId, resolved.page));
				}
				return {
					content: [textContent(`Navigated ${resolved.id} (${resolved.ownership}) to ${resolved.page.url()}`)],
					details: {
						id: resolved.id,
						url: resolved.page.url(),
						ownership: resolved.ownership,
						windowId: resolved.windowId,
					},
				};
			});
		},
	});

	pi.registerTool({
		name: "helium_snapshot",
		renderResult: createToolResultRenderer("helium_snapshot"),
		label: "Helium: Snapshot",
		description:
			"Read a bounded text snapshot of a Helium tab, including stable refs. Use the opaque cursor in details to continue through large DOMs; scope optionally limits traversal to one CSS-selected subtree. Omitted tabId uses an existing Pi window only and never adopts or creates one.",
		promptSnippet: "Read a Helium page snapshot, optionally continuing with its cursor",
		promptGuidelines: ["Take a fresh helium_snapshot after navigation or a page-changing action before using a ref; use its cursor to inspect later content."],
		parameters: snapshotParams,
		executionMode: "sequential",
		async execute(_id, params) {
			const connected = await getBrowser(pi);
			const resolved = await resolvePage(connected, requireBrowserInstanceId(), params.tabId, false);
			const maxChars = params.maxChars ?? 12_000;
			const includeRefs = params.includeRefs !== false;
			const result = await makeSnapshotResult(resolved.page, resolved.id, maxChars, includeRefs, {
				cursor: params.cursor,
				scope: params.scope,
			});
			return {
				content: [textContent(result.text)],
				details: {
					id: resolved.id,
					maxChars,
					includeRefs,
					scope: params.scope,
					cursor: result.cursor,
					complete: result.bodyDone && result.candidateDone,
					ownership: resolved.ownership,
					windowId: resolved.windowId,
				},
			};
		},
	});

	pi.registerTool({
		name: "helium_click",
		renderResult: createToolResultRenderer("helium_click"),
		label: "Helium: Click",
		description: "Click one visible element in a Helium tab using a fresh snapshot ref or a CSS selector.",
		parameters: elementTargetParams,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			validateElementTargetArguments(params);
			throwIfActionNotAborted(signal, "Click");
			const connected = await getBrowser(pi);
			const instanceId = requireBrowserInstanceId();
			const resolved = await resolvePage(connected, instanceId, params.tabId);
			throwIfActionNotAborted(signal, "Click");
			return withTabMutation(resolved.id, signal, async (actions) => {
				const target = await resolveTargetOnPage(resolved, params, actions);
				const label = params.ref ? `ref ${params.ref}` : `selector ${target.selector}`;
				let selectorHandle: RefHandle | undefined;
				try {
					if (target.handle) {
						await clickElementHandle(target.handle, label, actions);
					} else {
						try {
							selectorHandle =
								(await withElementActionTimeout(
										() => target.page.$(target.selector!),
										`Finding ${label}`,
										actions,
									)) ?? undefined;
						} catch (error) {
							throw new Error(
								`Could not click ${label}: ${errorText(error)}. Take a fresh helium_snapshot first.`,
							);
						}
						if (!selectorHandle)
							throw new Error(`Stale ${label}; no matching element. Take a fresh helium_snapshot first.`);
						await clickElementHandle(selectorHandle, label, actions);
					}
				} finally {
					actions.defer(async () => {
						if (selectorHandle) await selectorHandle.dispose().catch(() => {});
						await pruneRefCache(target.id);
					});
				}
				return {
					content: [textContent(`Clicked ${label} in ${target.id} (${target.ownership}).`)],
					details: {
						id: target.id,
						selector: target.selector,
						ref: params.ref,
						ownership: target.ownership,
						windowId: target.windowId,
					},
				};
			});
		},
	});

	pi.registerTool({
		name: "helium_fill",
		renderResult: createToolResultRenderer("helium_fill"),
		label: "Helium: Fill",
		description:
			"Replace one non-credential value in a Helium tab. Never use for passwords, OTPs, API keys, payment data, or other credentials; use helium_apw_fill for eligible logins.",
		promptGuidelines: [
			"Never use helium_fill for passwords or other credentials; use helium_apw_fill for eligible login forms.",
		],
		parameters: fillParams,
		executionMode: "sequential",
		async execute(_id, params: FillInput, signal) {
			validateElementTargetArguments(params);
			throwIfActionNotAborted(signal, "Fill");
			const connected = await getBrowser(pi);
			const instanceId = requireBrowserInstanceId();
			const resolved = await resolvePage(connected, instanceId, params.tabId);
			throwIfActionNotAborted(signal, "Fill");
			return withTabMutation(resolved.id, signal, async (actions) => {
				const target = await resolveTargetOnPage(resolved, params, actions);
				let selectorHandle: RefHandle | undefined;
				try {
					if (target.handle) {
						await fillHandle(target.handle, params.text, actions);
					} else {
						selectorHandle =
							(await withElementActionTimeout(
									() => target.page.$(target.selector!),
									`Finding selector ${target.selector}`,
									actions,
								)) ?? undefined;
						if (!selectorHandle)
							throw new Error(
								`Stale selector ${target.selector}; no matching element. Take a fresh helium_snapshot first.`,
							);
						await fillHandle(selectorHandle, params.text, actions);
					}
				} finally {
					actions.defer(async () => {
						if (selectorHandle) await selectorHandle.dispose().catch(() => {});
						await pruneRefCache(target.id);
					});
				}
				const label = params.ref ? `ref ${params.ref}` : target.selector;
				return {
					content: [textContent(`Filled ${label} in ${target.id} (${target.ownership}).`)],
					details: {
						id: target.id,
						selector: target.selector,
						ref: params.ref,
						ownership: target.ownership,
						windowId: target.windowId,
						length: params.text.length,
					},
				};
			});
		},
	});

	pi.registerTool({
		name: "helium_type",
		renderResult: createToolResultRenderer("helium_type"),
		label: "Helium: Type",
		description:
			"Focus one non-credential input-like element and type text without evaluating arbitrary page JavaScript. Never use for passwords, OTPs, API keys, payment data, or other credentials.",
		promptGuidelines: [
			"Never use helium_type for passwords or other credentials; use helium_apw_fill for eligible login forms.",
		],
		parameters: typeParams,
		executionMode: "sequential",
		async execute(_id, params: TypeInput, signal) {
			validateElementTargetArguments(params);
			throwIfActionNotAborted(signal, "Type");
			const connected = await getBrowser(pi);
			const instanceId = requireBrowserInstanceId();
			const resolved = await resolvePage(connected, instanceId, params.tabId);
			throwIfActionNotAborted(signal, "Type");
			return withTabMutation(resolved.id, signal, async (actions) => {
				const target = await resolveTargetOnPage(resolved, params, actions);
				let selectorHandle: RefHandle | undefined;
				try {
					if (target.handle) {
						selectorHandle = target.handle;
					} else {
						selectorHandle =
							(await withElementActionTimeout(
									() => target.page.$(target.selector!),
									`Finding selector ${target.selector}`,
									actions,
								)) ?? undefined;
						if (!selectorHandle)
							throw new Error(
								`Stale selector ${target.selector}; no matching element. Take a fresh helium_snapshot first.`,
							);
					}
					await checkInputHandle(selectorHandle, "type", actions);
					if (await pageIsHidden(target.page, actions)) await typeInBackgroundHandle(selectorHandle, params.text, actions);
					else {
						await clickElementHandle(
							selectorHandle,
							params.ref ? `ref ${params.ref}` : `selector ${target.selector}`,
							actions,
						);
						await checkInputHandle(selectorHandle, "type", actions);
						await withElementActionTimeout(
							() => target.page.keyboard.type(params.text),
							"Typing into element",
							actions,
						);
					}
				} finally {
					actions.defer(async () => {
						if (selectorHandle && !target.handle) await selectorHandle.dispose().catch(() => {});
						await pruneRefCache(target.id);
					});
				}
				const label = params.ref ? `ref ${params.ref}` : target.selector;
				return {
					content: [
						textContent(
							`Typed ${params.text.length} characters into ${label} in ${target.id} (${target.ownership}).`,
						),
					],
					details: {
						id: target.id,
						selector: target.selector,
						ref: params.ref,
						ownership: target.ownership,
						windowId: target.windowId,
						length: params.text.length,
					},
				};
			});
		},
	});

	pi.registerTool({
		name: "helium_key",
		renderResult: createToolResultRenderer("helium_key"),
		label: "Helium: Key press",
		description:
			"Send one bounded Puppeteer key press such as Enter, Escape, ArrowDown, or Control+A to a Helium tab.",
		parameters: keyParams,
		executionMode: "sequential",
		async execute(_id, params: KeyInput, signal) {
			throwIfActionNotAborted(signal, "Key press");
			const key = validateHeliumKey(params.key);
			const connected = await getBrowser(pi);
			const resolved = await resolvePage(connected, requireBrowserInstanceId(), params.tabId);
			throwIfActionNotAborted(signal, "Key press");
			return withTabMutation(resolved.id, signal, async (actions) => {
				actions.defer(() => pruneRefCache(resolved.id));
				if (/(?:Backspace|Delete)$/.test(key)) {
					let sensitive = false;
					try {
						sensitive = await withElementActionTimeout(
							() => resolved.page.evaluate(focusedSensitiveFieldEvaluator),
							"Checking the focused key target",
							actions,
						);
					} catch {
						throw new Error("Cannot safely inspect the focused field; key press was not sent.");
					}
					if (sensitive) throw new Error("Cannot delete text from a credential-like focused field.");
				}
				await withElementActionTimeout(
					() => resolved.page.keyboard.press(key as PuppeteerKeyInput),
					`Pressing ${key}`,
					actions,
				);
				return {
					content: [textContent(`Pressed ${key} in ${resolved.id} (${resolved.ownership}).`)],
					details: {
						id: resolved.id,
						key,
						ownership: resolved.ownership,
						windowId: resolved.windowId,
					},
				};
			});
		},
	});

	pi.registerTool({
		name: "helium_screenshot",
		renderResult: createToolResultRenderer("helium_screenshot"),
		label: "Helium: Screenshot",
		description:
			"Capture a PNG screenshot of a Helium tab; omitted tabId uses an existing Pi window only and never adopts or creates one.",
		parameters: screenshotParams,
		async execute(_id, params) {
			const connected = await getBrowser(pi);
			const resolved = await resolvePage(connected, requireBrowserInstanceId(), params.tabId, false);
			const fullPage = params.fullPage === true;
			// Preflight both viewport and full-page captures. A second full-page
			// read narrows the resize race immediately before CDP allocation.
			await preflightScreenshot(resolved.page, fullPage);
			if (fullPage) await preflightFullPageScreenshot(resolved.page);
			const data = (await resolved.page.screenshot({
				type: "png",
				encoding: "base64",
				fullPage,
			})) as string;
			if (data.length > MAX_SCREENSHOT_BASE64_CHARS) {
				throw new Error(
					`Screenshot is too large (${data.length} base64 characters); use a smaller visible page or omit fullPage.`,
				);
			}
			return {
				content: [
					textContent(
						`Screenshot captured for ${resolved.id} (${resolved.ownership}; ${Math.round((data.length * 3) / 4 / 1024)} KiB).`,
					),
					{ type: "image" as const, data, mimeType: "image/png" },
				],
				details: {
					id: resolved.id,
					fullPage: params.fullPage === true,
					ownership: resolved.ownership,
					windowId: resolved.windowId,
				},
			};
		},
	});

	pi.on("session_shutdown", async () => {
		cancelAllOwnershipCreations(new Error("Pi session shut down during Helium window setup."));
		const pending = connectPromise;
		const current = browser;
		const detachedRefs = detachAllRefMaps();
		browser = undefined;
		browserInstanceId = undefined;
		connectPromise = undefined;
		clearInterventionCooldowns();

		// Disconnect first; remote-handle disposal must not delay releasing CDP.
		disconnectBrowserPromptly(current);
		if (pending) {
			void pending.then(
				(connected) => {
					if (browser === connected) {
						browser = undefined;
						browserInstanceId = undefined;
					}
					disconnectBrowserPromptly(connected);
				},
				() => {},
			);
		}

		const disposal = disposeDetachedRefMaps(detachedRefs);
		await Promise.allSettled([awaitRefDisposalDuringShutdown(disposal), clearCurrentProcessPiTabReservations()]);
	});
}
