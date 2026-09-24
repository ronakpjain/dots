import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeToolOutput } from "./tool-results/format.ts";
import { renderToolResult } from "./tool-results/render.ts";

export const TOKEN_USAGE_EVENT = "pi-token-usage";
const STORE_VERSION = 1;
const SUBAGENT_RUN_ENTRY_TYPE = "subagent-run";
const DEFAULT_STORE_NAME = "token-usage.jsonl";
const MAX_MODEL_ROWS = 12;
const MAX_SOURCE_ROWS = 8;

export type TokenUsageSource = "main" | "subagent" | "tool" | "compaction";
export type TokenUsageCostBasis = "reported" | "estimated" | "unknown";

export interface TokenUsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** A provider usage object, deliberately structural so it also accepts old session data. */
export interface TokenUsageUsage {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cacheWrite1h?: unknown;
	totalTokens?: unknown;
	turns?: unknown;
	cost?: unknown;
}

export interface TokenUsageRecord {
	version: typeof STORE_VERSION;
	id: string;
	timestamp: string;
	source: TokenUsageSource;
	sessionId?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	api?: string;
	label?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	totalTokens: number;
	calls: number;
	cost: TokenUsageCost;
	reportedCost: TokenUsageCost;
	costBasis: TokenUsageCostBasis;
}

export interface TokenUsageEvent {
	recordId?: string;
	source: TokenUsageSource;
	timestamp?: string | number;
	sessionId?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	api?: string;
	label?: string;
	usage?: TokenUsageUsage;
}

export interface TimeRange {
	from?: number;
	to?: number;
	label: string;
}

export interface UsageBreakdown {
	calls: number;
	totalTokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: TokenUsageCost;
}

export interface UsageAggregate extends UsageBreakdown {
	from?: number;
	to?: number;
	bySource: Record<string, UsageBreakdown>;
	byModel: Record<string, UsageBreakdown>;
	estimatedCalls: number;
	unknownCostCalls: number;
	reportedCost: number;
}

type ModelLike = {
	provider?: string;
	id?: string;
	cost?: unknown;
};

type ModelLookup = (provider: string | undefined, model: string | undefined) => ModelLike | undefined;

type MessageLike = {
	role?: unknown;
	content?: unknown;
	provider?: unknown;
	model?: unknown;
	api?: unknown;
	responseId?: unknown;
	timestamp?: unknown;
	toolName?: unknown;
	usage?: TokenUsageUsage;
};

type SessionEntryLike = {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	message?: MessageLike;
	customType?: unknown;
	data?: unknown;
	usage?: TokenUsageUsage;
	provider?: unknown;
	model?: unknown;
	api?: unknown;
};

type SessionHeaderLike = {
	type?: unknown;
	id?: unknown;
	cwd?: unknown;
};

const TokenUsageParams = {
	type: "object",
	properties: {
		period: {
			type: "string",
			description:
				"Time period: all, today, yesterday, last 7d, since 2026-01-01, or a range such as 2026-01-01..2026-01-31",
		},
		from: { type: "string", description: "Start of an arbitrary period (ISO date/time)" },
		to: { type: "string", description: "End of an arbitrary period (ISO date/time)" },
		groupBy: {
			type: "string",
			enum: ["summary", "day", "model", "source"],
			description: "Optional report grouping",
		},
	},
	additionalProperties: false,
} as const;
type TokenUsageParamsType = {
	period?: string;
	from?: string;
	to?: string;
	groupBy?: "summary" | "day" | "model" | "source";
};

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeTimestamp(value: unknown, fallback = Date.now()): string {
	const milliseconds = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
	return new Date(Number.isFinite(milliseconds) ? milliseconds : fallback).toISOString();
}

function timestampMilliseconds(value: unknown): number | undefined {
	const milliseconds = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function emptyCost(): TokenUsageCost {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function normalizeCost(value: unknown): TokenUsageCost {
	if (typeof value === "number") return { ...emptyCost(), total: numberOrZero(value) };
	const candidate = asRecord(value);
	if (!candidate) return emptyCost();

	const cost: TokenUsageCost = {
		input: numberOrZero(candidate.input),
		output: numberOrZero(candidate.output),
		cacheRead: numberOrZero(candidate.cacheRead),
		cacheWrite: numberOrZero(candidate.cacheWrite),
		total: numberOrZero(candidate.total),
	};
	if (cost.total === 0) {
		cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	}
	return cost;
}

function normalizeAmounts(usage: TokenUsageUsage): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	totalTokens: number;
} {
	const input = numberOrZero(usage.input);
	const output = numberOrZero(usage.output);
	const cacheRead = numberOrZero(usage.cacheRead);
	const cacheWrite = numberOrZero(usage.cacheWrite);
	const cacheWrite1h = Math.min(cacheWrite, numberOrZero(usage.cacheWrite1h));
	const reportedTotal = numberOrZero(usage.totalTokens);
	const countedTokens = input + output + cacheRead + cacheWrite;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cacheWrite1h,
		totalTokens: Math.max(reportedTotal, countedTokens),
	};
}

function modelCost(
	model: ModelLike | undefined,
	amounts: ReturnType<typeof normalizeAmounts>,
): TokenUsageCost | undefined {
	const modelCost = asRecord(model?.cost);
	if (!modelCost) return undefined;

	const hasRates = ["input", "output", "cacheRead", "cacheWrite"].some((key) => {
		return typeof modelCost[key] === "number" && Number.isFinite(modelCost[key]);
	});
	if (!hasRates) return undefined;

	let rates = {
		input: numberOrZero(modelCost.input),
		output: numberOrZero(modelCost.output),
		cacheRead: numberOrZero(modelCost.cacheRead),
		cacheWrite: numberOrZero(modelCost.cacheWrite),
	};
	let matchedThreshold = -1;
	const tiers = Array.isArray(modelCost.tiers) ? modelCost.tiers : [];
	for (const tierValue of tiers) {
		const tier = asRecord(tierValue);
		if (!tier) continue;
		const threshold = numberOrZero(tier.inputTokensAbove);
		if (amounts.input + amounts.cacheRead + amounts.cacheWrite > threshold && threshold > matchedThreshold) {
			rates = {
				input: numberOrZero(tier.input),
				output: numberOrZero(tier.output),
				cacheRead: numberOrZero(tier.cacheRead),
				cacheWrite: numberOrZero(tier.cacheWrite),
			};
			matchedThreshold = threshold;
		}
	}

	const shortCacheWrite = Math.max(0, amounts.cacheWrite - amounts.cacheWrite1h);
	const cost: TokenUsageCost = {
		input: (rates.input * amounts.input) / 1_000_000,
		output: (rates.output * amounts.output) / 1_000_000,
		cacheRead: (rates.cacheRead * amounts.cacheRead) / 1_000_000,
		cacheWrite: (rates.cacheWrite * shortCacheWrite + rates.input * 2 * amounts.cacheWrite1h) / 1_000_000,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return cost;
}

function costForUsage(
	usage: TokenUsageUsage,
	model: ModelLike | undefined,
): {
	amounts: ReturnType<typeof normalizeAmounts>;
	cost: TokenUsageCost;
	reportedCost: TokenUsageCost;
	basis: TokenUsageCostBasis;
} {
	const amounts = normalizeAmounts(usage);
	const reportedCost = normalizeCost(usage.cost);
	if (reportedCost.total > 0 || amounts.totalTokens === 0) {
		return { amounts, cost: reportedCost, reportedCost, basis: "reported" };
	}

	const estimated = modelCost(model, amounts);
	if (estimated) return { amounts, cost: estimated, reportedCost, basis: "estimated" };
	return { amounts, cost: reportedCost, reportedCost, basis: "unknown" };
}

function hashIdentity(identity: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < identity.length; index++) {
		hash ^= identity.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function messageRecordId(sessionId: string, message: MessageLike, source: TokenUsageSource): string {
	const responseId = stringOrUndefined(message.responseId);
	if (responseId) return `${source}:response:${responseId}`;
	const identity = [
		sessionId,
		source,
		String(message.timestamp ?? ""),
		stringOrUndefined(message.provider) ?? "",
		stringOrUndefined(message.model) ?? "",
		stringOrUndefined(message.toolName) ?? "",
		numberOrZero(message.usage?.input),
		numberOrZero(message.usage?.output),
		numberOrZero(message.usage?.cacheRead),
		numberOrZero(message.usage?.cacheWrite),
	].join("\u0001");
	return `${source}:message:${hashIdentity(identity)}`;
}

function splitQualifiedModel(value: string | undefined): { provider?: string; model?: string } {
	if (!value) return {};
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return { model: value };
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function recordFromUsage(
	metadata: {
		id: string;
		source: TokenUsageSource;
		timestamp?: unknown;
		sessionId?: string;
		cwd?: string;
		provider?: string;
		model?: string;
		api?: string;
		label?: string;
	},
	usage: TokenUsageUsage | undefined,
	model?: ModelLike,
): TokenUsageRecord | undefined {
	if (!usage) return undefined;
	const normalized = costForUsage(usage, model);
	if (normalized.amounts.totalTokens === 0 && normalized.cost.total === 0) return undefined;

	const record: TokenUsageRecord = {
		version: STORE_VERSION,
		id: metadata.id,
		timestamp: normalizeTimestamp(metadata.timestamp),
		source: metadata.source,
		sessionId: metadata.sessionId,
		cwd: metadata.cwd,
		provider: metadata.provider,
		model: metadata.model,
		api: metadata.api,
		label: metadata.label,
		input: normalized.amounts.input,
		output: normalized.amounts.output,
		cacheRead: normalized.amounts.cacheRead,
		cacheWrite: normalized.amounts.cacheWrite,
		cacheWrite1h: normalized.amounts.cacheWrite1h || undefined,
		totalTokens: normalized.amounts.totalTokens,
		calls: Math.max(1, Math.floor(numberOrZero(usage.turns) || 1)),
		cost: normalized.cost,
		reportedCost: normalized.reportedCost,
		costBasis: normalized.basis,
	};
	return record;
}

function modelFor(
	ctx: ExtensionContext,
	provider: string | undefined,
	model: string | undefined,
): ModelLike | undefined {
	if (!provider || !model) return undefined;
	if (ctx.model?.provider === provider && ctx.model.id === model) return ctx.model;
	try {
		return ctx.modelRegistry.find(provider, model);
	} catch {
		return undefined;
	}
}

function recordFromMessage(
	message: MessageLike,
	sessionId: string,
	cwd: string | undefined,
	lookup: ModelLookup,
	timestampFallback?: unknown,
): TokenUsageRecord | undefined {
	const role = stringOrUndefined(message.role);
	const source: TokenUsageSource | undefined =
		role === "assistant" ? "main" : role === "toolResult" ? "tool" : undefined;
	if (!source) return undefined;
	const provider = stringOrUndefined(message.provider);
	const model = stringOrUndefined(message.model);
	return recordFromUsage(
		{
			id: messageRecordId(sessionId, message, source),
			source,
			timestamp: message.timestamp ?? timestampFallback,
			sessionId,
			cwd,
			provider,
			model,
			api: stringOrUndefined(message.api),
			label: source === "tool" ? stringOrUndefined(message.toolName) : undefined,
		},
		message.usage,
		lookup(provider, model),
	);
}

function validSource(value: unknown): value is TokenUsageSource {
	return value === "main" || value === "subagent" || value === "tool" || value === "compaction";
}

function parsePersistedRecord(value: unknown): TokenUsageRecord | undefined {
	const candidate = asRecord(value);
	if (!candidate || typeof candidate.id !== "string" || typeof candidate.timestamp !== "string") return undefined;
	if (!validSource(candidate.source)) return undefined;

	const input = numberOrZero(candidate.input);
	const output = numberOrZero(candidate.output);
	const cacheRead = numberOrZero(candidate.cacheRead);
	const cacheWrite = numberOrZero(candidate.cacheWrite);
	const reportedCost = normalizeCost(candidate.reportedCost ?? candidate.cost);
	const cost = normalizeCost(candidate.cost);
	const basis =
		candidate.costBasis === "reported" || candidate.costBasis === "estimated" || candidate.costBasis === "unknown"
			? candidate.costBasis
			: cost.total > 0
				? "reported"
				: "unknown";

	return {
		version: STORE_VERSION,
		id: candidate.id,
		timestamp: normalizeTimestamp(candidate.timestamp),
		source: candidate.source,
		sessionId: stringOrUndefined(candidate.sessionId),
		cwd: stringOrUndefined(candidate.cwd),
		provider: stringOrUndefined(candidate.provider),
		model: stringOrUndefined(candidate.model),
		api: stringOrUndefined(candidate.api),
		label: stringOrUndefined(candidate.label),
		input,
		output,
		cacheRead,
		cacheWrite,
		cacheWrite1h: numberOrZero(candidate.cacheWrite1h) || undefined,
		totalTokens: Math.max(numberOrZero(candidate.totalTokens), input + output + cacheRead + cacheWrite),
		calls: Math.max(1, Math.floor(numberOrZero(candidate.calls) || 1)),
		cost,
		reportedCost,
		costBasis: basis,
	};
}

function costBasisRank(basis: TokenUsageCostBasis): number {
	return basis === "reported" ? 2 : basis === "estimated" ? 1 : 0;
}

function deduplicateRecords(records: TokenUsageRecord[]): TokenUsageRecord[] {
	const byId = new Map<string, TokenUsageRecord>();
	for (const record of records) {
		const previous = byId.get(record.id);
		if (!previous || costBasisRank(record.costBasis) > costBasisRank(previous.costBasis))
			byId.set(record.id, record);
	}
	return [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function usageFromRecord(record: TokenUsageRecord): ReturnType<typeof normalizeAmounts> {
	return {
		input: record.input,
		output: record.output,
		cacheRead: record.cacheRead,
		cacheWrite: record.cacheWrite,
		cacheWrite1h: record.cacheWrite1h ?? 0,
		totalTokens: record.totalTokens,
	};
}

function enrichRecord(record: TokenUsageRecord, lookup: ModelLookup): TokenUsageRecord {
	if (record.costBasis === "reported" || record.totalTokens === 0) return record;
	const estimated = modelCost(lookup(record.provider, record.model), usageFromRecord(record));
	return estimated ? { ...record, cost: estimated, costBasis: "estimated" } : record;
}

export async function readUsageLog(file = usageFilePath()): Promise<TokenUsageRecord[]> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const records: TokenUsageRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = parsePersistedRecord(JSON.parse(line));
			if (record) records.push(record);
		} catch {
			// A partially written or manually damaged line must not hide the rest
			// of the append-only history.
		}
	}
	return deduplicateRecords(records);
}

let pendingWrites: Promise<void> = Promise.resolve();

async function appendUsageRecords(records: TokenUsageRecord[], file = usageFilePath()): Promise<void> {
	if (records.length === 0) return;
	const operation = pendingWrites.then(async () => {
		await mkdir(dirname(file), { recursive: true, mode: 0o700 });
		await appendFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	});
	pendingWrites = operation.catch(() => undefined);
	await operation;
}

async function appendUsageRecord(record: TokenUsageRecord, file = usageFilePath()): Promise<void> {
	await appendUsageRecords([record], file);
}

async function waitForWrites(): Promise<void> {
	await pendingWrites.catch(() => undefined);
}

function usageFilePath(): string {
	const configured = process.env.PI_TOKEN_USAGE_FILE?.trim();
	if (configured) {
		const expanded = configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
		return isAbsolute(expanded) ? expanded : resolve(expanded);
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, DEFAULT_STORE_NAME);
}

async function sessionFiles(root: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await sessionFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

function sessionRecordId(sessionId: string, entry: SessionEntryLike, suffix: string): string {
	const entryId = stringOrUndefined(entry.id);
	return `${suffix}:${sessionId}:${entryId ?? hashIdentity(JSON.stringify(entry))}`;
}

/** Parse one Pi session file. Exported for deterministic tests and migrations. */
export function parseSessionUsage(
	text: string,
	sessionFile: string,
	lookup: ModelLookup = () => undefined,
): TokenUsageRecord[] {
	const entries: Array<SessionHeaderLike | SessionEntryLike> = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as SessionHeaderLike | SessionEntryLike;
			if (parsed && typeof parsed === "object") entries.push(parsed);
		} catch {
			// Ignore a currently-open session's incomplete final line.
		}
	}

	const header = entries[0] as SessionHeaderLike | undefined;
	const sessionId = stringOrUndefined(header?.id) ?? `file:${sessionFile}`;
	const cwd = stringOrUndefined(header?.cwd);
	const records: TokenUsageRecord[] = [];

	for (const entry of entries.slice(1) as SessionEntryLike[]) {
		if (entry.type === "message") {
			const record = recordFromMessage(entry.message ?? {}, sessionId, cwd, lookup, entry.timestamp);
			if (record) records.push(record);
			continue;
		}

		if (entry.type === "compaction" && entry.usage) {
			const provider = stringOrUndefined(entry.provider);
			const model = stringOrUndefined(entry.model);
			const record = recordFromUsage(
				{
					id: sessionRecordId(sessionId, entry, "compaction"),
					source: "compaction",
					timestamp: entry.timestamp,
					sessionId,
					cwd,
					provider,
					model,
					api: stringOrUndefined(entry.api),
				},
				entry.usage,
				lookup(provider, model),
			);
			if (record) records.push(record);
			continue;
		}

		if (entry.type !== "custom" || entry.customType !== SUBAGENT_RUN_ENTRY_TYPE) continue;
		const data = asRecord(entry.data);
		if (!data) continue;
		const usage = asRecord(data.usage);
		if (!usage) continue;
		const qualified = stringOrUndefined(data.model);
		const split = splitQualifiedModel(qualified);
		const provider = stringOrUndefined(data.provider) ?? split.provider;
		const model = stringOrUndefined(data.modelId) ?? split.model;
		const record = recordFromUsage(
			{
				id: `subagent:${stringOrUndefined(data.runId) ?? sessionRecordId(sessionId, entry, "run")}`,
				source: "subagent",
				timestamp: data.startedAt ?? entry.timestamp,
				sessionId,
				cwd,
				provider,
				model,
				label: stringOrUndefined(data.name),
			},
			usage,
			lookup(provider, model),
		);
		if (record) records.push(record);
	}

	return records;
}

async function scanSessions(ctx: ExtensionContext): Promise<TokenUsageRecord[]> {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	const roots = new Set<string>([join(agentDir, "sessions")]);
	const currentSessionDir = ctx.sessionManager.getSessionDir();
	if (currentSessionDir && currentSessionDir !== ".") roots.add(currentSessionDir);
	const files = new Set<string>();
	for (const root of roots) {
		for (const file of await sessionFiles(root)) files.add(file);
	}
	const lookup: ModelLookup = (provider, model) => modelFor(ctx, provider, model);
	const records: TokenUsageRecord[] = [];
	for (const file of files) {
		try {
			records.push(...parseSessionUsage(await readFile(file, "utf8"), file, lookup));
		} catch {
			// Sessions can disappear while /resume or cleanup is in progress.
		}
	}
	return records;
}

async function loadAndSynchronize(ctx: ExtensionContext): Promise<TokenUsageRecord[]> {
	await waitForWrites();
	const file = usageFilePath();
	const current = await readUsageLog(file);
	const known = new Set(current.map((record) => record.id));
	const recovered = await scanSessions(ctx);
	const missing = recovered.filter((record) => !known.has(record.id));
	await appendUsageRecords(missing, file);
	if (missing.length === 0) return current;
	return deduplicateRecords([...current, ...missing]);
}

function emptyBreakdown(): UsageBreakdown {
	return {
		calls: 0,
		totalTokens: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: emptyCost(),
	};
}

function addBreakdown(target: UsageBreakdown, record: TokenUsageRecord): void {
	target.calls += record.calls;
	target.totalTokens += record.totalTokens;
	target.input += record.input;
	target.output += record.output;
	target.cacheRead += record.cacheRead;
	target.cacheWrite += record.cacheWrite;
	target.cost.input += record.cost.input;
	target.cost.output += record.cost.output;
	target.cost.cacheRead += record.cost.cacheRead;
	target.cost.cacheWrite += record.cost.cacheWrite;
	target.cost.total += record.cost.total;
}

export function aggregateUsage(records: TokenUsageRecord[], range?: TimeRange): UsageAggregate {
	const aggregate: UsageAggregate = {
		...emptyBreakdown(),
		from: range?.from,
		to: range?.to,
		bySource: {},
		byModel: {},
		estimatedCalls: 0,
		unknownCostCalls: 0,
		reportedCost: 0,
	};
	for (const record of records) {
		const timestamp = timestampMilliseconds(record.timestamp);
		if (timestamp === undefined) continue;
		if (range?.from !== undefined && timestamp < range.from) continue;
		if (range?.to !== undefined && timestamp >= range.to) continue;

		addBreakdown(aggregate, record);
		const source = aggregate.bySource[record.source] ?? (aggregate.bySource[record.source] = emptyBreakdown());
		addBreakdown(source, record);
		const model = record.provider && record.model ? `${record.provider}/${record.model}` : "(unknown model)";
		const byModel = aggregate.byModel[model] ?? (aggregate.byModel[model] = emptyBreakdown());
		addBreakdown(byModel, record);
		if (record.costBasis === "estimated") aggregate.estimatedCalls += record.calls;
		if (record.costBasis === "unknown") aggregate.unknownCostCalls += record.calls;
		aggregate.reportedCost += record.reportedCost.total;
	}
	return aggregate;
}

function formatInteger(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatMoney(value: number): string {
	if (value === 0) return "$0.0000";
	if (Math.abs(value) < 0.01) return `$${value.toFixed(6)}`;
	return `$${value.toFixed(4)}`;
}

function formatBreakdown(label: string, breakdown: UsageBreakdown): string {
	return `${label}: ${breakdown.calls.toLocaleString("en-US")} call${breakdown.calls === 1 ? "" : "s"} · ${formatInteger(breakdown.totalTokens)} tokens · ${formatMoney(breakdown.cost.total)}`;
}

function sortedBreakdowns(breakdowns: Record<string, UsageBreakdown>): Array<[string, UsageBreakdown]> {
	return Object.entries(breakdowns).sort(([, left], [, right]) => {
		if (right.cost.total !== left.cost.total) return right.cost.total - left.cost.total;
		return right.totalTokens - left.totalTokens;
	});
}

function formatTimestampBound(value: number): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function localDayKey(timestamp: number): string {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function rangeDescription(range: TimeRange): string {
	const from = range.from === undefined ? "beginning" : formatTimestampBound(range.from);
	const to = range.to === undefined ? "now" : formatTimestampBound(range.to);
	return `${range.label} (${from} → ${to})`;
}

export function formatReport(
	records: TokenUsageRecord[],
	range: TimeRange,
	groupBy: "summary" | "day" | "model" | "source" = "summary",
	storeFile = usageFilePath(),
): string {
	const aggregate = aggregateUsage(records, range);
	const lines = [`Token usage · ${rangeDescription(range)}`, `Store: ${storeFile}`, ""];
	if (aggregate.calls === 0) {
		lines.push("No token usage recorded in this period.");
		return lines.join("\n");
	}

	lines.push(
		`Calls: ${formatInteger(aggregate.calls)} (${Object.entries(aggregate.bySource)
			.map(([source, breakdown]) => `${source} ${formatInteger(breakdown.calls)}`)
			.join(" · ")})`,
	);
	lines.push(`Tokens: ${formatInteger(aggregate.totalTokens)}`);
	lines.push(
		`  input ${formatInteger(aggregate.input)} · output ${formatInteger(aggregate.output)} · cache read ${formatInteger(aggregate.cacheRead)} · cache write ${formatInteger(aggregate.cacheWrite)}`,
	);
	lines.push(`API-equivalent cost: ${formatMoney(aggregate.cost.total)}`);
	lines.push(
		`  input ${formatMoney(aggregate.cost.input)} · output ${formatMoney(aggregate.cost.output)} · cache read ${formatMoney(aggregate.cost.cacheRead)} · cache write ${formatMoney(aggregate.cost.cacheWrite)}`,
	);
	if (aggregate.estimatedCalls > 0) {
		lines.push(`Cost basis: ${formatInteger(aggregate.estimatedCalls)} call(s) estimated from model pricing.`);
	} else if (aggregate.unknownCostCalls > 0) {
		lines.push(`Cost basis: ${formatInteger(aggregate.unknownCostCalls)} call(s) had no model pricing available.`);
	} else {
		lines.push("Cost basis: Pi-reported model pricing.");
	}
	lines.push("Subscription charges are not billed per API call; this is the equivalent API cost.");

	const appendGroup = (title: string, groups: Record<string, UsageBreakdown>, limit: number): void => {
		const rows = sortedBreakdowns(groups).slice(0, limit);
		if (rows.length === 0) return;
		lines.push("", title);
		for (const [label, breakdown] of rows) lines.push(`  ${formatBreakdown(label, breakdown)}`);
		if (Object.keys(groups).length > limit) lines.push(`  … ${Object.keys(groups).length - limit} more`);
	};

	if (groupBy === "source" || groupBy === "summary") appendGroup("By source:", aggregate.bySource, MAX_SOURCE_ROWS);
	if (groupBy === "model" || groupBy === "summary") appendGroup("By model:", aggregate.byModel, MAX_MODEL_ROWS);
	if (groupBy === "day") {
		const byDay: Record<string, UsageBreakdown> = {};
		for (const record of records) {
			const timestamp = timestampMilliseconds(record.timestamp);
			if (timestamp === undefined) continue;
			if (range.from !== undefined && timestamp < range.from) continue;
			if (range.to !== undefined && timestamp >= range.to) continue;
			const day = localDayKey(timestamp);
			const breakdown = byDay[day] ?? (byDay[day] = emptyBreakdown());
			addBreakdown(breakdown, record);
		}
		appendGroup("By day:", byDay, MAX_MODEL_ROWS);
	}

	return lines.join("\n");
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addCalendarMonths(date: Date, amount: number): Date {
	const result = new Date(date);
	const day = result.getDate();
	result.setDate(1);
	result.setMonth(result.getMonth() + amount);
	const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
	result.setDate(Math.min(day, lastDay));
	return result;
}

function addCalendarYears(date: Date, amount: number): Date {
	const result = new Date(date);
	const month = result.getMonth();
	const day = result.getDate();
	result.setDate(1);
	result.setFullYear(result.getFullYear() + amount);
	result.setMonth(month);
	const lastDay = new Date(result.getFullYear(), month + 1, 0).getDate();
	result.setDate(Math.min(day, lastDay));
	return result;
}

function parseEndpoint(value: string, position: "start" | "end", now: Date): number {
	const token = value.trim().replace(/^['"]|['"]$/g, "");
	if (token.toLowerCase() === "now") return now.getTime();
	let match = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match) {
		const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
		if (position === "end") date.setDate(date.getDate() + 1);
		return date.getTime();
	}
	match = token.match(/^(\d{4})-(\d{2})$/);
	if (match) {
		const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
		if (position === "end") date.setMonth(date.getMonth() + 1);
		return date.getTime();
	}
	match = token.match(/^(\d{4})$/);
	if (match) {
		const date = new Date(Number(match[1]), 0, 1);
		if (position === "end") date.setFullYear(date.getFullYear() + 1);
		return date.getTime();
	}

	const parsed = Date.parse(token);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid date/time: ${value}`);
	return parsed;
}

function calendarRange(
	kind: "today" | "yesterday" | "week" | "last-week" | "month" | "last-month" | "year" | "last-year",
	now: Date,
): TimeRange {
	const today = startOfDay(now);
	if (kind === "today") return { from: today.getTime(), to: addCalendarDays(today, 1).getTime(), label: "today" };
	if (kind === "yesterday") {
		const from = addCalendarDays(today, -1);
		return { from: from.getTime(), to: today.getTime(), label: "yesterday" };
	}
	if (kind === "week" || kind === "last-week") {
		const monday = addCalendarDays(today, -((today.getDay() + 6) % 7));
		const from = kind === "last-week" ? addCalendarDays(monday, -7) : monday;
		return {
			from: from.getTime(),
			to: addCalendarDays(from, 7).getTime(),
			label: kind === "week" ? "this week" : "last week",
		};
	}
	if (kind === "month" || kind === "last-month") {
		const first = new Date(today.getFullYear(), today.getMonth(), 1);
		const from = kind === "last-month" ? addCalendarMonths(first, -1) : first;
		return {
			from: from.getTime(),
			to: addCalendarMonths(from, 1).getTime(),
			label: kind === "month" ? "this month" : "last month",
		};
	}
	const first = new Date(today.getFullYear(), 0, 1);
	const from = kind === "last-year" ? addCalendarYears(first, -1) : first;
	return {
		from: from.getTime(),
		to: addCalendarYears(from, 1).getTime(),
		label: kind === "year" ? "this year" : "last year",
	};
}

function addCalendarDays(date: Date, amount: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + amount);
	return result;
}

function subtractDuration(now: Date, amount: number, unit: string): Date {
	const normalized = unit.toLowerCase();
	if (normalized.startsWith("mo")) return addCalendarMonths(now, -amount);
	if (normalized.startsWith("y")) return addCalendarYears(now, -amount);
	const milliseconds: Record<string, number> = {
		ms: 1,
		millisecond: 1,
		milliseconds: 1,
		s: 1_000,
		sec: 1_000,
		second: 1_000,
		seconds: 1_000,
		m: 60_000,
		min: 60_000,
		minute: 60_000,
		minutes: 60_000,
		h: 3_600_000,
		hour: 3_600_000,
		hours: 3_600_000,
		d: 86_400_000,
		day: 86_400_000,
		days: 86_400_000,
		w: 604_800_000,
		week: 604_800_000,
		weeks: 604_800_000,
	};
	const multiplier = milliseconds[normalized];
	if (!multiplier) throw new Error(`Invalid duration unit: ${unit}`);
	return new Date(now.getTime() - amount * multiplier);
}

function durationRange(value: string, now: Date): TimeRange | undefined {
	const match = value.match(
		/^(?:last|past)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|w|weeks?|mo|months?|y|years?)$/i,
	);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const from = subtractDuration(now, amount, match[2]);
	return { from: from.getTime(), to: now.getTime(), label: `last ${match[1]} ${match[2]}` };
}

function boundedRange(fromValue: string | undefined, toValue: string | undefined, now: Date): TimeRange {
	const from = fromValue ? parseEndpoint(fromValue, "start", now) : undefined;
	const to = toValue ? parseEndpoint(toValue, "end", now) : now.getTime();
	if (from !== undefined && to !== undefined && from > to)
		throw new Error("The period start must not be after its end.");
	return {
		from,
		to,
		label: `${fromValue ?? "beginning"} → ${toValue ?? "now"}`,
	};
}

/** Parse aliases, durations, ISO dates, and arbitrary inclusive date ranges. */
export function parseTimeRange(expression = "all", now = new Date()): TimeRange {
	const value = expression.trim().replace(/\s+/g, " ");
	if (!value || /^(?:all|all-time|forever)$/i.test(value)) return { label: "all time" };
	if (/^today$/i.test(value)) return calendarRange("today", now);
	if (/^yesterday$/i.test(value)) return calendarRange("yesterday", now);
	if (/^(?:week|this week|this-week)$/i.test(value)) return calendarRange("week", now);
	if (/^(?:last week|last-week)$/i.test(value)) return calendarRange("last-week", now);
	if (/^(?:month|this month|this-month)$/i.test(value)) return calendarRange("month", now);
	if (/^(?:last month|last-month)$/i.test(value)) return calendarRange("last-month", now);
	if (/^(?:year|this year|this-year)$/i.test(value)) return calendarRange("year", now);
	if (/^(?:last year|last-year)$/i.test(value)) return calendarRange("last-year", now);

	const duration = durationRange(value, now);
	if (duration) return duration;

	let match = value.match(/^since\s+(.+)$/i);
	if (match) return boundedRange(match[1], undefined, now);
	match = value.match(/^until\s+(.+)$/i);
	if (match) return boundedRange(undefined, match[1], now);
	match = value.match(/^from\s+(.+?)\s+(?:to|until)\s+(.+)$/i);
	if (match) return boundedRange(match[1], match[2], now);

	const rangeParts = value.split(/\s*\.\.\s*/);
	if (rangeParts.length === 2) return boundedRange(rangeParts[0], rangeParts[1], now);
	const toParts = value.match(/^(.+?)\s+to\s+(.+)$/i);
	if (toParts) return boundedRange(toParts[1], toParts[2], now);

	const twoEndpoints = value.match(/^(\S+)\s+(\S+)$/);
	if (twoEndpoints) {
		try {
			return boundedRange(twoEndpoints[1], twoEndpoints[2], now);
		} catch {
			// Continue to report the more useful single-expression error below.
		}
	}

	if (/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) {
		return boundedRange(value, value, now);
	}
	if (
		/^\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|w|weeks?|mo|months?|y|years?)$/i.test(
			value,
		)
	) {
		return durationRange(`last ${value}`, now)!;
	}

	const parsed = parseEndpoint(value, "start", now);
	return { from: parsed, to: now.getTime(), label: `since ${value}` };
}

function parseCommandArgs(args: string): {
	period?: string;
	from?: string;
	to?: string;
	groupBy: "summary" | "day" | "model" | "source";
} {
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	const positional: string[] = [];
	let from: string | undefined;
	let to: string | undefined;
	let groupBy: "summary" | "day" | "model" | "source" = "summary";
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const next = tokens[index + 1];
		const match = token.match(/^--?(from|to|by|group-by)=(.+)$/i);
		if (match) {
			if (match[1].toLowerCase() === "from") from = match[2];
			else if (match[1].toLowerCase() === "to") to = match[2];
			else if (["summary", "day", "model", "source"].includes(match[2])) groupBy = match[2] as typeof groupBy;
			continue;
		}
		if (/^--?(from|to|by|group-by)$/i.test(token) && next) {
			const key = token.replace(/^-+/, "").toLowerCase();
			if (key === "from") from = next;
			else if (key === "to") to = next;
			else if (["summary", "day", "model", "source"].includes(next)) groupBy = next as typeof groupBy;
			index += 1;
			continue;
		}
		positional.push(token);
	}
	return { period: positional.join(" ") || undefined, from, to, groupBy };
}

function rangeFromParams(params: { period?: string; from?: string; to?: string }, now = new Date()): TimeRange {
	if (params.from || params.to) return boundedRange(params.from, params.to, now);
	return parseTimeRange(params.period ?? "all", now);
}

function notifyStorageError(ctx: ExtensionContext, error: unknown): void {
	ctx.ui.notify(
		`Token tracker could not persist usage: ${error instanceof Error ? error.message : String(error)}`,
		"warning",
	);
}

export default function tokenTrackerExtension(pi: ExtensionAPI): void {
	let currentContext: ExtensionContext | undefined;
	const seenLiveRecords = new Set<string>();

	const persist = async (record: TokenUsageRecord, ctx?: ExtensionContext): Promise<void> => {
		if (seenLiveRecords.has(record.id)) return;
		seenLiveRecords.add(record.id);
		try {
			await appendUsageRecord(record);
		} catch (error) {
			seenLiveRecords.delete(record.id);
			if (ctx) notifyStorageError(ctx, error);
		}
	};

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n[TOKEN TRACKER CAPABILITY] Persistent token usage is recorded across Pi sessions, including subagents. Use /tokens for reports. It accepts all, today, yesterday, week, month, year, last 7d, since YYYY-MM-DD, until YYYY-MM-DD, or arbitrary ranges such as YYYY-MM-DD..YYYY-MM-DD. Costs are equivalent API pricing; subscription charges are not billed per API call.`,
	}));

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		ctx.ui.setStatus("token-tracker", "tracking tokens");
	});

	pi.on("message_end", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const record = recordFromMessage(event.message as MessageLike, sessionId, ctx.cwd, (provider, model) => {
			return modelFor(ctx, provider, model);
		});
		if (record) await persist(record, ctx);
	});

	pi.on("session_compact", async (event, ctx) => {
		const compaction = event.compactionEntry as unknown as SessionEntryLike;
		const provider = stringOrUndefined(compaction.provider) ?? ctx.model?.provider;
		const model = stringOrUndefined(compaction.model) ?? ctx.model?.id;
		const record = recordFromUsage(
			{
				id: sessionRecordId(ctx.sessionManager.getSessionId(), compaction, "compaction"),
				source: "compaction",
				timestamp: compaction.timestamp,
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				provider,
				model,
				api: stringOrUndefined(compaction.api),
			},
			compaction.usage,
			modelFor(ctx, provider, model),
		);
		if (record) await persist(record, ctx);
	});

	pi.events.on(TOKEN_USAGE_EVENT, (payload) => {
		const event = asRecord(payload) as Partial<TokenUsageEvent> | undefined;
		if (!event || !validSource(event.source) || !event.usage) return;
		const split = splitQualifiedModel(stringOrUndefined(event.model));
		const provider = stringOrUndefined(event.provider) ?? split.provider;
		const model = split.model ?? stringOrUndefined(event.model);
		const record = recordFromUsage(
			{
				id: stringOrUndefined(event.recordId) ?? `subagent:event:${hashIdentity(JSON.stringify(payload))}`,
				source: event.source,
				timestamp: event.timestamp,
				sessionId: stringOrUndefined(event.sessionId),
				cwd: stringOrUndefined(event.cwd),
				provider,
				model,
				api: stringOrUndefined(event.api),
				label: stringOrUndefined(event.label),
			},
			event.usage,
		);
		if (record) void persist(record, currentContext);
	});

	const report = async (
		params: { period?: string; from?: string; to?: string; groupBy?: "summary" | "day" | "model" | "source" },
		ctx: ExtensionContext,
	): Promise<string> => {
		const range = rangeFromParams(params);
		const records = await loadAndSynchronize(ctx);
		const lookup: ModelLookup = (provider, model) => modelFor(ctx, provider, model);
		const enriched = records.map((record) => enrichRecord(record, lookup));
		return formatReport(enriched, range, params.groupBy ?? "summary");
	};

	pi.registerCommand("tokens", {
		description: "Show persistent token usage and equivalent API costs for any time period",
		handler: async (args, ctx) => {
			try {
				const options = parseCommandArgs(args);
				ctx.ui.notify(await report(options, ctx), "info");
			} catch (error) {
				ctx.ui.notify(
					`Token report failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerTool({
		name: "token_usage",
		label: "Token usage",
		description:
			"Query persistent Pi token usage and equivalent API cost across sessions, including subagent calls.",
		promptSnippet: "Query persistent token usage and equivalent API costs for an arbitrary period",
		promptGuidelines: [
			"Use token_usage when the user asks how many tokens Pi used or what the equivalent API cost was.",
			"token_usage supports period aliases, durations, ISO dates, arbitrary ranges, and separate from/to bounds.",
			"token_usage reports subscription usage as equivalent API pricing rather than claiming a subscription was billed per call.",
		],
		parameters: TokenUsageParams,
		execute: async (_toolCallId, params: TokenUsageParamsType, _signal, _onUpdate, ctx) => {
			try {
				const text = await report(params, ctx);
				return { content: [{ type: "text" as const, text }], details: { period: params.period ?? "all" } };
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Token report failed: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			const period = sanitizeToolOutput(args.period || args.from || "all time").replace(/\s+/g, " ").slice(0, 80);
			return new Text(theme.fg("toolTitle", theme.bold("token_usage ")) + theme.fg("accent", period), 0, 0);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult("token_usage", result, options, theme, context, {
				collapsedSummary: (toolResult) => {
					if (context.isError) return "Token report failed";
					return "Token usage report ready · expand for details";
				},
			});
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await waitForWrites();
		ctx.ui.setStatus("token-tracker", undefined);
		currentContext = undefined;
	});
}
