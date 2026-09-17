import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryExtension from "../extensions/memory.ts";

type Handler = (...args: any[]) => any;
type Tool = {
	name: string;
	promptGuidelines?: string[];
	execute: Handler;
};

type Runtime = {
	handlers: Map<string, Handler>;
	tools: Map<string, Tool>;
};

function runtime(): Runtime {
	const result: Runtime = {
		handlers: new Map(),
		tools: new Map(),
	};
	memoryExtension({
		on: (event: string, handler: Handler) => result.handlers.set(event, handler),
		registerTool: (tool: Tool) => result.tools.set(tool.name, tool),
	} as never);
	return result;
}

async function withStore<T>(memories: unknown[], callback: (file: string, runtime: Runtime) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
	const file = join(directory, "memories.json");
	await writeFile(file, JSON.stringify({ version: 2, memories }), "utf8");

	const previous = process.env.PI_MEMORY_FILE;
	process.env.PI_MEMORY_FILE = file;
	try {
		return await callback(file, runtime());
	} finally {
		if (previous === undefined) delete process.env.PI_MEMORY_FILE;
		else process.env.PI_MEMORY_FILE = previous;
		await rm(directory, { recursive: true, force: true });
	}
}

function memory(id: string, title: string, content: string, tags: string[] = [], archived = false) {
	return {
		id,
		title,
		content,
		tags,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		archived,
	};
}

describe("memory workflow", () => {
	test("adds explicit retrieve/save guidance without implicitly loading contents", async () => {
		await withStore(
			[memory("mem_commit", "Git commit message style", "Use plain descriptive Git commit subjects.", ["git"])],
			async (_file, runtime) => {
				const result = await runtime.handlers.get("before_agent_start")!({
					prompt: "How should I write the next Git commit?",
					systemPrompt: "base",
				});
				const prompt = result.systemPrompt as string;

				expect(prompt).toContain("[MEMORY WORKFLOW]");
				expect(prompt).toContain("first tool call");
				expect(prompt).toContain("Before the final response");
				expect(prompt).toContain("action=create");
				expect(prompt).not.toContain("mem_commit");
				expect(prompt).not.toContain("plain descriptive Git commit subjects");
			},
		);
	});

	test("keeps direct memory questions on the explicit retrieve path", async () => {
		const runtimeInstance = runtime();
		const result = await runtimeInstance.handlers.get("before_agent_start")!({
			prompt: "What do you remember about me?",
			systemPrompt: "base",
		});

		expect(result.systemPrompt).toContain("memory tool");
		expect(result.systemPrompt).toContain("first tool call");
	});

	test("uses ranked partial matches for broad natural-language retrieval", async () => {
		await withStore(
			[
				memory("mem_commit", "Git commit message style", "Use plain descriptive commit subjects.", [
					"git",
					"preference",
				]),
			],
			async (file, runtime) => {
				const tool = runtime.tools.get("memory")!;
				const result = await tool.execute("test", {
					action: "retrieve",
					query: "git commit style documentation preferences",
					limit: 5,
				});
				const text = (result.content as { text: string }[])[0].text;
				const stored = JSON.parse(await readFile(file, "utf8"));

				expect(text).toContain("mem_commit");
				expect(text).toContain("Git commit message style");
				expect(stored.memories).toHaveLength(1);
			},
		);
	});

	test("exposes proactive retrieval and safe persistence rules on the tool", () => {
		const tool = runtime().tools.get("memory")!;
		const guidelines = tool.promptGuidelines?.join("\n") ?? "";

		expect(guidelines).toContain("first tool call");
		expect(guidelines).toContain("action=create");
		expect(guidelines).toContain("Never save passwords");
	});
});
