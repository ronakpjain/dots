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

type Command = {
	handler: Handler;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
};

type Runtime = {
	handlers: Map<string, Handler>;
	commands: Map<string, Command>;
	notifications: Array<{ text: string; level: string }>;
	tools: Map<string, Tool>;
};

function runtime(): Runtime {
	const result: Runtime = {
		handlers: new Map(),
		commands: new Map(),
		notifications: [],
		tools: new Map(),
	};
	memoryExtension({
		on: (event: string, handler: Handler) => result.handlers.set(event, handler),
		registerCommand: (name: string, command: Command) => result.commands.set(name, command),
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

function commandContext(runtime: Runtime) {
	return {
		ui: {
			notify: (text: string, level: string) => runtime.notifications.push({ text, level }),
		},
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
		expect(result.systemPrompt).toContain("[MEMORY TASK CHECK]");
	});

	test("injects a targeted agent check for varied substantial project requests", async () => {
		const runtimeInstance = runtime();
		const beforeAgentStart = runtimeInstance.handlers.get("before_agent_start")!;
		const prompts = [
			"Implement the next feature in this repository using the architecture decision we made earlier.",
			"Optimize these database queries.",
			"Test this endpoint.",
			"Analyze this module.",
			"Help with the deployment.",
		];

		for (const prompt of prompts) {
			const result = await beforeAgentStart({ prompt, systemPrompt: "base" });
			expect(result.systemPrompt).toContain("[MEMORY TASK CHECK]");
		}

		const projectTask = await beforeAgentStart({ prompt: prompts[0], systemPrompt: "base" });
		expect(projectTask.systemPrompt).toContain("Before editing, creating, or making consequential assumptions");
		expect(projectTask.systemPrompt).toContain("When the task is complete, review");
	});

	test("avoids the targeted check for clearly trivial or general prompts", async () => {
		const runtimeInstance = runtime();
		const beforeAgentStart = runtimeInstance.handlers.get("before_agent_start")!;
		const prompts = [
			"Hello there!",
			"Thanks for your help.",
			"What is 2 + 2?",
			"Can you solve this math problem?",
			"How does recursion work?",
			"How do I optimize a database query?",
			"What is the architecture?",
		];

		for (const prompt of prompts) {
			const result = await beforeAgentStart({ prompt, systemPrompt: "base" });
			expect(result.systemPrompt).not.toContain("[MEMORY TASK CHECK]");
		}
	});

	test("registers a discoverable command and shows help without reading memory content", async () => {
		await withStore(
			[memory("mem_secret", "Private note", "This content should not be shown by help.")],
			async (_file, runtime) => {
				expect(runtime.commands.has("memory")).toBe(true);
				const command = runtime.commands.get("memory")!;
				expect(command.getArgumentCompletions?.("").map((item) => item.value)).toEqual([
					"help",
					"list",
					"search",
					"stats",
				]);

				await command.handler("", commandContext(runtime));

				expect(runtime.notifications.at(-1)?.level).toBe("info");
				expect(runtime.notifications.at(-1)?.text).toContain("/memory list");
				expect(runtime.notifications.at(-1)?.text).toContain("/memory search <query>");
				expect(runtime.notifications.at(-1)?.text).not.toContain("This content should not be shown");
			},
		);
	});

	test("lists active memory metadata without exposing content and supports archived listing", async () => {
		await withStore(
			[
				memory("mem_active", "Active preference", "Do not expose this list content.", ["style"]),
				memory("mem_archived", "Old preference", "Archived content stays hidden by default.", ["old"], true),
			],
			async (_file, runtime) => {
				const command = runtime.commands.get("memory")!;
				await command.handler("list", commandContext(runtime));
				const activeList = runtime.notifications.at(-1)!.text;

				expect(activeList).toContain("mem_active");
				expect(activeList).toContain("Active preference");
				expect(activeList).toContain("[style]");
				expect(activeList).not.toContain("mem_archived");
				expect(activeList).not.toContain("Do not expose this list content");

				await command.handler("list --all", commandContext(runtime));
				const allList = runtime.notifications.at(-1)!.text;
				expect(allList).toContain("mem_archived");
				expect(allList).toContain("(archived)");
				expect(allList).not.toContain("Archived content stays hidden");
			},
		);
	});

	test("bounds command metadata and total output for oversized stored fields", async () => {
		const oversized = "x".repeat(2_000);
		const memories = Array.from({ length: 60 }, (_, index) =>
			memory(
				`${"mem_"}${"id".repeat(100)}${index}`,
				`${oversized} title ${index}`,
				`${oversized} content ${index}`,
				Array.from({ length: 30 }, (_, tagIndex) => `${oversized} tag ${tagIndex}`),
			),
		);

		await withStore(memories, async (_file, runtime) => {
			const command = runtime.commands.get("memory")!;
			await command.handler("list", commandContext(runtime));
			const result = runtime.notifications.at(-1)!.text;

			expect(result.length).toBeLessThanOrEqual(12_000);
			expect(result).toContain("[output truncated]");
			expect(result).not.toContain(oversized);

			await command.handler(`search ${"q".repeat(501)}`, commandContext(runtime));
			expect(runtime.notifications.at(-1)?.level).toBe("warning");
			expect(runtime.notifications.at(-1)?.text.length).toBeLessThanOrEqual(12_000);
		});
	});

	test("searches focused content, omits archived results by default, and reports misses", async () => {
		await withStore(
			[
				memory("mem_git", "Git preference", "Use concise commit subjects.", ["git"]),
				memory("mem_old", "Old Git preference", "Use the old format.", ["git"], true),
			],
			async (_file, runtime) => {
				const command = runtime.commands.get("memory")!;
				await command.handler("search git", commandContext(runtime));
				const result = runtime.notifications.at(-1)!.text;

				expect(result).toContain('Memory search for "git"');
				expect(result).toContain("mem_git");
				expect(result).toContain("Use concise commit subjects.");
				expect(result).not.toContain("mem_old");

				await command.handler("search missing", commandContext(runtime));
				expect(runtime.notifications.at(-1)!.text).toBe("No memories found for: missing");

				await command.handler("search git --all", commandContext(runtime));
				expect(runtime.notifications.at(-1)!.text).toContain("mem_old");
			},
		);
	});

	test("shows stats without returning memory content and validates command usage", async () => {
		await withStore(
			[
				memory("mem_one", "One", "First content", ["shared"]),
				memory("mem_two", "Two", "Second content", ["shared", "other"], true),
			],
			async (_file, runtime) => {
				const command = runtime.commands.get("memory")!;
				await command.handler("stats", commandContext(runtime));
				const stats = runtime.notifications.at(-1)!;

				expect(stats.level).toBe("info");
				expect(stats.text).toContain("2 total");
				expect(stats.text).toContain("1 active");
				expect(stats.text).toContain("1 archived");
				expect(stats.text).toContain("2 unique tags");
				expect(stats.text).not.toContain("First content");

				await command.handler("search", commandContext(runtime));
				expect(runtime.notifications.at(-1)).toEqual({
					text: "Usage: /memory search <query> [--all]",
					level: "warning",
				});

				await command.handler("stats --all", commandContext(runtime));
				expect(runtime.notifications.at(-1)?.level).toBe("warning");
				expect(runtime.notifications.at(-1)?.text).toContain("Usage: /memory stats");

				await command.handler("search shared --unknown", commandContext(runtime));
				expect(runtime.notifications.at(-1)?.level).toBe("warning");
				expect(runtime.notifications.at(-1)?.text).toContain("Unsupported memory argument: --unknown");
			},
		);
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

		expect(guidelines).toContain("For non-trivial project work or ongoing tasks");
		expect(guidelines).toContain("first tool call");
		expect(guidelines).toContain("Do not call memory for isolated factual questions");
		expect(guidelines).toContain("At the end of a task, review");
		expect(guidelines).toContain("action=create");
		expect(guidelines).toContain("retrieve/search first to avoid creating a duplicate");
		expect(guidelines).toContain("action=edit");
		expect(guidelines).toContain("Never save passwords");
		expect(guidelines).toContain("transient one-off details");
		expect(guidelines).toContain("speculative assumptions");
	});
});
