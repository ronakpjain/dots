import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import tokenTrackerExtension, {
	aggregateUsage,
	formatReport,
	parseSessionUsage,
	parseTimeRange,
	readUsageLog,
	type TokenUsageRecord,
} from "../extensions/token-tracker.ts";

const MODEL = {
	provider: "fake",
	id: "model",
	cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 },
};

function record(overrides: Partial<TokenUsageRecord>): TokenUsageRecord {
	return {
		version: 1,
		id: "record",
		timestamp: "2026-01-02T00:00:00.000Z",
		source: "main",
		input: 100,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 120,
		calls: 1,
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		reportedCost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		costBasis: "reported",
		...overrides,
	};
}

test("parses calendar, duration, and arbitrary date periods", () => {
	const now = new Date("2026-08-20T12:34:56.000Z");
	const lastWeek = parseTimeRange("last 7d", now);
	expect(lastWeek.to).toBe(now.getTime());
	expect(lastWeek.to! - lastWeek.from!).toBe(7 * 24 * 60 * 60 * 1000);

	const day = parseTimeRange("2026-01-02", now);
	expect(day.to! - day.from!).toBe(24 * 60 * 60 * 1000);
	const range = parseTimeRange("2026-01-01..2026-01-31", now);
	expect(range.to! - range.from!).toBe(31 * 24 * 60 * 60 * 1000);

	const since = parseTimeRange("since 2026-01-01", now);
	expect(since.from).toBe(parseTimeRange("2026-01-01", now).from);
	expect(since.to).toBe(now.getTime());
});

test("collapsed token reports use a fixed safe summary", () => {
	let tokenTool: any;
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: any) => {
			if (definition.name === "token_usage") tokenTool = definition;
		},
		events: { on: () => () => {} },
	};
	tokenTrackerExtension(pi as never);
	const escape = String.fromCharCode(27);
	const secretPeriod = `period${escape}[31mcredential-value`;
	const component = tokenTool.renderResult(
		{ content: [{ type: "text", text: "report" }], details: { period: secretPeriod } },
		{ expanded: false },
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
		{ isError: false },
	);
	const output = component.render(100).join("\n");
	expect(output).toContain("Token usage report ready");
	expect(output).not.toContain("credential-value");
	expect(output).not.toContain(`${escape}[`);
});

test("recovers main, compaction, and subagent usage from a session", () => {
	const session = [
		JSON.stringify({ type: "session", id: "session-1", cwd: "/tmp/project" }),
		JSON.stringify({
			type: "message",
			id: "assistant-1",
			timestamp: "2026-01-02T00:00:00.000Z",
			message: {
				role: "assistant",
				provider: "fake",
				model: "model",
				api: "fake-api",
				usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0 } },
			},
		}),
		JSON.stringify({
			type: "custom",
			id: "run-entry",
			timestamp: "2026-01-02T00:01:00.000Z",
			customType: "subagent-run",
			data: {
				runId: "run-1",
				name: "scout",
				model: "fake/model",
				startedAt: "2026-01-02T00:01:00.000Z",
				usage: { input: 50, output: 10, cacheRead: 5, cacheWrite: 0, turns: 3, cost: 0.5 },
			},
		}),
		JSON.stringify({
			type: "compaction",
			id: "compact-1",
			timestamp: "2026-01-02T00:02:00.000Z",
			usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.01 } },
		}),
	].join("\n");

	const records = parseSessionUsage(session, "/tmp/session.jsonl", (provider, model) => {
		return provider === MODEL.provider && model === MODEL.id ? MODEL : undefined;
	});
	expect(records.map((item) => item.source)).toEqual(["main", "subagent", "compaction"]);
	expect(records.find((item) => item.source === "subagent")?.totalTokens).toBe(65);
	expect(records.find((item) => item.source === "subagent")?.calls).toBe(3);
	expect(records.find((item) => item.source === "main")?.costBasis).toBe("estimated");
});

test("aggregates usage and formats API-equivalent cost", () => {
	const records = [
		record({ id: "a", timestamp: "2026-01-01T00:00:00.000Z" }),
		record({
			id: "b",
			source: "subagent",
			timestamp: "2026-01-03T00:00:00.000Z",
			totalTokens: 50,
			calls: 3,
			input: 40,
			output: 10,
		}),
	];
	const aggregate = aggregateUsage(
		records,
		parseTimeRange("2026-01-02..2026-01-03", new Date("2026-01-10T00:00:00Z")),
	);
	expect(aggregate.calls).toBe(3);
	expect(aggregate.totalTokens).toBe(50);
	expect(formatReport(records, { label: "test", from: 0, to: Number.MAX_SAFE_INTEGER }, "source")).toContain(
		"API-equivalent cost",
	);
});

test("persists live main and subagent usage across extension sessions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-token-tracker-"));
	const file = join(directory, "usage.jsonl");
	const previousFile = process.env.PI_TOKEN_USAGE_FILE;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_TOKEN_USAGE_FILE = file;
	process.env.PI_CODING_AGENT_DIR = directory;

	try {
		const handlers = new Map<string, (...args: any[]) => any>();
		const commands = new Map<string, { handler: (...args: any[]) => any }>();
		const busHandlers = new Map<string, (data: unknown) => void>();
		const notifications: string[] = [];
		const ctx = {
			cwd: "/tmp/project",
			mode: "tui",
			hasUI: true,
			model: MODEL,
			ui: {
				setStatus: () => {},
				notify: (message: string) => notifications.push(message),
			},
			sessionManager: {
				getSessionId: () => "live-session",
				getSessionDir: () => join(directory, "sessions"),
			},
			modelRegistry: { find: () => MODEL },
		};
		const pi = {
			on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
			registerCommand: (name: string, definition: { handler: (...args: any[]) => any }) =>
				commands.set(name, definition),
			registerTool: () => {},
			events: {
				on: (name: string, handler: (data: unknown) => void) => {
					busHandlers.set(name, handler);
					return () => {};
				},
				emit: () => {},
			},
		};
		tokenTrackerExtension(pi as never);

		await handlers.get("message_end")!(
			{
				message: {
					role: "assistant",
					provider: "fake",
					model: "model",
					timestamp: "2026-01-02T00:00:00.000Z",
					usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0 } },
				},
			},
			ctx,
		);
		busHandlers.get("pi-token-usage")!({
			recordId: "subagent:run-1",
			source: "subagent",
			timestamp: "2026-01-02T00:01:00.000Z",
			sessionId: "live-session",
			provider: "fake",
			model: "model",
			usage: { input: 50, output: 5, totalTokens: 55, turns: 2, cost: { total: 0 } },
		});

		await commands.get("tokens")!.handler("2026-01-02", ctx);
		const saved = await readUsageLog(file);
		expect(saved).toHaveLength(2);
		expect(saved.map((item) => item.source)).toEqual(["main", "subagent"]);
		expect(saved.find((item) => item.source === "subagent")?.calls).toBe(2);
		expect(notifications[0]).toContain("165 tokens");
	} finally {
		if (previousFile === undefined) delete process.env.PI_TOKEN_USAGE_FILE;
		else process.env.PI_TOKEN_USAGE_FILE = previousFile;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});
