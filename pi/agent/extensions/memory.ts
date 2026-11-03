import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderToolResult } from "./tool-results/render.ts";

const STORE_VERSION = 2;
const MAX_MEMORY_CONTENT = 20_000;
const MAX_MEMORY_TITLE = 240;
const MAX_MEMORY_ID = 200;
const MAX_MEMORY_TAG = 80;
const MAX_MEMORY_TAGS = 20;
const MAX_MEMORY_QUERY = 500;
const MAX_RETURNED_CONTENT = 4_000;
const MAX_SEARCH_CONTENT = 1_200;
const MAX_OUTPUT = 12_000;
const OUTPUT_TRUNCATION = "… [output truncated]";
const FIELD_TRUNCATION = "… [truncated]";
const DEFAULT_LIMIT = 5;
const COMMAND_LIST_LIMIT = 50;
const MEMORY_WORKFLOW_PROMPT = [
	"Retrieve focused memory before non-trivial work or decisions involving prior context; skip routine tasks. Use only relevant matches.",
	"Proactively save verified, reusable discoveries and user preferences. Search first and update existing notes rather than duplicate them.",
	"Never store secrets, speculation, transient details, or task logs. Memory is loaded only through explicit retrieval.",
].join("\n");
const MEMORY_COMMAND_HELP = [
	"Persistent memory commands:",
	"  /memory              Show this help",
	"  /memory list         List active memories (titles and tags only)",
	"  /memory search <query>  Search memory and show focused snippets",
	"  /memory stats        Show counts without memory content",
	"  /memory help         Show this help",
	"Add --all to list or search to include archived memories. Use the memory tool for create, edit, archive, restore, delete, and merge actions.",
].join("\n");

type MemoryAction = "create" | "edit" | "retrieve" | "archive" | "restore" | "delete" | "merge" | "stats";

interface Memory {
	id: string;
	project: string;
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
		Type.String({
			description: "Memory id, required for edit/archive/restore/delete and optional for retrieve",
			maxLength: MAX_MEMORY_ID,
		}),
	),
	sourceId: Type.Optional(Type.String({ description: "Source memory id for merge", maxLength: MAX_MEMORY_ID })),
	targetId: Type.Optional(
		Type.String({
			description: "Target memory id for merge; id is accepted as an alias",
			maxLength: MAX_MEMORY_ID,
		}),
	),
	title: Type.Optional(
		Type.String({ description: "Short title for a new or edited memory", maxLength: MAX_MEMORY_TITLE }),
	),
	content: Type.Optional(Type.String({ description: "The memory content for create or edit" })),
	tags: Type.Optional(
		Type.Array(Type.String({ maxLength: MAX_MEMORY_TAG }), {
			description: "Optional searchable tags",
			maxItems: MAX_MEMORY_TAGS,
		}),
	),
	project: Type.Optional(
		Type.String({ description: "Memory scope: current (default), global, all (retrieve only), or an explicit project path" }),
	),
	query: Type.Optional(
		Type.String({
			description: "Case-insensitive terms to search in ids, titles, content, and tags",
			maxLength: MAX_MEMORY_QUERY,
		}),
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

async function currentProject(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3_000 });
		if (result.code === 0 && result.stdout.trim()) return resolve(result.stdout.trim());
	} catch {
		// Non-Git working directories still get a stable path-based project scope.
	}
	return resolve(cwd || process.cwd());
}

async function resolveProject(pi: ExtensionAPI, value: string | undefined, cwd: string): Promise<string> {
	if (value === "global") return "global";
	if (value === "all") return "all";
	if (value === undefined || value === "current") return currentProject(pi, cwd || process.cwd());
	return resolve(cwd || process.cwd(), value);
}

function nonEmpty(value: string | undefined, field: string): string {
	const trimmed = value?.trim() ?? "";
	if (!trimmed) throw new Error(`memory ${field} is required`);
	return trimmed;
}

function limitedNonEmpty(value: string | undefined, field: string, maxLength: number): string {
	const trimmed = nonEmpty(value, field);
	if (trimmed.length > maxLength) throw new Error(`memory ${field} is limited to ${maxLength} characters`);
	return trimmed;
}

function truncate(value: string, maxLength: number, marker = FIELD_TRUNCATION): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= marker.length) return marker.slice(0, maxLength);
	return `${value.slice(0, maxLength - marker.length)}${marker}`;
}

function boundedOutput(value: string): string {
	return truncate(value, MAX_OUTPUT, OUTPUT_TRUNCATION);
}

function normalizeTags(tags: string[] | undefined): string[] {
	return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function memoryTags(tags: string[] | undefined): string[] {
	if ((tags?.length ?? 0) > MAX_MEMORY_TAGS) {
		throw new Error(`memory tags are limited to ${MAX_MEMORY_TAGS} items`);
	}
	const normalized = normalizeTags(tags);
	if (normalized.some((tag) => tag.length > MAX_MEMORY_TAG)) {
		throw new Error(`memory tags are limited to ${MAX_MEMORY_TAG} characters each`);
	}
	return normalized;
}

function memoryQuery(query: string | undefined): string | undefined {
	if (query === undefined) return undefined;
	const trimmed = query.trim();
	if (trimmed.length > MAX_MEMORY_QUERY) {
		throw new Error(`memory query is limited to ${MAX_MEMORY_QUERY} characters`);
	}
	return trimmed;
}

function shouldRetrieveAtStart(prompt: string | undefined): boolean {
	if (typeof prompt !== "string") return false;
	const normalized = prompt.trim().toLowerCase();
	if (!normalized) return false;

	const directMemory = /\b(memory|remember(?:ed)?|recall|forget)\b/.test(normalized);
	const priorContext =
		/\b(prior|previous|earlier|last time|as before|continue|ongoing|follow[- ]?up|resume|preference|prefer(?:s)?|decision|constraint|convention)\b/.test(
			normalized,
		) || /\balready (?:discussed|decided|established)\b/.test(normalized);
	if (directMemory || priorContext) return true;

	// Keep routine touch-ups out, but recognize substantial work even when the
	// prompt does not use an explicit word such as "project" or "repository".
	const routineEdit = /\b(typo|spelling|grammar|formatting?|whitespace|punctuation)\b/.test(normalized);
	if (routineEdit) return false;

	const projectContext =
		/\b(project|repo(?:sitory)?|code(?:base)?|source|file|document|docs?|readme|changelog|feature|bug|issue|pull request|pr|git|commit|architecture|workflow|system|application|app|service|server|client|api|endpoint|route|handler|middleware|database|db|sql|query|queries|module|component|function|class|package|dependency|dependencies|library|script|algorithm|model|test suite|tests?|spec(?:ification)?|schema|migration|deployment|rollout|release|build|pipeline|config(?:uration)?|environment|integration|ui|ux|frontend|backend|cli|command|branch|merge|container|docker|kubernetes|cloud|infra(?:structure)?|performance|security|production|staging|logs?|error|exception|incident)\b/.test(
			normalized,
		);
	const substantialAction =
		/\b(implement|build|develop|debug|refactor|design|architect(?:s|ed|ing)?|plan|investigat(?:e|es|ed|ing)|migrat(?:e|es|ed|ing)|integrat(?:e|es|ed|ing)|add|create|write|edit|review|configure|modify|change|update|fix|improve|enhance|optimi[sz](?:e|es|ed|ing)|test(?:ed|ing)?|analy[sz](?:e|es|ed|ing)|diagnos(?:e|es|ed|ing)|deploy(?:s|ed|ing)?|validate|verify|benchmark|profile|upgrade|remove|delete|replace|rename|rewrite|automate|document|maintain|run|execute|check|inspect|assess|evaluate|examine|compare|summarize|explain|understand|describe|address|handle|work on|troubleshoot|resolve|trace|measure|monitor|clean up|look into|set up|setup|help|solve)\b/.test(
			normalized,
		);
	const scopedWork =
		/\b(?:this|these|that|those|our|my)\s+(?:task|work|request|change|setup|implementation|approach|behavior)\b/.test(
			normalized,
		);
	const directGeneralQuestion =
		/^(?:what(?:'s| is| are| was| were| should| can| would)|who(?:'s| is| are)|when|where|why|how(?:'s| is| are| does| do| can| should)|(?:can|could|would) you (?:explain|tell me)|tell me about|explain)\b/.test(
			normalized,
		);
	const scopedReference =
		/\b(?:this|these|that|those|our|my|current|existing|next)\b/.test(normalized) ||
		/\bhelp\s+(?:me|us|with|on|fix|understand)\b/.test(normalized);

	// A concrete scoped request is worth checking, while a direct one-shot
	// question should not turn a broad technical noun into a task signal.
	return substantialAction && (projectContext || scopedWork) && (!directGeneralQuestion || scopedReference);
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
			project: typeof (memory as { project?: unknown }).project === "string"
				? (memory as { project: string }).project
				: "global",
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
	const tags = memory.tags.slice(0, MAX_MEMORY_TAGS).map((tag) => truncate(tag, MAX_MEMORY_TAG));
	if (memory.tags.length > MAX_MEMORY_TAGS) tags.push(`+${memory.tags.length - MAX_MEMORY_TAGS} tags omitted`);
	return {
		...memory,
		id: truncate(memory.id, MAX_MEMORY_ID),
		title: truncate(memory.title, MAX_MEMORY_TITLE),
		tags,
		createdAt: truncate(memory.createdAt, 64),
		updatedAt: truncate(memory.updatedAt, 64),
		content:
			maxContent === 0
				? "[content omitted; search with a focused query or retrieve by id]"
				: truncate(memory.content, maxContent, "… [content truncated]"),
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
	projects?: Set<string>,
): Memory[] {
	const candidates = store.memories.filter(
		(memory) => (includeArchived || !memory.archived) && (!projects || projects.has(memory.project)),
	);
	// A known id is an intentional request and remains retrievable across scopes.
	if (id) return store.memories.filter((memory) => (includeArchived || !memory.archived) && memory.id === id).slice(0, 1);

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

function formatStats(stats: MemoryStats): string {
	return boundedOutput(
		`Memory stats: ${stats.total} total · ${stats.active} active · ${stats.archived} archived · ${stats.tagCount} unique tags`,
	);
}

function memoryLine(memory: Memory, includeContent: boolean): string {
	const display = publicMemory(memory, includeContent ? MAX_SEARCH_CONTENT : 0);
	const tags = display.tags.length > 0 ? ` [${display.tags.join(", ")}]` : "";
	const archived = display.archived ? " (archived)" : "";
	const scope = display.project === "global" ? "global" : `project: ${display.project}`;
	return includeContent
		? `- ${display.id}: ${display.title} (${scope})${archived}${tags}\n  ${display.content}`
		: `- ${display.id}: ${display.title} (${scope})${archived}${tags}`;
}

function formatMemoryIndex(memories: Memory[], availableCount: number): string {
	const lines = memories.map((memory) => memoryLine(memory, false));
	const shown = `Memory index (${availableCount} available; showing ${memories.length}):`;
	const suffix = "Use /memory search <query> or the memory tool with a focused query or id to retrieve content.";
	return boundedOutput(`${shown}\n${lines.length > 0 ? `${lines.join("\n")}\n` : ""}${suffix}`);
}

function formatMemorySearch(query: string, memories: Memory[]): string {
	const displayQuery = truncate(query, MAX_MEMORY_QUERY);
	if (memories.length === 0) return boundedOutput(`No memories found for: ${displayQuery}`);
	const lines = memories.map((memory) => memoryLine(memory, true));
	return boundedOutput(
		`Memory search for \"${displayQuery}\" (${memories.length} result${memories.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
	);
}

function formatToolRetrieval(
	store: MemoryStore,
	memories: Memory[],
	isFocused: boolean,
	includeArchived: boolean,
	projects?: Set<string>,
): string {
	if (memories.length === 0) return "No memories found.";
	const lines = memories.map((memory) => memoryLine(memory, isFocused));
	const availableCount = store.memories.filter(
		(memory) => (includeArchived || !memory.archived) && (!projects || projects.has(memory.project)),
	).length;
	const heading = isFocused
		? `Found ${memories.length} memor${memories.length === 1 ? "y" : "ies"}`
		: `Memory index (${availableCount} available; showing ${memories.length})`;
	const suffix = isFocused ? "" : "\nUse a focused query or id to retrieve memory content.";
	return boundedOutput(`${heading}:${suffix}\n${lines.join("\n")}`);
}

function textResult(text: string, details: MemoryDetails) {
	return { content: [{ type: "text" as const, text: boundedOutput(text) }], details };
}

function commandTokens(args: string): {
	action: string;
	values: string[];
	includeArchived: boolean;
	invalid: string[];
} {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const action = (tokens.shift() ?? "help").toLowerCase();
	const includeArchived = tokens.some((token) => token === "--all" || token === "--archived");
	const invalid = tokens.filter((token) => token.startsWith("-") && token !== "--all" && token !== "--archived");
	return {
		action,
		values: tokens.filter((token) => token !== "--all" && token !== "--archived" && !token.startsWith("-")),
		includeArchived,
		invalid,
	};
}

function commandUsage(action: string): string {
	if (action === "list") return "Usage: /memory list [--all]";
	if (action === "search") return "Usage: /memory search <query> [--all]";
	if (action === "stats") return "Usage: /memory stats";
	return "Usage: /memory [help]";
}

async function executeMemoryCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const { action, values, includeArchived, invalid } = commandTokens(args);
	if (action !== "list" && action !== "search" && action !== "stats" && action !== "help") {
		ctx.ui.notify(
			boundedOutput(`Unknown memory command: ${truncate(action, MAX_MEMORY_ID)}\n\n${MEMORY_COMMAND_HELP}`),
			"warning",
		);
		return;
	}
	if (invalid.length > 0) {
		const options = invalid.map((option) => truncate(option, MAX_MEMORY_TAG)).join(", ");
		ctx.ui.notify(
			`${boundedOutput(`Unsupported memory argument: ${options}`)}\n${commandUsage(action)}`,
			"warning",
		);
		return;
	}
	if (action === "help") {
		if (values.length > 0 || includeArchived) {
			ctx.ui.notify(`${commandUsage(action)}\n${MEMORY_COMMAND_HELP}`, "warning");
		} else {
			ctx.ui.notify(MEMORY_COMMAND_HELP, "info");
		}
		return;
	}
	if ((action === "list" && values.length > 0) || (action === "stats" && (values.length > 0 || includeArchived))) {
		ctx.ui.notify(`${commandUsage(action)}\n${MEMORY_COMMAND_HELP}`, "warning");
		return;
	}
	if (action === "search" && values.length === 0) {
		ctx.ui.notify(commandUsage(action), "warning");
		return;
	}

	let query = "";
	if (action === "search") {
		try {
			query = memoryQuery(values.join(" ")) ?? "";
		} catch (error) {
			ctx.ui.notify(
				`Invalid memory command: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			return;
		}
	}

	const file = memoryFilePath();
	try {
		await withFileMutationQueue(file, async () => {
			const store = await readStore(file);
			const cwd = ctx.cwd || process.cwd();
			const projects = new Set([await currentProject(pi, cwd), "global"]);
			if (action === "stats") {
				ctx.ui.notify(formatStats(memoryStats(store)), "info");
				return;
			}

			if (action === "list") {
				const available = store.memories.filter(
					(memory) => (includeArchived || !memory.archived) && projects.has(memory.project),
				);
				const memories = retrieveMemories(store, undefined, undefined, COMMAND_LIST_LIMIT, includeArchived, projects);
				ctx.ui.notify(formatMemoryIndex(memories, available.length), "info");
				return;
			}

			const matches = retrieveMemories(store, undefined, query, DEFAULT_LIMIT, includeArchived, projects);
			const memories = matches.map((memory) => publicMemory(memory, MAX_SEARCH_CONTENT));
			ctx.ui.notify(formatMemorySearch(query, memories), "info");
		});
	} catch (error) {
		ctx.ui.notify(
			boundedOutput(`Memory command failed: ${error instanceof Error ? error.message : String(error)}`),
			"error",
		);
	}
}

export default function memoryExtension(pi: ExtensionAPI): void {
	let retrievalRequired = false;
	let retrieved = false;
	pi.on("tool_call", (event) => {
		if (retrievalRequired && !retrieved && (event.toolName === "edit" || event.toolName === "write")) {
			return { block: true, reason: "Retrieve relevant memory before changing files for this task. Call memory with action=retrieve and a focused query; an empty successful search is sufficient. Then retry this operation." };
		}
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "memory" && event.input.action === "retrieve" && !event.isError) retrieved = true;
	});
	pi.on("before_agent_start", (event) => {
		retrievalRequired = shouldRetrieveAtStart("prompt" in event ? event.prompt : undefined);
		retrieved = false;
		return { systemPrompt: `${event.systemPrompt}\n\n${MEMORY_WORKFLOW_PROMPT}` };
	});

	pi.registerCommand("memory", {
		description: "Browse persistent memory or search saved context",
		getArgumentCompletions: (prefix) =>
			["help", "list", "search", "stats"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => executeMemoryCommand(args, ctx, pi),
	});

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Create, edit, retrieve, archive, restore, delete, merge, and inspect persistent memories stored in a local JSON file. Retrieve relevant context before acting; retrieve before editing when you do not already know a memory id.",
		promptSnippet: "Retrieve relevant context and save durable user memories",
		promptGuidelines: [
			"For non-trivial project work or ongoing tasks, and for requests involving a preference, prior decision, or established constraint, use memory with action=retrieve early (usually the first tool call) before editing, creating, or making consequential assumptions; use a focused query or known id and a small limit. Default retrieval includes only the current project and global memories; use project=all only for deliberate cross-project retrieval. Treat matches as candidates and ignore unrelated context.",
			"Do not call memory for isolated factual questions, routine edits, or tasks where saved context is unlikely to matter; never retrieve the whole store just in case. Memory contents are never implicitly injected.",
			"Proactively save verified, reusable discoveries from meaningful work—hard-won debugging lessons, reliable workflows, and decisions—even without an explicit remember request. Repeated user instructions and corrections are a strong save/update signal. Keep notes small, atomic, and actionable; retrieve/search first, edit stale memories rather than duplicating them, and create only safe, useful notes.",
			"At the end of a task, review for a user-requested or genuinely durable fact, preference, decision, reusable discovery, or project constraint. Use action=create only when safe and useful; retrieve/search first to avoid duplicates, then use action=edit for an existing memory.",
			"Use memory with action=edit only after retrieving the target memory or when its exact id is already known, and update an existing memory instead of creating a duplicate.",
			"Never save passwords, API keys, OTPs, payment data, other secrets, transient one-off details, or speculative assumptions with memory.",
			"Use archive/restore/delete/merge/stats only for explicit memory maintenance; merge archives the source after combining it into the target, and stats never returns memory content.",
		],
		parameters: MemoryParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const file = memoryFilePath();
			const cwd = typeof _ctx?.cwd === "string" && _ctx.cwd ? _ctx.cwd : process.cwd();

			return withFileMutationQueue(file, async () => {
				const store = await readStore(file);
				const now = new Date().toISOString();

				if (params.action === "create") {
					const project = await resolveProject(pi, params.project, cwd);
					if (project === "all") throw new Error("project=all is only valid for retrieve");
					const title = limitedNonEmpty(params.title, "title", MAX_MEMORY_TITLE);
					const content = nonEmpty(params.content, "content");
					const tags = memoryTags(params.tags);
					if (content.length > MAX_MEMORY_CONTENT) {
						throw new Error(`memory content is limited to ${MAX_MEMORY_CONTENT} characters`);
					}

					const memory: Memory = {
						id: `mem_${randomUUID()}`,
						project,
						title,
						content,
						tags,
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
					const id = limitedNonEmpty(params.id, "id", MAX_MEMORY_ID);
					const memory = findMemory(store, id);
					if (params.project !== undefined) {
						const project = await resolveProject(pi, params.project, cwd);
						if (project === "all") throw new Error("project=all is only valid for retrieve");
						memory.project = project;
					}
					if (params.title !== undefined)
						memory.title = limitedNonEmpty(params.title, "title", MAX_MEMORY_TITLE);
					if (params.content !== undefined) {
						memory.content = nonEmpty(params.content, "content");
						if (memory.content.length > MAX_MEMORY_CONTENT) {
							throw new Error(`memory content is limited to ${MAX_MEMORY_CONTENT} characters`);
						}
					}
					if (params.tags !== undefined) memory.tags = memoryTags(params.tags);
					if (
						params.title === undefined &&
						params.content === undefined &&
						params.tags === undefined &&
						params.project === undefined
					) {
						throw new Error("memory edit requires at least one of title, content, tags, or project");
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
					const id = limitedNonEmpty(params.id, "id", MAX_MEMORY_ID);
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
					const id = limitedNonEmpty(params.id, "id", MAX_MEMORY_ID);
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
					const targetId = limitedNonEmpty(params.targetId ?? params.id, "targetId", MAX_MEMORY_ID);
					const sourceId = limitedNonEmpty(params.sourceId, "sourceId", MAX_MEMORY_ID);
					if (targetId === sourceId) throw new Error("memory merge requires different targetId and sourceId");
					const target = findMemory(store, targetId);
					const source = findMemory(store, sourceId);
					if (target.project !== source.project) {
						throw new Error("memory merge requires both memories to have the same project scope");
					}
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
					return textResult(formatStats(stats), { action: params.action, file, stats });
				}

				const limit = params.limit ?? DEFAULT_LIMIT;
				const query = memoryQuery(params.query);
				const includeArchived = params.includeArchived === true;
				const project = await resolveProject(pi, params.project, cwd);
				const projects =
					project === "all"
						? undefined
						: params.project === undefined || params.project === "current"
							? new Set([project, "global"])
							: new Set([project]);
				const matches = retrieveMemories(store, params.id, query, limit, includeArchived, projects);
				const isFocused = Boolean(params.id || query);
				const memories = matches.map((memory) => publicMemory(memory, isFocused ? MAX_SEARCH_CONTENT : 0));
				return textResult(formatToolRetrieval(store, memories, isFocused, includeArchived, projects), {
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
		renderResult(result, options, theme, context) {
			return renderToolResult("memory", result, options, theme, context, {
				collapsedSummary: (toolResult) => {
					const details = toolResult.details as MemoryDetails | undefined;
					if (details?.action === "retrieve") {
						return `${details.count ?? 0} memor${details.count === 1 ? "y" : "ies"}`;
					}
				if (details?.action === "stats") return "Memory stats";
				if (details?.action === "delete") return "Memory deleted";
				if (details?.action === "archive" || details?.action === "restore" || details?.action === "merge") {
					return `Memory ${details.action}`;
				}
				return "Memory saved";
				},
			});
		},
	});
}
