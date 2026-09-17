import { describe, expect, test } from "bun:test";
import heliumBrowserExtension, {
	validateElementTargetArguments,
} from "../extensions/helium-browser/index.ts";

type Tool = {
	name: string;
	parameters?: any;
	promptGuidelines?: string[];
	execute?: (...args: any[]) => Promise<unknown>;
};

function runtime(): {
	tools: Map<string, Tool>;
	pi: Record<string, unknown>;
	browserAccesses: number;
} {
	const tools = new Map<string, Tool>();
	let browserAccesses = 0;
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		exec: async () => {
			browserAccesses++;
			throw new Error("browser access should not occur for invalid arguments");
		},
	};
	return { tools, pi, get browserAccesses() { return browserAccesses; } };
}

describe("helium browser registration safeguards", () => {
	test("uses provider-compatible enum schemas and names every prompt guideline", () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);

		const scope = state.tools.get("helium_tabs")!.parameters.properties.scope;
		const kind = state.tools.get("helium_request_intervention")!.parameters.properties.kind;
		expect(scope).toMatchObject({ type: "string", enum: ["all", "pi", "user"] });
		expect(kind).toMatchObject({
			type: "string",
			enum: ["login", "signup", "mfa", "passkey", "captcha", "payment", "consent", "other"],
		});
		expect(scope.anyOf).toBeUndefined();
		expect(kind.anyOf).toBeUndefined();
		const key = state.tools.get("helium_key")!.parameters.properties.key;
		expect(key.pattern).toContain("Enter");
		expect(new RegExp(key.pattern).test("Control+V")).toBe(false);
		expect(new RegExp(key.pattern).test("Shift+Insert")).toBe(false);
		expect(new RegExp(key.pattern).test("ArrowDown")).toBe(true);

		for (const tool of state.tools.values()) {
			for (const guideline of tool.promptGuidelines ?? []) expect(guideline).toContain(tool.name);
		}
	});

	test("exposes bounded snapshot continuation and scope parameters", () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);
		const snapshot = state.tools.get("helium_snapshot")!.parameters;
		expect(snapshot.properties.cursor).toMatchObject({ type: "string", maxLength: 300 });
		expect(snapshot.properties.scope).toMatchObject({ type: "string", maxLength: 500 });
	});

	test("rejects printable and paste key inputs before browser access", async () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);
		const execute = state.tools.get("helium_key")!.execute!;
		for (const key of ["a", "Control+V", "Shift+Insert"]) {
			await expect(execute("call", { key })).rejects.toThrow(/key|shortcut/i);
		}
		expect(state.browserAccesses).toBe(0);
	});

	test("rejects invalid element targets before browser access", async () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);
		for (const name of ["helium_click", "helium_fill", "helium_type"]) {
			const execute = state.tools.get(name)!.execute!;
			await expect(execute("call", { ref: "e1", selector: "#target", text: "ordinary" })).rejects.toThrow(
				"either ref or selector",
			);
			await expect(execute("call", { text: "ordinary" })).rejects.toThrow("snapshot ref or a CSS selector");
		}
		expect(state.browserAccesses).toBe(0);
	});

	test("rejects invalid navigation URLs before browser access", async () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);
		await expect(state.tools.get("helium_navigate")!.execute!("call", { url: "javascript:alert(1)" })).rejects.toThrow(
			"Only http(s)",
		);
		await expect(state.tools.get("helium_open_tab")!.execute!("call", { url: "file:///tmp/private" })).rejects.toThrow(
			"Only http(s)",
		);
		expect(state.browserAccesses).toBe(0);
	});

	test("normalizes target whitespace without browser access", () => {
		expect(validateElementTargetArguments({ ref: " e1 " })).toEqual({ ref: "e1", selector: undefined });
		expect(validateElementTargetArguments({ selector: " #target " })).toEqual({
			ref: undefined,
			selector: "#target",
		});
	});
});
