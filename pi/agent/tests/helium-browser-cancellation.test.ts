import { describe, expect, test } from "bun:test";
import heliumBrowserExtension, {
	ActionCanceledError,
	ActionUnknownOutcomeError,
	withTabMutation,
} from "../extensions/helium-browser/index.ts";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Helium browser action cancellation", () => {
	test("pre-aborted mutation handlers do not access the browser", async () => {
		const tools = new Map<string, { execute?: (...args: any[]) => Promise<unknown> }>();
		let browserAccesses = 0;
		const pi = {
			on: () => {},
			registerCommand: () => {},
			registerTool: (tool: { name: string; execute?: (...args: any[]) => Promise<unknown> }) =>
				 tools.set(tool.name, tool),
			exec: async () => {
				browserAccesses++;
				throw new Error("browser access should not occur");
			},
		};
		heliumBrowserExtension(pi as never);
		const controller = new AbortController();
		controller.abort();
		const calls: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined]> = [
			["helium_click", { selector: "#target" }, undefined],
			["helium_fill", { selector: "#target", text: "ordinary" }, undefined],
			["helium_type", { selector: "#target", text: "ordinary" }, undefined],
			["helium_key", { key: "Enter" }, undefined],
			["helium_navigate", { url: "https://example.test" }, undefined],
			["helium_apw_fill", {}, { hasUI: true, ui: { confirm: async () => false } }],
		];
		for (const [name, params, ctx] of calls)
			await expect(tools.get(name)!.execute!("id", params, controller.signal, undefined, ctx)).rejects.toThrow(
				/canceled/i,
			);
		expect(browserAccesses).toBe(0);
	});

	test("does not dispatch a pre-aborted tab mutation", async () => {
		const controller = new AbortController();
		controller.abort();
		let dispatched = false;

		await expect(
			withTabMutation("pre-aborted-tab", controller.signal, async () => {
				dispatched = true;
				return "unexpected";
			}),
		).rejects.toBeInstanceOf(ActionCanceledError);
		expect(dispatched).toBe(false);
	});

	test("cancels queued work without dispatching it", async () => {
		let release!: () => void;
		const first = withTabMutation("queued-tab", undefined, async (actions) => {
			return actions.run(
				() => new Promise<void>((resolve) => (release = resolve)),
				"first mutation",
				{ timeoutMs: 1_000 },
			);
		});
		await wait(0);

		const controller = new AbortController();
		let queuedDispatched = false;
		const queued = withTabMutation("queued-tab", controller.signal, async () => {
			queuedDispatched = true;
			return "unexpected";
		});
		controller.abort();
		await expect(queued).rejects.toBeInstanceOf(ActionCanceledError);
		expect(queuedDispatched).toBe(false);

		release();
		await first;
	});

	test("holds the tab gate after timeout until dispatched work settles", async () => {
		let release!: () => void;
		const first = withTabMutation("timeout-tab", undefined, async (actions) =>
			actions.run(
				() => new Promise<void>((resolve) => (release = resolve)),
				"slow click",
				{ timeoutMs: 10 },
			),
		);
		await expect(first).rejects.toBeInstanceOf(ActionUnknownOutcomeError);

		let retryDispatched = false;
		const retry = withTabMutation("timeout-tab", undefined, async () => {
			retryDispatched = true;
			return "retry";
		});
		await wait(30);
		expect(retryDispatched).toBe(false);

		release();
		await expect(retry).resolves.toBe("retry");
		expect(retryDispatched).toBe(true);
	});

	test("reports an aborted dispatched operation as an unknown outcome", async () => {
		const controller = new AbortController();
		let release!: () => void;
		const action = withTabMutation("abort-tab", controller.signal, async (actions) =>
			actions.run(
				() => new Promise<void>((resolve) => (release = resolve)),
				"slow fill",
				{ timeoutMs: 1_000 },
			),
		);
		await wait(0);
		controller.abort();
		await expect(action).rejects.toThrow(/unknown/i);
		release();
	});
});
