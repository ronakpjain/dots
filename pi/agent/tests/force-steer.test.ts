import { describe, expect, test } from "bun:test";
import forceSteerExtension, { FORCE_STEER_SHORTCUT } from "../extensions/force-steer.ts";

type Handler = (...args: any[]) => any;
type SentMessage = { content: string; options?: { expandPromptTemplates?: boolean } };

type TestRuntime = {
	events: Map<string, Handler>;
	shortcutKey?: string;
	shortcut?: { handler: Handler };
	sent: SentMessage[];
	abortCalls: number;
	text: string;
	pi: Record<string, unknown>;
	ctx: Record<string, any>;
};

function testRuntime(text: string, idle: boolean): TestRuntime {
	const runtime = {
		events: new Map<string, Handler>(),
		shortcutKey: undefined,
		shortcut: undefined,
		sent: [],
		abortCalls: 0,
		text,
		pi: {},
		ctx: {},
	} as TestRuntime;

	runtime.pi = {
		on: (event: string, handler: Handler) => runtime.events.set(event, handler),
		registerShortcut: (shortcut: string, definition: { handler: Handler }) => {
			runtime.shortcutKey = shortcut;
			runtime.shortcut = definition;
		},
		sendUserMessage: (content: string, options?: SentMessage["options"]) => {
			runtime.sent.push({ content, options });
		},
	};
	runtime.ctx = {
		isIdle: () => idle,
		abort: () => {
			runtime.abortCalls += 1;
		},
		ui: {
			getEditorText: () => runtime.text,
			setEditorText: (text: string) => {
				runtime.text = text;
			},
		},
	};

	return runtime;
}

describe("force-steer shortcut", () => {
	test("registers Alt+Shift+Enter", () => {
		const runtime = testRuntime("", true);
		forceSteerExtension(runtime.pi as never);

		expect(runtime.shortcut).toBeDefined();
		expect(runtime.shortcutKey).toBe("alt+shift+enter");
		expect(FORCE_STEER_SHORTCUT).toBe("alt+shift+enter");
		expect(runtime.events.has("agent_settled")).toBe(true);
	});

	test("aborts the active response, then submits the editor text after it settles", () => {
		const runtime = testRuntime("Change direction", false);
		forceSteerExtension(runtime.pi as never);

		runtime.shortcut!.handler(runtime.ctx);

		expect(runtime.abortCalls).toBe(1);
		expect(runtime.sent).toEqual([]);
		expect(runtime.text).toBe("");

		runtime.events.get("agent_settled")!({ aborted: true }, runtime.ctx);

		expect(runtime.sent).toEqual([
			{ content: "Change direction", options: { expandPromptTemplates: true } },
		]);
	});

	test("submits normally when idle", () => {
		const runtime = testRuntime("Do this next", true);
		forceSteerExtension(runtime.pi as never);

		runtime.shortcut!.handler(runtime.ctx);

		expect(runtime.abortCalls).toBe(0);
		expect(runtime.sent).toEqual([{ content: "Do this next", options: { expandPromptTemplates: true } }]);
		expect(runtime.text).toBe("");
	});

	test("leaves an empty editor unchanged", () => {
		const runtime = testRuntime("  \n", false);
		forceSteerExtension(runtime.pi as never);

		runtime.shortcut!.handler(runtime.ctx);

		expect(runtime.abortCalls).toBe(0);
		expect(runtime.sent).toEqual([]);
		expect(runtime.text).toBe("  \n");
	});
});
