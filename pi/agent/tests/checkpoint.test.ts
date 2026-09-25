import { expect, test } from "bun:test";
import checkpointExtension from "../extensions/checkpoint.ts";

test("adds the general commit workflow directive to the system prompt", () => {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand() {},
	};
	checkpointExtension(pi as any);

	const result = handlers.get("before_agent_start")!({ systemPrompt: "base instructions" }, {}) as any;
	expect(result.systemPrompt).toContain("[GIT WORKFLOW CAPABILITY]");
	expect(result.systemPrompt).toContain("After completing a major, coherent change");
	expect(result.systemPrompt).toContain("stage only files changed for this work");
	expect(result.systemPrompt).toContain("pre-existing unrelated user changes");
	expect(result.systemPrompt).toContain("follow the repository's recent commit-message style");
});
