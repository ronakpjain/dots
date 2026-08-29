import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import footerExtension, { fitFooterParts, footerLayoutForWidth } from "../extensions/footer.ts";

describe("responsive footer layout", () => {
	test("selects a denser layout as the terminal narrows", () => {
		expect(footerLayoutForWidth(120)).toBe("wide");
		expect(footerLayoutForWidth(80)).toBe("medium");
		expect(footerLayoutForWidth(48)).toBe("narrow");
	});

	test("drops optional segments before truncating important ones", () => {
		const result = fitFooterParts(
			[
				{ text: "↑12k ↓7k", priority: 100 },
				{ text: "ctx 17%", priority: 95 },
				{ text: "gpt-5.6-luna", priority: 90 },
				{ text: "cache 4k/1k", priority: 10 },
			],
			32,
		);

		expect(result).toContain("↑12k ↓7k");
		expect(result).toContain("ctx 17%");
		expect(result).toContain("gpt-5.6-luna");
		expect(result).not.toContain("cache");
		expect(visibleWidth(result)).toBeLessThanOrEqual(32);
	});

	test("never exceeds the requested content width", () => {
		const parts = [
			{ text: "✦ pi", priority: 100 },
			{ text: "a-very-long-project-path", priority: 50 },
			{ text: "⎇ a-very-long-branch-name", priority: 80 },
		];

		for (const width of [1, 5, 8, 20, 32, 48, 80]) {
			expect(visibleWidth(fitFooterParts(parts, width))).toBeLessThanOrEqual(Math.max(1, width));
		}
	});

	test("renders compact values and more rows at narrow widths", () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		footerExtension({
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			getSessionName: () => "test session",
			getActiveTools: () => ["read", "bash"],
			getAllTools: () => ["read", "bash", "edit"],
			getThinkingLevel: () => "max",
		} as never);

		let footerFactory: ((...args: any[]) => any) | undefined;
		const ctx = {
			cwd: "/Users/ronak/dots/pi",
			model: { provider: "openai-codex", id: "gpt-5.6-luna" },
			thinkingLevel: "max",
			isIdle: () => false,
			getContextUsage: () => ({ tokens: 45_678, contextWindow: 272_000, percent: 17 }),
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							usage: {
								input: 12_345,
								output: 6_789,
								cacheRead: 4_567,
								cacheWrite: 123,
								cost: { total: 0.123 },
							},
						},
					},
				],
			},
			ui: { setFooter: (factory: (...args: any[]) => any) => (footerFactory = factory) },
		};
		handlers.get("session_start")!({}, ctx);

		const footer = footerFactory!(
			{ requestRender: () => {} },
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
			{
				getGitBranch: () => "main",
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => {},
			},
		);
		const wide = footer.render(120);
		const medium = footer.render(80);
		const narrow = footer.render(48);

		expect(wide).toHaveLength(2);
		expect(medium).toHaveLength(2);
		expect(narrow).toHaveLength(3);
		expect(wide[1]).toContain("openai-codex/gpt-5.6-luna");
		expect(medium[1]).toContain("ctx 17%");
		expect(medium[1]).not.toContain("openai-codex/");
		for (const lines of [wide, medium, narrow]) {
			for (const line of lines)
				expect(visibleWidth(line)).toBeLessThanOrEqual(lines === wide ? 120 : lines === medium ? 80 : 48);
		}
	});
});
