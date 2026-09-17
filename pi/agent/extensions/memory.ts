import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STORE_VERSION = 2;
const MAX_MEMORY_CONTENT = 20_000;
const MAX_RETURNED_CONTENT = 4_000;
const MAX_SEARCH_CONTENT = 1_200;
const DEFAULT_LIMIT = 5;
const MEMORY_CAPABILITY_PROMPT =
	"[MEMORY CAPABILITY] Persistent memory is available through the memory tool. Memory contents are only loaded after an explicit retrieve call; use focused queries or known ids when exact details matter. The tool also supports explicit archive, restore, delete, merge, and stats maintenance actions.";
const MEMORY_WORKFLOW_PROMPT = [
	"[MEMORY WORKFLOW]",
	"Use the memory tool proactively. For any non-trivial request involving project work, an ongoing task, a personal preference, a prior decision, or an established constraint, make a focused memory retrieve call before acting or making assumptions; this should normally be the first tool call. If no memory matches, continue with the task rather than dumping the full store.",
	"Before the final response, review whether the user stated an explicit preference, durable fact, decision, or reusable project constraint. Save genuinely durable information with memory action=create, or update an existing item with action=edit after retrieving it. If the user says to remember something, saving it is required unless they cancel or the information is unsafe to retain.",
	"Never save passwords, API keys, OTPs, payment data, or other secrets, and do not save transient one-off details or speculative assumptions. Avoid duplicate memories, and do not claim that something was remembered unless the memory tool actually saved it.",
].join("\n");

type MemoryAction = "create" | "edit" | "retrieve" | "archive" | "restore" | "delete" | "merge" | "stats";

interface Memory {
	id: string;
	title: string;
	content: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	archived: boolean;
}

interface MemoryStore {
	version: number;
	memories: Memory[];
}

interface MemoryStats {
	total: number;
	active: number;
	archived: number;
	tagCount: number;
}

interface MemoryDetails {
	action: MemoryAction;
	file: string;
	memory?: Memory;
	memories?: Memory[];
	count?: number;
	deletedId?: string;
	sourceId?: string;
	targetId?: string;
	stats?: MemoryStats;
}

const MemoryParams = Type.Object({
	action: StringEnum(["create", "edit", "retrieve", "archive", "restore", "delete", "merge", "stats"] as const),
	id: Type.Optional(
		Type.String({ description: "Memory id, required for edit/archive/restore/delete and optional for retrieve" }),
	),
	sourceId: Type.Optional(Type.String({ description: "Source memory id for merge" })),
	targetId: Type.Optional(Type.String({ description: "Target memory id for merge; id is accepted as an alias" })),
	title: Type.Optional(Type.String({ description: "Short title for a new or edited memory" })),
	content: Type.Optional(Type.String({ description: "The memory content for create or edit" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Optional searchable tags" })),
	query: Type.Optional(
		Type.String({ description: "Case-insensitive terms to search in ids, titles, content, and tags" }),
	),
	includeArchived: Type.Optional(Type.Boolean({ description: "Include archived memories in retrieve results" })),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Maximum memories to return for retrieve" }),
	),
});

function memoryFilePath(): string {
	const configured = process.env.PI_MEMORY_FILE?.trim();
	if (configured) {
		const expanded = configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
		return isAbsolute(expanded) ? expanded : resolve(expanded);
	}

	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "memories.json");
}

function nonEmpty(value: string | undefined, field: string): string {
	const trimmed = value?.trim() ?? "";
	if (!trimmed) throw new Error(`memory ${field} is required`);
	return trimmed;
}

function normalizeTags(tags: string[] | undefined): string[] {
	return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function validateStore(value: unknown, file: string): MemoryStore {
	if (!value || typeof value !== "object") throw new Error(`Memory file is not a JSON object: ${file}`);
	const candidate = value as { version?: unknown; memories?: unknown };
	if (!Array.isArray(candidate.memories)) throw new Error(`Memory file is missing a memories array: ${file}`);

	const memories = candidate.memories.map((memory, index) => {
		if (!memory || typeof memory !== "object") throw new Error(`Invalid memory at index ${index}: ${file}`);
		const item = memory as Partial<Memory>;
		if (
			typeof item.id !== "string" ||
			typeof item.title !== "string" ||
			typeof item.content !== "string" ||
			!Array.isArray(item.tags) ||
			!item.tags.every((tag) => typeof tag === "string") ||
			typeof item.createdAt !== "string" ||
			typeof item.updatedAt !== "string"
		) {
			throw new Error(`Invalid memory at index ${index}: ${file}`);
		}
		return {
			id: item.id,
			title: item.title,
			content: item.content,
			tags: normalizeTags(item.tags),
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			archived: item.archived === true,
		};
	});

	return { version: typeof candidate.version === "number" ? candidate.version : STORE_VERSION, memories };
}

async function readStore(file: string): Promise<MemoryStore> {
	try {
		const raw = await readFile(file, "utf8");
		return validateStore(JSON.parse(raw), file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: STORE_VERSION, memories: [] };
		}
		if (error instanceof SyntaxError) throw new Error(`Memory file contains invalid JSON: ${file}`);
		throw error;
	}
}

async function writeStore(file: string, store: MemoryStore): Promise<void> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	let moved = false;
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({ version: STORE_VERSION, memories: store.memories }, null, 2)}\n`,
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		await rename(temporary, file);
		moved = true;
	} finally {
		if (!moved) await unlink(temporary).catch(() => undefined);
	}
}

function publicMemory(memory: Memory, maxContent = MAX_RETURNED_CONTENT): Memory {
	return {
		...memory,
		content:
			maxContent === 0
				? "[content omitted; search with a focused query or retrieve by id]"
				: memory.content.length > maxContent
					? `${memory.content.slice(0, maxContent)}… [content truncated]`
					: memory.content,
	};
}

function findMemory(store: MemoryStore, id: string): Memory {
	const memory = store.memories.find((candidate) => candidate.id === id);
	if (!memory) throw new Error(`No memory found with id: ${id}`);
	return memory;
}

function retrieveMemories(
	store: MemoryStore,
	id: string | undefined,
	query: string | undefined,
	limit: number,
	includeArchived: boolean,
): Memory[] {
	const candidates = store.memories.filter((memory) => includeArchived || !memory.archived);
	if (id) return candidates.filter((memory) => memory.id === id).slice(0, 1);

	const terms = [...new Set((query ?? "").toLowerCase().split(/\s+/).filter(Boolean))];
	if (terms.length === 0) {
		return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
	}

	const matching = candidates
		.map((memory) => {
			const haystack = [memory.id, memory.title, memory.content, ...memory.tags].join(" ").toLowerCase();
			return { memory, matches: terms.filter((term) => haystack.includes(term)).length };
		})
		.filter((item) => item.matches > 0);
	// Preserve strict matching when it produces results, but fall back to
	// ranked partial matches for natural-language queries. This keeps focused
	// searches precise while preventing a single extra query word from hiding
	// otherwise useful memories.
	const strict = matching.filter((item) => item.matches === terms.length);
	return (strict.length > 0 ? strict : matching)
		.sort((a, b) => b.matches - a.matches || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
		.slice(0, limit)
		.map((item) => item.memory);
}

function memoryStats(store: MemoryStore): MemoryStats {
	return {
		total: store.memories.length,
		active: store.memories.filter((memory) => !memory.archived).length,
		archived: store.memories.filter((memory) => memory.archived).length,
		tagCount: new Set(store.memories.flatMap((memory) => memory.tags)).size,
	};
}

function textResult(text: string, details: MemoryDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function memoryExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: [event.systemPrompt, MEMORY_CAPABILITY_PROMPT, MEMORY_WORKFLOW_PROMPT].join("\n\n"),
	}));

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Create, edit, retrieve, archive, restore, delete, merge, and inspect persistent memories stored in a local JSON file. Retrieve relevant context before acting; retrieve before editing when you do not already know a memory id.",
		promptSnippet: "Retrieve relevant context and save durable user memories",
		promptGuidelines: [
			"Use memory with action=retrieve as the first tool call for non-trivial project, ongoing-task, preference, prior-decision, or established-constraint requests; use a focused query or known id and a small limit rather than retrieving the whole store.",
			"Use memory with action=create when the user explicitly asks to remember something or when a genuinely durable fact, preference, decision, or project constraint should be preserved; review for this before the final response.",
			"Use memory with action=edit only after retrieving the target memory or when its exact id is already known, and update an existing memory instead of creating a duplicate.",
			"Never save passwords, API keys, OTPs, payment data, other secrets, transient one-off details, or speculative assumptions with memory.",
			"Use archive/restore/delete/merge/stats only for explicit memory maintenance; merge archives the source after combining it into the target, and stats never returns memory content.",
		],
		parameters: MemoryParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const file = memoryFilePath();

			return withFileMutationQueue(file, async () => {
				const store = await readStore(file);
				const now = new Date().toISOString();

				if (params.action === "create") {
					const title = nonEmpty(params.title, "title");
					const content = nonEmpty(params.content, "content");
					if (content.length > MAX_MEMORY_CONTENT) {
						throw new Error(`memory content is limited to ${MAX_MEMORY_CONTENT} characters`);
					}

					const memory: Memory = {
						id: `mem_${randomUUID()}`,
						title,
						content,
						tags: normalizeTags(params.tags),
						createdAt: now,
						updatedAt: now,
						archived: false,
					};
					store.memories.push(memory);
					await writeStore(file, store);
					return textResult(`Created memory ${memory.id}: ${memory.title}`, {
						action: params.action,
						file,
						memory: publicMemory(memory),
					});
				}

				if (params.action === "edit") {
					const id = nonEmpty(params.id, "id");
					const memory = findMemory(store, id);
					if (params.title !== undefined) memory.title = nonEmpty(params.title, "title");
					if (params.content !== undefined) {
						memory.content = nonEmpty(params.content, "content");
						if (memory.content.length > MAX_MEMORY_CONTENT) {
							throw new Error(`memory content is limited to ${MAX_MEMORY_CONTENT} characters`);
						}
					}
					if (params.tags !== undefined) memory.tags = normalizeTags(params.tags);
					if (params.title === undefined && params.content === undefined && params.tags === undefined) {
						throw new Error("memory edit requires at least one of title, content, or tags");
					}
					memory.updatedAt = now;
					await writeStore(file, store);
					return textResult(`Updated memory ${memory.id}: ${memory.title}`, {
						action: params.action,
						file,
						memory: publicMemory(memory),
					});
				}

				if (params.action === "archive" || params.action === "restore") {
					const id = nonEmpty(params.id, "id");
					const memory = findMemory(store, id);
					memory.archived = params.action === "archive";
					memory.updatedAt = now;
					await writeStore(file, store);
					return textResult(
						`${params.action === "archive" ? "Archived" : "Restored"} memory ${memory.id}: ${memory.title}`,
						{
							action: params.action,
							file,
							memory: publicMemory(memory),
						},
					);
				}

				if (params.action === "delete") {
					const id = nonEmpty(params.id, "id");
					const index = store.memories.findIndex((memory) => memory.id === id);
					if (index < 0) throw new Error(`No memory found with id: ${id}`);
					store.memories.splice(index, 1);
					await writeStore(file, store);
					return textResult(`Deleted memory ${id}.`, {
						action: params.action,
						file,
						deletedId: id,
						count: store.memories.length,
					});
				}

				if (params.action === "merge") {
					const targetId = nonEmpty(params.targetId ?? params.id, "targetId");
					const sourceId = nonEmpty(params.sourceId, "sourceId");
					if (targetId === sourceId) throw new Error("memory merge requires different targetId and sourceId");
					const target = findMemory(store, targetId);
					const source = findMemory(store, sourceId);
					const mergedContent = `${target.content.trim()}\n\n${source.content.trim()}`.trim();
					if (mergedContent.length > MAX_MEMORY_CONTENT) {
						throw new Error(`merged memory content is limited to ${MAX_MEMORY_CONTENT} characters`);
					}
					target.content = mergedContent;
					target.tags = normalizeTags([...target.tags, ...source.tags]);
					target.archived = false;
					target.updatedAt = now;
					source.archived = true;
					source.updatedAt = now;
					await writeStore(file, store);
					return textResult(`Merged memory ${source.id} into ${target.id}; source archived.`, {
						action: params.action,
						file,
						memory: publicMemory(target),
						sourceId: source.id,
						targetId: target.id,
					});
				}

				if (params.action === "stats") {
					const stats = memoryStats(store);
					return textResult(
						`Memory stats: ${stats.total} total · ${stats.active} active · ${stats.archived} archived · ${stats.tagCount} unique tags`,
						{ action: params.action, file, stats },
					);
				}

				const limit = params.limit ?? DEFAULT_LIMIT;
				const query = params.query?.trim();
				const includeArchived = params.includeArchived === true;
				const matches = retrieveMemories(store, params.id, query, limit, includeArchived);
				if (matches.length === 0) {
					return textResult("No memories found.", { action: params.action, file, memories: [], count: 0 });
				}

				const isFocused = Boolean(params.id || query);
				const memories = matches.map((memory) => publicMemory(memory, isFocused ? MAX_SEARCH_CONTENT : 0));
				const lines = memories.map((memory) => {
					const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
					const archived = memory.archived ? " (archived)" : "";
					return isFocused
						? `- ${memory.id}: ${memory.title}${archived}${tags}\n  ${memory.content}`
						: `- ${memory.id}: ${memory.title}${archived}${tags}`;
				});
				const availableCount = store.memories.filter((memory) => includeArchived || !memory.archived).length;
				const heading = isFocused
					? `Found ${memories.length} memor${memories.length === 1 ? "y" : "ies"}`
					: `Memory index (${availableCount} available; showing ${memories.length})`;
				const suffix = isFocused ? "" : "\nUse a focused query or id to retrieve memory content.";
				return textResult(`${heading}:${suffix}\n${lines.join("\n")}`, {
					action: params.action,
					file,
					memories,
					count: memories.length,
				});
			});
		},
		renderCall(args, theme) {
			const suffix =
				args.action === "retrieve"
					? args.query
						? ` · ${args.query}`
						: args.id
							? ` · ${args.id}`
							: ""
					: args.action === "merge"
						? ` · ${args.targetId ?? args.id ?? "?"} ← ${args.sourceId ?? "?"}`
						: args.id
							? ` · ${args.id}`
							: "";
			return new Text(
				theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("accent", `${args.action}${suffix}`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as MemoryDetails | undefined;
			if (details?.action === "retrieve") {
				return new Text(
					theme.fg("success", `✓ ${details.count ?? 0} memor${details.count === 1 ? "y" : "ies"}`),
					0,
					0,
				);
			}
			if (details?.action === "stats") return new Text(theme.fg("success", "✓ Memory stats"), 0, 0);
			if (details?.action === "delete") return new Text(theme.fg("success", "✓ Memory deleted"), 0, 0);
			if (details?.action === "archive" || details?.action === "restore" || details?.action === "merge") {
				return new Text(theme.fg("success", `✓ Memory ${details.action}`), 0, 0);
			}
			return new Text(theme.fg("success", "✓ Memory saved"), 0, 0);
		},
	});
}
