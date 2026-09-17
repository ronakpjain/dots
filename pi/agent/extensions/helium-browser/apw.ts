import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { matchesSavedHostname } from "./apw-aliases.ts";
import { hasApprovedAlias, isAliasHostname } from "./apw-alias-store.ts";

/** APW is intentionally isolated from Pi's command runner and never exposes command output. */
export const DEFAULT_APW_PATH = "/opt/homebrew/bin/apw";
export const APW_PROTOCOL_VERSION = "1.1.1";

const APW_TIMEOUT_MS = 15_000;
const MAX_LIST_OUTPUT_BYTES = 512 * 1024;
const MAX_GET_OUTPUT_BYTES = 128 * 1024;
const MAX_STATUS_OUTPUT_BYTES = 4 * 1024;
const MAX_USERNAME_CHARS = 320;
const MAX_PASSWORD_CHARS = 16_384;
const MAX_RESULT_COUNT = 1_024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type ApwRequestOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
};

export type ApwLoginMetadata = {
	username: string;
};

export type ApwCredential = {
	username: string;
	password: string;
};

export type ApwStatus = {
	installed: boolean;
	path: string;
	socket: "unknown";
	authenticated: "unknown";
};

type JsonObject = Record<string, unknown>;
type ApwCommandResult = { stdout: Buffer };

export function apwPath(): string {
	return process.env.PI_HELIUM_APW_PATH || process.env.APW_PATH || DEFAULT_APW_PATH;
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function validUsername(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= MAX_USERNAME_CHARS && !value.includes("\u0000")
	);
}

function validOrigin(origin: string): boolean {
	if (origin.length === 0 || origin.length > 2_048) return false;
	try {
		const parsed = new URL(origin);
		return (
			parsed.protocol === "https:" &&
			parsed.origin === origin &&
			parsed.pathname === "/" &&
			parsed.search === "" &&
			parsed.hash === ""
		);
	} catch {
		return false;
	}
}

/** Return true only when both values are the same canonical HTTPS origin. */
export function isExactHttpsOrigin(value: unknown, expectedOrigin: string): value is string {
	return typeof value === "string" && validOrigin(expectedOrigin) && value === expectedOrigin;
}

/** Validate the canonical HTTPS origin accepted by APW. */
export function assertExactHttpsOrigin(origin: string): void {
	if (!validOrigin(origin)) throw new Error("APW requires an exact HTTPS origin");
}

function assertUsername(value: string): void {
	if (!validUsername(value)) throw new Error("APW requires a valid username");
}

/** APW 1.1.1 addresses password entries by hostname, while browser authorization remains origin-based. */
function hostnameForOrigin(origin: string): string {
	assertExactHttpsOrigin(origin);
	return new URL(origin).hostname;
}

function assertRequestOptions(options: ApwRequestOptions | undefined): void {
	if (options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new Error("APW request failed");
	}
}

function wipeBuffers(buffers: Buffer[]): void {
	for (const buffer of buffers) buffer.fill(0);
	buffers.length = 0;
}

function killChild(child: ChildProcess): void {
	try {
		child.kill("SIGKILL");
	} catch {
		// The process may already have exited.
	}
}

async function runApw(args: string[], maxBytes: number, options?: ApwRequestOptions): Promise<ApwCommandResult> {
	assertRequestOptions(options);
	if (options?.signal?.aborted) throw new Error("APW command aborted");

	const executable = apwPath();
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(executable, args, {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			reject(new Error("APW executable could not be started"));
			return;
		}

		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				wipeBuffers(stdoutChunks);
				reject(error);
				return;
			}
			const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
			wipeBuffers(stdoutChunks);
			resolve({ stdout });
		};
		const abort = (message: string) => {
			if (settled) return;
			killChild(child);
			finish(new Error(message));
		};
		const onAbort = () => abort("APW command aborted");

		timer = setTimeout(() => abort("APW command timed out"), options?.timeoutMs ?? APW_TIMEOUT_MS);
		if (options?.signal) options.signal.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			stdoutBytes += buffer.byteLength;
			if (stdoutBytes > maxBytes) {
				buffer.fill(0);
				abort("APW response exceeded the safety limit");
				return;
			}
			stdoutChunks.push(buffer);
		});
		// APW may include sensitive context in stderr. Drain it, but never retain or report it.
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
			if (Buffer.isBuffer(chunk)) chunk.fill(0);
			if (stderrBytes > maxBytes) abort("APW response exceeded the safety limit");
		});
		child.once("error", () => finish(new Error("APW executable could not be started")));
		child.once("close", (code: number | null) => {
			if (settled) return;
			if (code !== 0) {
				finish(new Error("APW command failed"));
				return;
			}
			finish();
		});
	});
}

async function runJson(args: string[], maxBytes: number, options?: ApwRequestOptions): Promise<unknown> {
	const result = await runApw(args, maxBytes, options);
	try {
		const raw = textDecoder.decode(result.stdout);
		return JSON.parse(raw) as unknown;
	} catch {
		throw new Error("APW returned malformed JSON");
	} finally {
		result.stdout.fill(0);
	}
}

function parseEnvelope(value: unknown): JsonObject & { results: unknown[] } {
	if (!isObject(value) || !hasOwn(value, "status") || !hasOwn(value, "results")) {
		throw new Error("APW returned malformed JSON");
	}
	if (value.status !== 0 || !Array.isArray(value.results) || value.results.length > MAX_RESULT_COUNT) {
		throw new Error("APW command failed");
	}
	return value as JsonObject & { results: unknown[] };
}

async function parseResultRecord(value: unknown, hostname: string): Promise<JsonObject & { username: string }> {
	if (!isObject(value) || !hasOwn(value, "username") || !hasOwn(value, "domain")) {
		throw new Error("APW returned malformed JSON");
	}
	if (!validUsername(value.username)) throw new Error("APW returned invalid login metadata");
	if (!matchesSavedHostname(value.domain, hostname) &&
		!(typeof value.domain === "string" && await hasApprovedAlias(hostname, value.domain)))
		throw new Error("APW returned a credential for another hostname; use helium_apw_alias to inspect and request approval.");
	return value as JsonObject & { username: string };
}

async function parseList(value: unknown, hostname: string): Promise<ApwLoginMetadata[]> {
	const envelope = parseEnvelope(value);
	const seen = new Set<string>();
	const result: ApwLoginMetadata[] = [];
	for (const item of envelope.results) {
		const record = await parseResultRecord(item, hostname);
		if (!seen.has(record.username)) {
			seen.add(record.username);
			result.push({ username: record.username });
		}
	}
	return result;
}

async function parseCredential(value: unknown, hostname: string, requestedUsername: string): Promise<ApwCredential> {
	const envelope = parseEnvelope(value);
	let selected: (JsonObject & { username: string }) | undefined;
	for (const item of envelope.results) {
		const record = await parseResultRecord(item, hostname);
		if (record.username !== requestedUsername) continue;
		if (selected) throw new Error("APW returned multiple credentials");
		selected = record;
	}
	if (!selected || !hasOwn(selected, "password") || typeof selected.password !== "string") {
		throw new Error("APW returned no usable password");
	}
	if (selected.password.length === 0 || selected.password.length > MAX_PASSWORD_CHARS)
		throw new Error("APW returned no usable password");
	return { username: requestedUsername, password: selected.password };
}

/** Metadata-only discovery for alias proposals. Never expose usernames or passwords. */
export async function inspectApwSavedHostnames(origin: string, options?: ApwRequestOptions): Promise<string[]> {
	const hostname = hostnameForOrigin(origin);
	const envelope = parseEnvelope(await runJson(["pw", "list", hostname, "--json"], MAX_LIST_OUTPUT_BYTES, options));
	const hosts = new Set<string>();
	for (const item of envelope.results) {
		if (!isObject(item) || !isAliasHostname(item.domain)) throw new Error("APW returned invalid hostname metadata.");
		hosts.add(item.domain);
	}
	return [...hosts].sort();
}

export async function listApwLogins(origin: string, options?: ApwRequestOptions): Promise<ApwLoginMetadata[]> {
	const hostname = hostnameForOrigin(origin);
	return parseList(await runJson(["pw", "list", hostname, "--json"], MAX_LIST_OUTPUT_BYTES, options), hostname);
}

export async function getApwCredential(
	origin: string,
	requestedUsername: string,
	options?: ApwRequestOptions,
): Promise<ApwCredential> {
	const hostname = hostnameForOrigin(origin);
	assertUsername(requestedUsername);
	return parseCredential(
		await runJson(["pw", "get", hostname, requestedUsername, "--json"], MAX_GET_OUTPUT_BYTES, options),
		hostname,
		requestedUsername,
	);
}

/** Inspect only the local executable. APW daemon/socket and authentication state remain intentionally unknown. */
export async function apwStatus(options?: ApwRequestOptions): Promise<ApwStatus> {
	const path = apwPath();
	try {
		await access(path, constants.X_OK);
	} catch {
		return { installed: false, path, socket: "unknown", authenticated: "unknown" };
	}
	try {
		const result = await runApw(["--version"], MAX_STATUS_OUTPUT_BYTES, options);
		result.stdout.fill(0);
	} catch {
		if (options?.signal?.aborted) throw new Error("APW command aborted");
		// Existence is useful status even when probing the executable is unavailable.
	}
	return { installed: true, path, socket: "unknown", authenticated: "unknown" };
}
