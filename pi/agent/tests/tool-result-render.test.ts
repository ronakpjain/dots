import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderToolResult } from "../extensions/tool-results/render.ts";

beforeAll(() => initTheme("dark"));

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function rendered(component: { render(width: number): string[] }, width = 80): string {
	return component.render(width).join("\n");
}

describe("shared tool-result renderer", () => {
	test("renders a collapsed output preview without mutating structured results", () => {
		const result = {
			content: [{ type: "text", text: '{"balance":1234,"positions":[{"symbol":"AAPL"}]}' }],
			details: { balance: 1234 },
		};
		const before = JSON.stringify(result);
		const collapsed = rendered(
			renderToolResult(
				"robinhood_get_portfolio",
				result,
				{ expanded: false },
				theme,
				{},
				{ collapsedSummary: () => "Brokerage result ready · expand for details" },
			),
		);
		expect(collapsed).toContain("Brokerage result ready");
		expect(collapsed).toContain("1234");

		const safeCollapsed = rendered(renderToolResult("robinhood_get_portfolio", result, { expanded: false }, theme));
		expect(safeCollapsed).toContain("Brokerage result ready");
		expect(safeCollapsed).toContain("1234");

		const expanded = rendered(renderToolResult("robinhood_get_portfolio", result, { expanded: true }, theme));
		expect(expanded).toContain('"balance": 1234');
		expect(expanded).toContain('"symbol": "AAPL"');
		expect(JSON.stringify(result)).toBe(before);
	});

	test("shows a truncated subagent history preview", () => {
		const output = rendered(
			renderToolResult(
				"subagent_history",
				{ content: [{ type: "text", text: "private transcript content" }], details: { runIds: ["run-1", "run-2"] } },
				{ expanded: false },
				theme,
			),
		);
		expect(output).toContain("2 subagent runs");
		expect(output).toContain("private transcript");
	});

	test("shows a bounded preview of dynamically loaded tool output", () => {
		const result = {
			content: [{ type: "text", text: "Loaded tools: robinhood_account_secret" }],
			details: { matches: [{ name: "robinhood_account_secret" }], added: [{ name: "robinhood_account_secret" }] },
		};
		const collapsed = rendered(renderToolResult("robinhood_search_tools", result, { expanded: false }, theme));
		expect(collapsed).toContain("1 matching tool · 1 newly loaded");
		expect(collapsed).toContain("account_secret");
	});

	test("shows truncated tool output previews while keeping arguments out of collapsed results", () => {
		const secret = "sk-live-render-test-only";
		const command = `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`;
		const result = { content: [{ type: "text", text: "stdout is visible" }] };
		const collapsed = rendered(
			renderToolResult("bash", result, { expanded: false }, theme, { args: { command } }),
		);
		expect(collapsed).toContain("Command completed");
		expect(collapsed).toContain("stdout is visible");
		expect(collapsed).toContain("expand for full output");
		expect(collapsed).not.toContain(secret);
		expect(collapsed).not.toContain("Authorization");
		expect(collapsed).not.toContain("example.invalid");

		const expanded = rendered(renderToolResult("bash", result, { expanded: true }, theme, { args: { command } }));
		expect(expanded).toContain("stdout is visible");
	});

	test("caps collapsed previews for every tool and leaves the full result unfoldable", () => {
		const longOutput = Array.from({ length: 12 }, (_value, index) => `line-${index + 1}`).join("\n");
		const result = { content: [{ type: "text", text: longOutput }] };
		const collapsed = rendered(renderToolResult("lsp_hover", result, { expanded: false }, theme));
		expect(collapsed).toContain("line-1");
		expect(collapsed).toContain("line-8");
		expect(collapsed).not.toContain("line-9");
		expect(collapsed).toContain("output preview truncated; expand for full output");

		const expanded = rendered(renderToolResult("lsp_hover", result, { expanded: true }, theme));
		expect(expanded).toContain("line-12");
	});

	test("shows unfold hints for results without text", () => {
		const output = rendered(renderToolResult("lsp_hover", { content: [] }, { expanded: false }, theme));
		expect(output).toContain("Hover information ready");
		expect(output).toContain("expand for details");
	});

	test("caps long write summaries in collapsed and expanded views", () => {
		const writeResult = { content: [{ type: "text", text: `${"x".repeat(2_000)}WRITE_OUTPUT_TAIL` }] };
		const collapsed = rendered(renderToolResult("write", writeResult, { expanded: false }, theme));
		expect(collapsed).toContain("output preview truncated; expand for full output");
		expect(collapsed).not.toContain("WRITE_OUTPUT_TAIL");
		expect(collapsed.length).toBeLessThan(1_500);

		const expanded = rendered(renderToolResult("write", writeResult, { expanded: true }, theme));
		expect(expanded).toContain("WRITE_OUTPUT_TAIL");
	});

	test("renders Bash Markdown-looking output as literal text", () => {
		const rawOutput = ["# Heading", "", "- list item", "", "```rust", "let answer = 42;", "```"].join("\n");
		const output = rendered(
			renderToolResult("bash", { content: [{ type: "text", text: rawOutput }] }, { expanded: true }, theme),
		);
		expect(output).toContain("# Heading");
		expect(output).toContain("- list item");
		expect(output).toContain("```rust");
		expect(output).toContain("let answer = 42;");
	});

	test("renders unified diff output as literal code without Markdown fence artifacts", () => {
		const diff = [
			"diff --git a/settings.rs b/settings.rs",
			"--- a/settings.rs",
			"+++ b/settings.rs",
			"@@ -1 +1 @@",
			"-```rust",
			"+```rust",
		].join("\n");
		const output = rendered(
			renderToolResult("bash", { content: [{ type: "text", text: diff }] }, { expanded: true }, theme),
		);
		const lines = output.split("\n");
		const titleIndex = lines.findIndex((line) => line.includes("✓ bash"));
		expect(lines[titleIndex + 1]).toContain("diff --git");
		expect(output).toContain("-```rust");
		expect(output).toContain("+```rust");
		expect(output).not.toContain("```text");
	});

	test("uses tool-specific locations and diagnostics as readable result labels", () => {
		const component = renderToolResult(
			"lsp_diagnostics",
			{ content: [{ type: "text", text: "typescript: 1 issue(s)\nError L8:3: Missing name" }] },
			{ expanded: true },
			theme,
			{ args: { path: "src/file.ts" } },
		);
		const output = rendered(component);
		expect(output).toContain("lsp_diagnostics · src/file.ts");
		expect(output).toContain("typescript: 1 issue(s)");
		expect(output).toContain("Error L8:3");
		const collapsed = rendered(
			renderToolResult(
				"lsp_diagnostics",
				{ content: [{ type: "text", text: "typescript: 1 issue(s)\nError L8:3: Missing name" }] },
				{ expanded: false },
				theme,
				{ args: { path: "src/file.ts" } },
			),
		);
		expect(collapsed).toContain("1 diagnostic");
	});

	test("renders multiline LSP diagnostics as two intact literal list items", () => {
		const output = rendered(
			renderToolResult(
				"lsp_diagnostics",
				{
					content: [
						{
							type: "text",
							text: [
								"rust_analyzer: 2 issue(s)",
								"",
								"Warning L755:9: variable does not need to be mutable",
								"  `#[warn(unused_mut)]` (part of `#[warn(unused)]` on by default)",
								"Hint L755:9: remove this mut",
							].join("\n"),
						},
					],
				},
				{ expanded: true },
				theme,
			),
		);
		expect(output).toContain("Warning L755:9");
		expect(output).toContain("unused_mut");
		expect(output).toContain("Hint L755:9");
		expect(output).not.toContain("Issue:");
		expect(output.match(/•/g)).toHaveLength(2);
	});

	test("bounds large output and reports a clear truncation notice", () => {
		const component = renderToolResult(
			"helium_snapshot",
			{ content: [{ type: "text", text: "x".repeat(50_000) }] },
			{ expanded: true },
			theme,
		);
		const output = rendered(component);
		expect(output).toContain("output truncated for display");
		expect(output.length).toBeLessThan(50_000);
	});
});
