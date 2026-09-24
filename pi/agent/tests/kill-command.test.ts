import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import killCommandExtension, {
	KILL_COMMAND_NAME,
	KILL_COMMAND_SHORTCUT,
	linkAbortSignals,
	RunningCommandRegistry,
} from "../extensions/kill-command.ts";

type Handler = (...args: any[]) => any;

type TestRuntime = {
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: Handler }>;
	shortcuts: Map<string, { handler: Handler }>;
	tools: Map<string, { execute: Handler; renderCall?: Handler; renderResult?: Handler }>;
	notifications: string[];
	statuses: Map<string, string | undefined>;
	terminalInput?: (data: string) => { consume?: boolean } | undefined;
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
};

beforeAll(() => initTheme("dark"));

function testRuntime(): TestRuntime {
	const runtime = {
		handlers: new Map<string, Handler>(),
		commands: new Map<string, { handler: Handler }>(),
		shortcuts: new Map<string, { handler: Handler }>(),
		tools: new Map<string, { execute: Handler }>(),
		notifications: [],
		statuses: new Map<string, string | undefined>(),
		terminalInput: undefined,
		pi: {},
		ctx: {},
	} as TestRuntime;

	runtime.pi = {
		on: (event: string, handler: Handler) => runtime.handlers.set(event, handler),
		getActiveTools: () => ["bash"],
		registerCommand: (name: string, definition: { handler: Handler }) => runtime.commands.set(name, definition),
		registerShortcut: (shortcut: string, definition: { handler: Handler }) =>
			runtime.shortcuts.set(shortcut, definition),
		registerTool: (tool: { name: string; execute: Handler; renderCall?: Handler; renderResult?: Handler }) => runtime.tools.set(tool.name, tool),
	};
	runtime.ctx = {
		mode: "tui",
		cwd: process.cwd(),
		model: undefined,
		thinkingLevel: "off",
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
		ui: {
			notify: (message: string) => runtime.notifications.push(message),
			setStatus: (key: string, value: string | undefined) => runtime.statuses.set(key, value),
			onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
				runtime.terminalInput = handler;
				return () => {
					runtime.terminalInput = undefined;
				};
			},
		},
	};
	return runtime;
}

describe("command-local cancellation", () => {
	test("does not propagate a command kill to the parent agent signal", () => {
		const parent = new AbortController();
		const command = new AbortController();
		const linked = linkAbortSignals(parent.signal, command.signal);

		command.abort();

		expect(linked.signal.aborted).toBe(true);
		expect(parent.signal.aborted).toBe(false);
		expect(command.signal.aborted).toBe(true);
		linked.dispose();
	});

	test("tracks and kills every active command", () => {
		const registry = new RunningCommandRegistry();
		const first = registry.start("one", "sleep 10");
		const second = registry.start("two", "sleep 20");

		expect(registry.size).toBe(2);
		expect(registry.killAll()).toEqual([first, second]);
		expect(first.controller.signal.aborted).toBe(true);
		expect(second.controller.signal.aborted).toBe(true);

		registry.finish(first);
		registry.finish(second);
		expect(registry.size).toBe(0);
	});

	test("kills a bash command while leaving the agent running", async () => {
		const runtime = testRuntime();
		killCommandExtension(runtime.pi as never);
		await runtime.handlers.get("session_start")!({}, runtime.ctx);

		expect(runtime.commands.has(KILL_COMMAND_NAME)).toBe(true);
		expect(runtime.shortcuts.has(KILL_COMMAND_SHORTCUT)).toBe(true);

		const tool = runtime.tools.get("bash")!;
		expect(typeof tool.renderCall).toBe("function");
		expect(typeof tool.renderResult).toBe("function");
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const state = { startedAt: undefined, endedAt: undefined, interval: undefined };
		const renderContext = {
			state,
			lastComponent: undefined,
			executionStarted: true,
			args: { command: "if true; then\n  echo ready\nfi" },
		};
		const callLines = tool.renderCall!(renderContext.args, theme, renderContext).render(80);
		const call = callLines.join(" ");
		const plainCall = call.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
		expect(callLines[0]?.trimStart().startsWith("$ ")).toBe(true);
		expect(plainCall).toContain("echo ready");
		expect(call).not.toBe(plainCall);
		const styledTheme = { ...theme, bg: (color: string, text: string) => `[${color}]${text}` };
		const completedCall = tool.renderCall!(renderContext.args, styledTheme, { ...renderContext, isPartial: false, isError: false });
		expect(completedCall.render(80)[0]).toContain("[toolSuccessBg]");
		const collapsed = tool.renderResult!(
			{ content: [{ type: "text", text: "secret stdout value" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			{ ...renderContext, isError: false, invalidate: () => {} },
		)
			.render(80)
			.join(" ");
		expect(collapsed).toContain("Command completed");
		expect(collapsed).toContain("Took ");
		expect(collapsed).not.toContain("\\nTook");
		expect(collapsed).toContain("secret stdout value");
		expect(collapsed).not.toContain("if true; then");
		const parent = new AbortController();
		const execution = tool.execute("tool-call-1", { command: "sleep 10" }, parent.signal, undefined, runtime.ctx);

		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(runtime.terminalInput?.("\x03")).toEqual({ consume: true });
			expect(parent.signal.aborted).toBe(false);
			await expect(execution).rejects.toThrow("Command killed by user");
			expect(runtime.notifications.at(-1)).toContain("agent will continue");

			const secondExecution = tool.execute(
				"tool-call-2",
				{ command: "sleep 10" },
				parent.signal,
				undefined,
				runtime.ctx,
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await runtime.shortcuts.get(KILL_COMMAND_SHORTCUT)!.handler(runtime.ctx);
			expect(parent.signal.aborted).toBe(false);
			await expect(secondExecution).rejects.toThrow("Command killed by user");
		} finally {
			await runtime.handlers.get("session_shutdown")!({}, runtime.ctx);
		}
	});
});
