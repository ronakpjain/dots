/**
 * Deterministic tests for the subagents extension (runner events + TUI helpers).
 * Run with: bun test agent/tests/subagents.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	runSubagent,
	getFinalOutput,
	type SubagentTaskSpec,
	type RunnerEvent,
} from "../extensions/subagents/runner.ts";
import {
	messageSegments,
	runDisplayName,
	statusIcon,
	truncateBytes,
	usageLine,
	formatTokens,
	formatElapsed,
	activityPlainText,
	renderRunResults,
	runMatchesFilter,
	SubagentsBrowser,
	type LiveRun,
	type RunActivity,
} from "../extensions/subagents/ui.ts";

beforeAll(() => initTheme("dark"));

const fakeModel = {
	id: "fake-model",
	name: "Fake Model",
	api: "openai-completions",
	provider: "fake",
	baseUrl: "",
	reasoning: false,
	thinkingLevelMap: undefined,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function getTestModel(id: string) {
	if (id === "fake/fake-model" || id === "fake-model") return fakeModel;
	if (id === "openai-codex/gpt-5.6-sol" || id === "openai-codex/gpt-5.6-luna") {
		const modelId = id.split("/")[1]!;
		return { ...fakeModel, id: modelId, name: modelId, provider: "openai-codex", reasoning: true };
	}
	return undefined;
}

type StubConfig = {
	toolTurns?: number;
	finalText?: string | ((context: any) => string);
};

function stubProvider(config: StubConfig) {
	let invocations = 0;
	const payloads: unknown[] = [];
	const streamSimple = async (model: unknown, context: any, options: any) => {
		const payload = { model: (model as { id?: string }).id, service_tier: "default" };
		const nextPayload = await options?.onPayload?.(payload, model);
		payloads.push(nextPayload ?? payload);

		const i = invocations++;
		const useTool = i < (config.toolTurns ?? 0);
		const text =
			typeof config.finalText === "function"
				? (config.finalText as (c: any) => string)(context)
				: (config.finalText ?? "fake-result");
		const content = useTool
			? [{ type: "toolCall", id: `tc-${i}`, name: "bash", arguments: { command: "echo hi" } }]
			: [{ type: "text", text }];
		const finalMsg: any = {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "fake",
			model: "fake-model",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0.001 } },
			stopReason: useTool ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		const gen = (async function* () {
			yield { type: "start", partial: finalMsg };
			if (!useTool) {
				yield { type: "text_delta", contentIndex: 0, delta: text, partial: finalMsg };
			}
			yield { type: "done", reason: useTool ? "toolUse" : "stop", message: finalMsg };
		})();
		const withResult = gen as unknown as { [Symbol.asyncIterator](): AsyncGenerator<any>; result(): any };
		withResult.result = () => finalMsg;
		return withResult;
	};
	return {
		provider: { streamSimple } as never,
		get invocations() {
			return invocations;
		},
		get payloads() {
			return payloads;
		},
	};
}

function spec(overrides: Partial<SubagentTaskSpec> = {}): SubagentTaskSpec {
	return {
		name: "test-agent",
		task: "do the thing",
		systemPrompt: "You are a test agent.",
		model: "fake/fake-model",
		...overrides,
	};
}

function opts(
	stub: ReturnType<typeof stubProvider>,
	extra: Partial<Parameters<typeof runSubagent>[1]> = {},
): Parameters<typeof runSubagent>[1] {
	return {
		defaultCwd: "/tmp",
		getModel: (id: string) => (id === "fake/fake-model" || id === "fake-model" ? fakeModel : undefined),
		getProvider: () => stub.provider,
		sessionCache: new Map(),
		...extra,
	} as Parameters<typeof runSubagent>[1];
}

const browserTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function browserRun(overrides: Partial<LiveRun> = {}): LiveRun {
	return {
		runId: "run-1",
		groupId: "group-123456789",
		groupSize: 3,
		kind: "parallel",
		step: 1,
		name: "worker",
		model: "fake-model",
		task: "inspect the implementation",
		status: "ok",
		startTime: Date.now() - 2_000,
		endTime: Date.now(),
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 30, turns: 1 },
		activities: [],
		messages: [],
		...overrides,
	};
}

function browserTui(rows = 24) {
	return { requestRender() {}, terminal: { rows } };
}

test("forces priority fast mode for Luna requests in the in-process runner", async () => {
	const stub = stubProvider({ finalText: "DONE" });
	const luna = await runSubagent(
		spec({ name: "custom", model: "openai-codex/gpt-5.6-luna" }),
		opts(stub, { getModel: getTestModel }),
	);
	const sol = await runSubagent(
		spec({ name: "custom", model: "openai-codex/gpt-5.6-sol" }),
		opts(stub, { getModel: getTestModel }),
	);

	expect(luna.exitCode).toBe(0);
	expect(sol.exitCode).toBe(0);
	expect(stub.payloads).toEqual([
		{ model: "gpt-5.6-luna", service_tier: "priority" },
		{ model: "gpt-5.6-sol", service_tier: "default" },
	]);
});

describe("subagent runner cancellation", () => {
	test("does not start a provider request when the parent is already aborted", async () => {
		const stub = stubProvider({ finalText: "MUST NOT RUN" });
		const controller = new AbortController();
		controller.abort();

		const result = await runSubagent(spec(), opts(stub, { signal: controller.signal }));

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(true);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toContain("canceled before start");
		expect(stub.invocations).toBe(0);
	});

	test("allows a final answer on the maxTurns boundary", async () => {
		const stub = stubProvider({ finalText: "DONE" });
		const result = await runSubagent(spec({ maxTurns: 1 }), opts(stub));

		expect(result.exitCode).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(result.maxTurnsKilled).toBe(false);
	});

	test("stops a tool loop at maxTurns with a specific diagnostic", async () => {
		const stub = stubProvider({ toolTurns: 2, finalText: "NEVER" });
		const result = await runSubagent(spec({ maxTurns: 1 }), opts(stub));

		expect(result.exitCode).toBe(1);
		expect(result.stopReason).toBe("maxTurns");
		expect(result.errorMessage).toBe("Exceeded maxTurns=1");
		expect(stub.invocations).toBe(2);
		expect(result.messages.some((message) => message.role === "toolResult" && message.isError)).toBe(true);
	});

	test("uses one finalization turn instead of killing a productive run at the boundary", async () => {
		const stub = stubProvider({ toolTurns: 1, finalText: "DONE AFTER FINALIZATION" });
		const result = await runSubagent(spec({ maxTurns: 1 }), opts(stub));

		expect(result.exitCode).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(result.maxTurnsKilled).toBe(false);
		expect(getFinalOutput(result.messages)).toBe("DONE AFTER FINALIZATION");
		expect(stub.invocations).toBe(2);
	});

	test("forces a timed-out run to settle when the provider ignores abort", async () => {
		const stub = stubProvider({});
		const sessionCache = new Map();
		const hangingProvider = { streamSimple: () => new Promise<never>(() => {}) };
		const events: RunnerEvent[] = [];
		const started = Date.now();
		const result = await runSubagent(
			spec({ timeoutSec: 0.02, keepSession: true }),
			opts(stub, {
				getProvider: () => hangingProvider as never,
				sessionCache,
				onEvent: (event) => events.push(event),
			}),
		);

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result.exitCode).toBe(1);
		expect(result.timeoutKilled).toBe(true);
		expect(result.stopReason).toBe("timeout");
		expect(result.errorMessage).toContain("did not settle");
		expect(events.some((event) => event.type === "status" && event.text.includes("timeout after 0.02s"))).toBe(true);
		expect(result.sessionId).toBeUndefined();
		expect(sessionCache.size).toBe(0);
	});
});

describe("subagent runner live events", () => {
	test("emits message events with usage", async () => {
		const stub = stubProvider({ finalText: "RESULT" });
		const events: RunnerEvent[] = [];
		const result = await runSubagent(spec(), opts(stub, { onEvent: (e) => events.push(e) }));
		expect(result.exitCode).toBe(0);
		expect(events.some((e) => e.type === "message" && getFinalOutput([(e as any).message]) === "RESULT")).toBe(
			true,
		);
		expect(events.filter((e) => e.type === "message").length).toBe(1);
	});

	test("emits tool + toolResult events with a result preview", async () => {
		const stub = stubProvider({ toolTurns: 1, finalText: "DONE" });
		const events: RunnerEvent[] = [];
		await runSubagent(spec(), opts(stub, { onEvent: (e) => events.push(e) }));

		const tool = events.find((e) => e.type === "tool") as Extract<RunnerEvent, { type: "tool" }> | undefined;
		expect(tool).toBeDefined();
		expect(tool!.name).toBe("bash");

		const toolResult = events.find((e) => e.type === "toolResult") as
			Extract<RunnerEvent, { type: "toolResult" }> | undefined;
		expect(toolResult).toBeDefined();
		expect(toolResult!.name).toBe("bash");
		expect(toolResult!.resultPreview).toContain("hi");
		expect(toolResult!.isError).toBe(false);
	});

	test("emits throttled thinking previews while streaming", async () => {
		const stub = stubProvider({ finalText: "THINK-ABOUT-THIS" });
		const events: RunnerEvent[] = [];
		await runSubagent(spec(), opts(stub, { onEvent: (e) => events.push(e) }));
		const thinking = events.find((e) => e.type === "thinking") as
			Extract<RunnerEvent, { type: "thinking" }> | undefined;
		expect(thinking).toBeDefined();
		expect(thinking!.text).toContain("THINK-ABOUT-THIS");
	});
});

describe("subagent ui helpers", () => {
	test("messageSegments interleaves assistant text, tool calls, and results", () => {
		const segments = messageSegments([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me look." },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
				],
			} as any,
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [
					{ type: "text", text: "file contents" },
					{ type: "image", mimeType: "image/png", data: "SECRET_IMAGE" },
				],
				details: { diff: "@@ -1 +1 @@\\n-old\\n+new" },
				isError: false,
			} as any,
			{
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
			} as any,
		]);

		expect(segments.map((s) => s.type)).toEqual(["text", "toolCall", "toolResult", "text"]);
		const call = segments[1]!;
		const result = segments[2]!;
		expect(call.type).toBe("toolCall");
		if (call.type === "toolCall") {
			expect(call.name).toBe("read");
			expect(call.args).toContain("a.ts");
		}
		if (result.type === "toolResult") {
			expect(result.name).toBe("read");
			expect(result.text).toContain("file contents");
			expect(result.text).toContain("[image · image/png content]");
			expect(result.text).not.toContain("SECRET_IMAGE");
			expect(result.details).toEqual({ diff: "@@ -1 +1 @@\\n-old\\n+new" });
			expect(result.turn).toBe(1);
		}
	});

	test("runMatchesFilter trims, ignores case, and ANDs terms across metadata", () => {
		const run = {
			name: "Worker",
			model: "openai-codex/gpt-5.6-luna",
			task: "Review the browser",
			kind: "chain",
			status: "error",
			stopReason: "maxTurns",
			groupId: "group-abc",
			sessionId: "session-xyz",
		};
		expect(runMatchesFilter(run, "  WORKER error  ")).toBe(true);
		expect(runMatchesFilter(run, "browser GROUP-ABC")).toBe(true);
		expect(runMatchesFilter(run, "session-xyz missing")).toBe(false);
		expect(runMatchesFilter(run, "   ")).toBe(true);
	});

	test("browser includes group context and adapts every line to narrow widths", () => {
		const runs = [browserRun(), browserRun({ runId: "run-2", status: "running", step: 2 })];
		const tui = browserTui(12);
		const browser = new SubagentsBrowser(browserTheme, tui, () => {}, () => runs);
		try {
			const rendered = browser.render(100);
			expect(rendered.join(" ")).toContain("group group-12");
			expect(rendered.join(" ")).toContain("step 1/3");
			expect(rendered.join(" ")).toContain("inspect the implementation");
			expect(rendered.join(" ")).toContain("model: fake-model");
			expect(rendered.length).toBeLessThanOrEqual(Math.floor(tui.terminal.rows * 0.8));
			for (const width of [1, 8, 24, 60]) {
				for (const line of browser.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
			}
		} finally {
			browser.dispose();
		}

		const tinyTui = browserTui(4);
		const tiny = new SubagentsBrowser(browserTheme, tinyTui, () => {}, () => runs);
		try {
			const tinyLines = tiny.render(24);
			expect(tinyLines.length).toBeLessThanOrEqual(Math.floor(tinyTui.terminal.rows * 0.8));
			expect(tinyLines.join(" ")).toContain("⚠");
		} finally {
			tiny.dispose();
		}
	});

	test("browser refreshes a cached row when a run completes", () => {
		const run = browserRun({ status: "running", endTime: undefined });
		const browser = new SubagentsBrowser(browserTheme, browserTui(), () => {}, () => [run]);
		try {
			expect(browser.render(60).join(" ")).toContain("running");
			run.status = "ok";
			run.endTime = Date.now();
			expect(browser.render(60).join(" ")).toContain("ok");
		} finally {
			browser.dispose();
		}
	});

	test("browser wraps fallback activities and keeps wrapped rows scrollable", () => {
		const run = browserRun({
			groupId: "",
			groupSize: undefined,
			activities: [
				{
					kind: "status",
					at: 12,
					text: `${"argument ".repeat(30)}TAIL_ACTIVITY`,
				},
			],
		});
		const tui = browserTui(20);
		const browser = new SubagentsBrowser(browserTheme, tui, () => {}, () => [run]);
		try {
			browser.render(24);
			browser.handleInput(String.fromCharCode(13));
			let sawActivity = false;
			let sawActivityLabel = false;
			for (let i = 0; i < 40 && !sawActivity; i++) {
				const rendered = browser.render(24).join(" ");
				sawActivity = rendered.includes("argument");
				sawActivityLabel = sawActivityLabel || rendered.includes("Activity");
				if (!sawActivity) browser.handleInput("j");
			}
			expect(sawActivityLabel).toBe(true);
			expect(sawActivity).toBe(true);
			let last = browser.render(24);
			for (let i = 0; i < 40 && !last.join(" ").includes("TAIL_ACTIVITY"); i++) {
				browser.handleInput("j");
				last = browser.render(24);
			}
			expect(last.join(" ")).toContain("TAIL_ACTIVITY");
			for (const line of last) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		} finally {
			browser.dispose();
		}
	});

	test("browser detail expands the full prompt and raw transcript", () => {
		const run = browserRun({
			task: `${"main-agent prompt ".repeat(40)}PROMPT_TAIL`,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: `${"transcript ".repeat(600)}TRANSCRIPT_TAIL` }],
				} as any,
			],
		});
		const browser = new SubagentsBrowser(browserTheme, browserTui(24), () => {}, () => [run]);
		try {
			browser.render(60);
			browser.handleInput(String.fromCharCode(13));
			const detailTop = browser.render(60).join(" ");
			expect(detailTop).toContain("Prompt");
			let sawConfig = false;
			for (let i = 0; i < 40 && !sawConfig; i++) {
				sawConfig = browser.render(60).join(" ").includes("Config");
				if (!sawConfig) browser.handleInput("j");
			}
			expect(sawConfig).toBe(true);
			browser.handleInput("g");
			let sawPromptTail = false;
			for (let i = 0; i < 300; i++) {
				if (browser.render(60).join(" ").includes("PROMPT_TAIL")) {
					sawPromptTail = true;
					break;
				}
				browser.handleInput("j");
			}
			expect(sawPromptTail).toBe(true);
			browser.handleInput("g");
			const collapsedStart = browser.render(60).join(" ");
			expect(collapsedStart).toContain("o expand");
			expect(collapsedStart).not.toContain("TRANSCRIPT_TAIL");

			browser.handleInput("G");
			const collapsed = browser.render(60).join(" ");
			expect(collapsed).toContain("[truncated]");
			expect(collapsed).not.toContain("TRANSCRIPT_TAIL");
			browser.handleInput("o");
			browser.handleInput("G");
			const expanded = browser.render(60).join(" ");
			expect(expanded).toContain("o collapse");
			expect(expanded).toContain("TRANSCRIPT_TAIL");
		} finally {
			browser.dispose();
		}
	});

	test("browser formats prose, code, and edit results with safe structured details", () => {
		const makeTranscriptRun = (
			toolName: string,
			text: string,
			args: Record<string, unknown>,
			details?: unknown,
			activities: RunActivity[] = [],
		) =>
			browserRun({
				activities,
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "tool-call", name: toolName, arguments: args }],
					} as any,
					{
						role: "toolResult",
						toolCallId: "tool-call",
						toolName,
						content: [{ type: "text", text }],
						details,
						isError: false,
					} as any,
				],
			});
		const renderDetail = (run: LiveRun, width = 52, expanded = false) => {
			const browser = new SubagentsBrowser(browserTheme, browserTui(60), () => {}, () => [run]);
			try {
				browser.render(width);
				browser.handleInput(String.fromCharCode(13));
				if (expanded) browser.handleInput("o");
				browser.handleInput("G");
				return browser.render(width).join("\n");
			} finally {
				browser.dispose();
			}
		};

		const prose = renderDetail(
			makeTranscriptRun("bash", `${"Plain prose output should wrap naturally. ".repeat(8)}\u001b[31mPROSE_TAIL\u001b[0m`, {
				command: "echo results",
			}),
			52,
			true,
		);
		expect(prose).toContain("PROSE_TAIL");
		expect(prose).not.toContain("\u001b[31m");
		expect(prose).not.toContain("\u001b[0m");
		expect(prose).not.toContain("←/→ horiz");

		const code = renderDetail(
			makeTranscriptRun("read", `export const longLine = "${"CODE".repeat(40)}";`, { path: "src/a.ts" }),
			52,
			true,
		);
		expect(code).toContain("←/→ horiz");

		const edit = renderDetail(
			makeTranscriptRun("edit", "Successfully replaced 1 block(s).", { path: "src/a.ts" }, {
				diff: "@@ -1 +1 @@\\n-old\\n+new",
				firstChangedLine: 1,
			}),
			52,
			true,
		);
		expect(edit).toContain("Successfully replaced 1 block(s).");
		expect(edit).toContain("+new");
		expect(edit).toContain("First changed line: 1");

		const secret = "sk-live-subagent-test-only";
		const secretText = "stdout result preview";
		const secretArgs = { command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid` };
		const privateRun = makeTranscriptRun("bash", secretText, secretArgs, undefined, [
			{ kind: "tool", at: 1, toolName: "bash", args: secretArgs, argsPreview: JSON.stringify(secretArgs) } as any,
			{
				kind: "toolResult",
				at: 2,
				toolName: "bash",
				args: secretArgs,
				resultPreview: secretText,
				resultText: secretText,
				isError: false,
			} as any,
		]);
		const collapsed = renderDetail(privateRun);
		expect(collapsed).toContain(secretText);
		expect(collapsed).not.toContain(secret);
		expect(collapsed).not.toContain("Authorization");
		expect(collapsed).not.toContain("example.invalid");
		expect(renderDetail(privateRun, 52, true)).toContain(secretText);
	});

	test("shows bounded tool-output previews in collapsed run results and full output when expanded", () => {
		const toolOutput = "stdout preview value\n# Heading\n\n```rust\nlet answer = 42;\n```";
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo output" } }],
			} as any,
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "bash",
				content: [{ type: "text", text: toolOutput }],
				isError: false,
			} as any,
			{ role: "assistant", content: [{ type: "text", text: "finished" }] } as any,
		];
		const run = {
			name: "worker",
			task: "inspect output",
			exitCode: 0,
			messages,
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			model: "fake-model",
			timeoutKilled: false,
			maxTurnsKilled: false,
			aborted: false,
			startedAt: new Date().toISOString(),
			durationMs: 10,
		};
		const collapsed = renderRunResults([run], "single", false, browserTheme).render(100).join("\n");
		expect(collapsed).toContain("stdout preview value");
		expect(collapsed).toContain("Ctrl+O to expand");
		const expanded = renderRunResults([run], "single", true, browserTheme).render(100).join("\n");
		expect(expanded).toContain("stdout preview value");
		expect(expanded).toContain("# Heading");
		expect(expanded).toContain("```rust");
	});

	test("renders only the final agent response as Markdown in the subagent transcript", () => {
		const run = browserRun({
			groupId: "",
			groupSize: undefined,
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "# Intermediate note\n\n- raw list" }] } as any,
				{ role: "assistant", content: [{ type: "text", text: "# Final answer\n\n- formatted item" }] } as any,
			],
		});
		const browser = new SubagentsBrowser(browserTheme, browserTui(60), () => {}, () => [run]);
		try {
			browser.render(70);
			browser.handleInput(String.fromCharCode(13));
			browser.handleInput("o");
			browser.handleInput("G");
			const output = browser.render(70).join("\n");
			expect(output).toContain("# Intermediate note");
			expect(output).not.toContain("# Final answer");
			expect(output).toContain("Final answer");
			expect(output).toContain("formatted item");
		} finally {
			browser.dispose();
		}
	});

	test("expanded transcript keeps the final response visible after a large earlier message", () => {
		const run = browserRun({
			groupId: "",
			groupSize: undefined,
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "earlier output ".repeat(20_000) }] } as any,
				{ role: "assistant", content: [{ type: "text", text: "# Final response survives" }] } as any,
			],
		});
		const browser = new SubagentsBrowser(browserTheme, browserTui(60), () => {}, () => [run]);
		try {
			browser.render(70);
			browser.handleInput(String.fromCharCode(13));
			browser.handleInput("o");
			browser.handleInput("G");
			const output = browser.render(70).join("\n");
			expect(output).toContain("Final response survives");
		} finally {
			browser.dispose();
		}
	});

	test("browser labels live activity separately from the transcript", () => {
		const run = browserRun({
			status: "running",
			currentThinking: "checking the latest result",
			activities: [{ kind: "status", at: 4, text: "reading files" }],
			messages: [{ role: "assistant", content: [{ type: "text", text: "partial answer" }] } as any],
		});
		const browser = new SubagentsBrowser(browserTheme, browserTui(60), () => {}, () => [run]);
		try {
			browser.render(100);
			browser.handleInput(String.fromCharCode(13));
			const rendered = browser.render(100).join(" ");
			expect(rendered).toContain("Live activity");
			expect(rendered).toContain("Current thinking");
			expect(rendered).toContain("Transcript");
			expect(rendered).toContain("partial answer");
		} finally {
			browser.dispose();
		}
	});

	test("browser cache signatures include mutable usage and activity fields", () => {
		const run = browserRun({
			groupId: "",
			groupSize: undefined,
			activities: [
				{ kind: "tool", at: 1, toolName: "bash", argsPreview: "old args" },
				{ kind: "toolResult", at: 2, toolName: "bash", resultPreview: "old result", isError: false },
			],
		});
		const browser = new SubagentsBrowser(browserTheme, browserTui(24), () => {}, () => [run]);
		try {
			browser.render(80);
			browser.handleInput(String.fromCharCode(13));
			const initial = browser.render(80);
			run.usage.turns = 2;
			run.usage.contextTokens = 99;
			run.usage.cacheRead = 7;
			run.usage.cacheWrite = 8;
			run.activities[0]!.argsPreview = "new args";
			run.activities[1]!.isError = true;
			const updated = browser.render(80);
			expect(updated).not.toBe(initial);
			expect(updated.join(" ")).toContain("2 turns");
			expect(updated.join(" ")).toContain("ctx 99");
			expect(updated.join(" ")).not.toContain("new args");
			expect(updated.join(" ")).toContain("✗ bash");
		} finally {
			browser.dispose();
		}
	});

	test("browser allocates detail body from actual header chrome and keeps its footer", () => {
		const sparse = browserRun({
			groupId: "",
			groupSize: undefined,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			activities: Array.from({ length: 8 }, (_, i) => ({ kind: "status", at: i, text: `body-${i}` })),
		});
		const sparseTui = browserTui(15);
		const sparseBrowser = new SubagentsBrowser(browserTheme, sparseTui, () => {}, () => [sparse]);
		try {
			sparseBrowser.render(50);
			sparseBrowser.handleInput(String.fromCharCode(13));
			let rendered = sparseBrowser.render(50);
			expect(rendered.length).toBe(Math.floor(sparseTui.terminal.rows * 0.8));
			let seenBody4 = rendered.join(" ").includes("body-4");
			for (let i = 0; i < 20 && !seenBody4; i++) {
				sparseBrowser.handleInput("j");
				rendered = sparseBrowser.render(50);
				seenBody4 = rendered.join(" ").includes("body-4");
			}
			expect(seenBody4).toBe(true);
			expect(rendered.join(" ")).toContain("↑/↓ scroll");
		} finally {
			sparseBrowser.dispose();
		}

		const full = browserRun({
			activities: [{ kind: "status", at: 1, text: "full-header-body" }],
			errorMessage: "failed",
			sessionId: "session",
			transcriptTruncated: true,
		});
		const fullTui = browserTui(17);
		const fullBrowser = new SubagentsBrowser(browserTheme, fullTui, () => {}, () => [full]);
		try {
			fullBrowser.render(60);
			fullBrowser.handleInput(String.fromCharCode(13));
			let rendered = fullBrowser.render(60);
			expect(rendered.length).toBeLessThanOrEqual(Math.floor(fullTui.terminal.rows * 0.8));
			let sawFullHeaderBody = rendered.join(" ").includes("full-header-body");
			for (let i = 0; i < 20 && !sawFullHeaderBody; i++) {
				fullBrowser.handleInput("j");
				rendered = fullBrowser.render(60);
				sawFullHeaderBody = rendered.join(" ").includes("full-header-body");
			}
			expect(sawFullHeaderBody).toBe(true);
			expect(rendered.join(" ")).toContain("↑/↓ scroll");
		} finally {
			fullBrowser.dispose();
		}
	});

	test("browser computes group progress from unfiltered runs", () => {
		const visible = browserRun({ runId: "visible", status: "ok" });
		const all = [
			visible,
			browserRun({ runId: "other-1", status: "ok", step: 2 }),
			browserRun({ runId: "other-2", status: "ok", step: 3 }),
		];
		const browser = new SubagentsBrowser(browserTheme, browserTui(), () => {}, () => [visible], undefined, () => all);
		try {
			expect(browser.render(100).join(" ")).toContain("3/3 done");
		} finally {
			browser.dispose();
		}
	});

	test("browser preserves selected run id across live list updates and uses injected bindings", () => {
		const first = browserRun({ runId: "first", task: "first task" });
		const second = browserRun({ runId: "second", task: "second task", step: 2 });
		const runs = [first, second];
		const calls: string[] = [];
		let closed = 0;
		const keybindings = {
			matches: (data: string, binding: string) => {
				calls.push(`${data}:${binding}`);
				return (
					(data === "x" && binding === "tui.select.down") ||
					(data === "c" && binding === "tui.select.confirm") ||
					(data === "q" && binding === "tui.select.cancel")
				);
			},
		} as any;
		const browser = new SubagentsBrowser(browserTheme, browserTui(), () => {
			closed++;
		}, () => runs, keybindings);
		try {
			browser.render(60);
			browser.handleInput("x");
			runs.unshift(browserRun({ runId: "new", status: "running", task: "new task" }));
			browser.render(60);
			browser.handleInput("c");
			expect(browser.render(60).join(" ")).toContain("second task");
			browser.handleInput("q");
			expect(closed).toBe(0);
			expect(calls).toContain("x:tui.select.down");
			expect(calls).toContain("c:tui.select.confirm");
			expect(calls).toContain("q:tui.select.cancel");
		} finally {
			browser.dispose();
		}
	});

	test("browser visibly marks display and storage transcript truncation", () => {
		const browser = new SubagentsBrowser(
			browserTheme,
			browserTui(),
			() => {},
			() => [
				browserRun({
					transcriptTruncated: true,
					messages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(41_000) }] } as any],
				}),
			],
		);
		try {
			browser.render(60);
			browser.handleInput(String.fromCharCode(13));
			let rendered = "";
			for (let i = 0; i < 120; i++) {
				rendered += browser.render(60).join(" ");
				browser.handleInput("j");
			}
			expect(rendered).toContain("shortened before storage");
			expect(rendered).toContain("truncated for display");
			for (const width of [1, 8, 24, 60]) {
				for (const line of browser.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(1, width));
			}
		} finally {
			browser.dispose();
		}
	});

	test("formatting helpers", () => {
		expect(statusIcon("running")).toBe("⏳");
		expect(statusIcon("ok")).toBe("✓");
		expect(statusIcon("error")).toBe("✗");
		expect(runDisplayName({ kind: "chain", step: 2, name: "worker" })).toBe("chain 2 · worker");
		expect(runDisplayName({ kind: "single", name: "worker" })).toBe("worker");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(42)).toBe("42");
		expect(formatElapsed(1500)).toBe("1.5s");
		expect(formatElapsed(90_000)).toBe("1m30s");
		expect(truncateBytes("hello", 100)).toBe("hello");
		expect(truncateBytes("hello world", 5)).toContain("[truncated]");
		expect(
			usageLine({ input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 2 }),
		).toContain("2 turns");
	});

	test("activityPlainText renders one-liners without ANSI", () => {
		const tool: RunActivity = { kind: "tool", at: 1234, toolName: "bash", argsPreview: '{ command: "ls" }' };
		expect(activityPlainText(tool)).toContain("bash");
		const failed: RunActivity = { kind: "toolResult", at: 2000, toolName: "bash", isError: true };
		expect(activityPlainText(failed)).toContain("✗");
	});
});
