import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import btwExtension, {
	BtwAnswerViewer,
	BtwLoader,
	buildConversationSnapshot,
	extractAnswer,
} from "../extensions/btw.ts";

function testKeybindings(overrides: Record<string, string>): any {
	return {
		matches: (data: string, binding: string) => overrides[binding] === data,
		getKeys: (binding: string) => (overrides[binding] ? [overrides[binding]] : []),
	};
}

const testTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function testTui(rows = 16): any {
	return {
		terminal: { columns: 80, rows },
		requestRender: () => {},
	};
}

describe("btw helpers", () => {
	test("builds a bounded snapshot from user, assistant, and tool messages", () => {
		const snapshot = buildConversationSnapshot(
			[
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "Find the route." }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I found it." }] } },
				{ type: "message", message: { role: "tool", content: [{ type: "text", text: "src/routes.ts" }] } },
				{ type: "branch_summary", summary: "The route lookup is complete." },
				{ type: "custom", customType: "goal-mode-state", data: { status: "active" } },
			],
			10_000,
		);

		expect(snapshot).toContain("User:\nFind the route.");
		expect(snapshot).toContain("Assistant:\nI found it.");
		expect(snapshot).toContain("Tool:\nsrc/routes.ts");
		expect(snapshot).toContain("Branch summary:\nThe route lookup is complete.");
		expect(snapshot).not.toContain("goal-mode-state");
	});

	test("keeps both ends when the context snapshot is truncated", () => {
		const snapshot = buildConversationSnapshot(
			[
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "START " + "x".repeat(300) }] },
				},
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "END " + "y".repeat(300) }] },
				},
			],
			120,
		);

		expect(snapshot.length).toBeLessThanOrEqual(120);
		expect(snapshot).toContain("START");
		expect(snapshot).toContain("END");
		expect(snapshot).toContain("context truncated");
	});

	test("extracts visible text without leaking thinking blocks", () => {
		const answer = extractAnswer({
			content: [
				{ type: "thinking", thinking: "secret reasoning" },
				{ type: "text", text: "The answer." },
			],
		} as any);

		expect(answer).toBe("The answer.");
	});
});

describe("btw answer viewer", () => {
	test("scrolls by line, page, and home/end bindings", () => {
		const keybindings = testKeybindings({
			"tui.select.up": "up",
			"tui.select.down": "down",
			"tui.select.pageUp": "pageUp",
			"tui.select.pageDown": "pageDown",
			"tui.altScreen.top": "home",
			"tui.altScreen.bottom": "end",
			"tui.select.confirm": "enter",
			"tui.select.cancel": "escape",
		});
		const viewer = new BtwAnswerViewer(
			testTui(),
			testTheme as any,
			keybindings,
			"A long answer",
			Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\\n"),
			() => {},
		);

		viewer.render(40);
		expect(viewer.scrollOffset).toBe(0);
		viewer.handleInput("down");
		expect(viewer.scrollOffset).toBe(1);
		viewer.handleInput("pageDown");
		expect(viewer.scrollOffset).toBeGreaterThan(1);
		viewer.handleInput("end");
		expect(viewer.scrollOffset).toBe(viewer.maxScrollOffset);
		viewer.handleInput("pageUp");
		expect(viewer.scrollOffset).toBeLessThan(viewer.maxScrollOffset);
		viewer.handleInput("home");
		expect(viewer.scrollOffset).toBe(0);
	});

	test("keeps rendered lines within width across resize and narrow terminals", () => {
		const keybindings = testKeybindings({
			"tui.select.up": "up",
			"tui.select.down": "down",
			"tui.select.pageUp": "pageUp",
			"tui.select.pageDown": "pageDown",
			"tui.altScreen.top": "home",
			"tui.altScreen.bottom": "end",
			"tui.select.confirm": "enter",
			"tui.select.cancel": "escape",
		});
		const tui = testTui(16);
		const viewer = new BtwAnswerViewer(
			tui,
			testTheme as any,
			keybindings,
			"Question",
			Array.from({ length: 30 }, (_, index) => `content ${index} ` + "x".repeat(30)).join("\\n"),
			() => {},
		);

		for (const width of [1, 7, 20, 80]) {
			for (const line of viewer.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}

		viewer.handleInput("end");
		tui.terminal.rows = 6;
		for (const line of viewer.render(20)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
		expect(viewer.render(20).length).toBeLessThanOrEqual(2);
	});

	test("uses configured confirm/cancel bindings and always accepts Ctrl+C", () => {
		const keybindings = testKeybindings({
			"tui.select.up": "up",
			"tui.select.down": "down",
			"tui.select.pageUp": "pageUp",
			"tui.select.pageDown": "pageDown",
			"tui.altScreen.top": "home",
			"tui.altScreen.bottom": "end",
			"tui.select.confirm": "y",
			"tui.select.cancel": "n",
		});
		let closes = 0;
		const makeViewer = () =>
			new BtwAnswerViewer(testTui(), testTheme as any, keybindings, "Question", "Answer", () => closes++);
		const confirmed = makeViewer();
		confirmed.render(40);
		confirmed.handleInput("y");
		confirmed.handleInput("y");
		confirmed.handleInput("n");
		confirmed.handleInput("\x03");
		expect(closes).toBe(1);

		const cancelled = makeViewer();
		cancelled.render(40);
		cancelled.handleInput("n");
		const interrupted = makeViewer();
		interrupted.render(40);
		interrupted.handleInput("\x03");
		expect(closes).toBe(3);
	});

	test("aborts the request signal and disposal hook only once", () => {
		initTheme("dark");
		const loader = new BtwLoader(testTui(), testTheme as any, testKeybindings({ "tui.select.cancel": "escape" }));
		let disposals = 0;
		loader.onDispose = () => disposals++;
		expect(loader.signal.aborted).toBe(false);
		loader.dispose();
		loader.dispose();
		expect(loader.signal.aborted).toBe(true);
		expect(disposals).toBe(1);
	});
});

describe("btw command", () => {
	test("answers through the side channel without injecting a main-session message", async () => {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		let sentMessage = false;
		const notifications: string[] = [];

		btwExtension({
			on: () => {},
			registerCommand: (_name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => {
				handler = spec.handler;
			},
		} as any);

		const ctx = {
			mode: "rpc",
			hasUI: true,
			cwd: "/tmp/project",
			model: { provider: "fake", id: "model" },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "A side answer." }] }),
			},
			sessionManager: { buildContextEntries: () => [] },
			ui: {
				notify: (message: string) => notifications.push(message),
				input: async () => undefined,
				custom: async () => undefined,
			},
			sendMessage: () => {
				sentMessage = true;
			},
		};

		expect(handler).toBeDefined();
		await handler!("What is this?", ctx);

		expect(sentMessage).toBe(false);
		expect(notifications).toEqual(["BTW: A side answer."]);
	});

	test("aborts overlapping requests during session shutdown without late done calls", async () => {
		initTheme("dark");
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		let shutdown: (() => void) | undefined;
		const requestSignals: AbortSignal[] = [];
		const resolveRequests: ((result: any) => void)[] = [];
		let doneCalls = 0;
		const components: any[] = [];

		btwExtension({
			on: (event: string, callback: () => void) => {
				if (event === "session_shutdown") shutdown = callback;
			},
			registerCommand: (_name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => {
				handler = spec.handler;
			},
		} as any);

		const keybindings = testKeybindings({ "tui.select.cancel": "escape" });
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: "/tmp/project",
			model: { provider: "fake", id: "model" },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				complete: async (_model: any, _request: any, options: { signal: AbortSignal }) => {
					requestSignals.push(options.signal);
					return new Promise((resolve) => resolveRequests.push(resolve));
				},
			},
			sessionManager: { buildContextEntries: () => [] },
			ui: {
				notify: () => {},
				custom: async (factory: any) =>
					new Promise((resolve) => {
						let component: any;
						component = factory(testTui(), testTheme, keybindings, (value: any) => {
							doneCalls++;
							component.dispose?.();
							resolve(value);
						});
						components.push(component);
					}),
			},
		};

		const first = handler!("What is pending one?", ctx);
		const second = handler!("What is pending two?", ctx);
		await Promise.resolve();
		expect(requestSignals).toHaveLength(2);
		shutdown!();
		expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
		await Promise.all([first, second]);
		expect(doneCalls).toBe(2);

		for (const resolveRequest of resolveRequests) {
			resolveRequest({ stopReason: "stop", content: [{ type: "text", text: "late answer" }] });
		}
		await Promise.resolve();
		expect(doneCalls).toBe(2);
		expect(components).toHaveLength(2);
	});

	test("shows usage when no question is supplied and no UI is available", async () => {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const notifications: string[] = [];

		btwExtension({
			on: () => {},
			registerCommand: (_name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => {
				handler = spec.handler;
			},
		} as any);

		await handler!("", {
			mode: "print",
			hasUI: false,
			ui: { notify: (message: string) => notifications.push(message) },
		});

		expect(notifications).toEqual(["Usage: /btw <question>"]);
	});
});
