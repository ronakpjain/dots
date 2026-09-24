import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createToolResultRenderer } from "./tool-results/render.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface LspMessage {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

interface Diagnostic {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	severity?: number;
	source?: string;
	message: string;
}

interface Location {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

interface Hover {
	contents: { kind: string; value: string } | string;
	range?: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

interface SymbolInformation {
	name: string;
	kind: number;
	location: Location;
}

interface LspServerConfig {
	command: string;
	args?: string[];
	languageIds: string[];
	fileExtensions: string[];
	initializationOptions?: Record<string, unknown>;
}

// ── Server Configs (matching your Neovim setup) ────────────────────────────

const LSP_SERVERS: Record<string, LspServerConfig> = {
	clangd: {
		command: "clangd",
		languageIds: ["c", "cpp", "objc", "objcpp"],
		fileExtensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh"],
	},
	pylsp: {
		command: "pylsp",
		languageIds: ["python"],
		fileExtensions: [".py"],
		initializationOptions: {
			pylsp: {
				plugins: {
					pyflakes: { enabled: false },
					pycodestyle: { enabled: false },
					mccabe: { enabled: false },
					pylint: { enabled: false },
					flake8: { enabled: false },
					ruff: { enabled: false },
					autopep8: { enabled: false },
					yapf: { enabled: false },
				},
			},
		},
	},
	gopls: {
		command: "gopls",
		languageIds: ["go"],
		fileExtensions: [".go"],
	},
	rust_analyzer: {
		command: "rust-analyzer",
		languageIds: ["rust"],
		fileExtensions: [".rs"],
	},
	lua_ls: {
		command: "lua-language-server",
		languageIds: ["lua"],
		fileExtensions: [".lua"],
		initializationOptions: {
			Lua: {
				hint: {
					enable: true,
					setType: true,
					paramType: true,
					paramName: "All",
					semicolon: "Disable",
					arrayIndex: "Enable",
				},
			},
		},
	},
	svelte: {
		command: "svelteserver",
		args: ["--stdio"],
		languageIds: ["svelte"],
		fileExtensions: [".svelte"],
	},
	typescript: {
		command: "typescript-language-server",
		args: ["--stdio"],
		languageIds: ["typescript", "javascript"],
		fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
	},
	neocmake: {
		command: "neocmakelsp",
		args: ["stdio"],
		languageIds: ["cmake"],
		fileExtensions: [".cmake", "CMakeLists.txt"],
	},
	verible: {
		command: "verible-verilog-ls",
		args: ["--flagfile=/Users/ronak/.verible-format.flags"],
		languageIds: ["verilog", "systemverilog"],
		fileExtensions: [".v", ".sv", ".vh", ".svh"],
	},
	texlab: {
		command: "texlab",
		args: ["run"],
		languageIds: ["latex"],
		fileExtensions: [".tex"],
		initializationOptions: {
			texlab: {
				build: {
					executable: "latexmk",
					args: ["-synctex=1", "-interaction=nonstopmode", "-pdf", "%f"],
					onSave: true,
					forwardSearchAfter: true,
				},
				forwardSearch: {
					executable: "/Users/ronak/.local/bin/zathura-texlab",
					args: ["%p"],
				},
			},
		},
	},
};

// ── Helpers ────────────────────────────────────────────────────────────────

const SEVERITY_MAP: Record<number, string> = {
	1: "Error",
	2: "Warning",
	3: "Info",
	4: "Hint",
};

const SYMBOL_KIND_MAP: Record<number, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

// ── LSP Client ─────────────────────────────────────────────────────────────

class LspClient {
	private server: ChildProcess | null = null;
	private messageId = 0;
	private pendingRequests: Map<number, (result: unknown) => void> = new Map();
	private buffer = "";
	private initialized = false;
	private config: LspServerConfig;
	private name: string;
	private openDocuments: Map<string, number> = new Map();
	private latestDiagnostics: Map<string, Diagnostic[]> = new Map();
	private diagnosticCallbacks: Map<string, (diags: Diagnostic[]) => void> = new Map();

	constructor(name: string, config: LspServerConfig) {
		this.name = name;
		this.config = config;
	}

	private sendRequest(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.server?.stdin) {
				reject(new Error(`${this.name} not running`));
				return;
			}

			const id = ++this.messageId;
			const message: LspMessage = { jsonrpc: "2.0", id, method, params };
			const content = JSON.stringify(message);
			const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

			this.pendingRequests.set(id, resolve);
			this.server.stdin.write(header + content);
		});
	}

	private sendNotification(method: string, params?: unknown): void {
		if (!this.server?.stdin) return;

		const message: LspMessage = { jsonrpc: "2.0", method, params };
		const content = JSON.stringify(message);
		const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
		this.server.stdin.write(header + content);
	}

	private parseMessages(): LspMessage[] {
		const messages: LspMessage[] = [];

		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const header = this.buffer.slice(0, headerEnd);
			const match = header.match(/Content-Length: (\d+)/);
			if (!match) break;

			const contentLength = parseInt(match[1], 10);
			const contentStart = headerEnd + 4;
			const totalLength = contentStart + contentLength;

			if (this.buffer.length < totalLength) break;

			const content = this.buffer.slice(contentStart, totalLength);
			this.buffer = this.buffer.slice(totalLength);

			try {
				messages.push(JSON.parse(content));
			} catch {
				// Skip malformed messages
			}
		}

		return messages;
	}

	private handleMessage(msg: LspMessage): void {
		if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
			const params = msg.params as {
				uri: string;
				diagnostics: Diagnostic[];
			};
			this.latestDiagnostics.set(params.uri, params.diagnostics);
			const callback = this.diagnosticCallbacks.get(params.uri);
			if (callback) callback(params.diagnostics);
			return;
		}

		if (msg.id !== undefined && msg.result !== undefined) {
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				this.pendingRequests.delete(msg.id);
				pending(msg.result);
			}
		}
	}

	async start(): Promise<void> {
		if (this.server) return;

		const args = this.config.args ?? [];
		this.server = spawn(this.config.command, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.server.stdout?.on("data", (data: Buffer) => {
			this.buffer += data.toString();
			const messages = this.parseMessages();
			for (const msg of messages) this.handleMessage(msg);
		});

		this.server.stderr?.on("data", () => {});

		this.server.on("exit", () => {
			this.server = null;
			this.initialized = false;
			this.openDocuments.clear();
			this.latestDiagnostics.clear();
			this.diagnosticCallbacks.clear();
			this.pendingRequests.clear();
		});

		await this.sendRequest("initialize", {
			processId: process.pid,
			capabilities: {
				textDocument: {
					synchronization: { didSave: true, didOpen: true, didClose: true },
					publishDiagnostics: {},
					definition: {},
					references: {},
					hover: {},
					documentSymbol: {},
				},
			},
			rootUri: null,
		});

		this.sendNotification("initialized", {});
		this.initialized = true;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		try {
			this.sendNotification("shutdown");
			this.server.kill();
		} catch {}
		this.server = null;
		this.initialized = false;
		this.openDocuments.clear();
		this.latestDiagnostics.clear();
		this.diagnosticCallbacks.clear();
	}

	private async ensureDocument(filePath: string, content: string): Promise<string> {
		await this.start();
		const uri = `file://${resolve(filePath)}`;
		const version = (this.openDocuments.get(uri) ?? 0) + 1;

		this.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: this.config.languageIds[0] ?? "plaintext",
				version,
				text: content,
			},
		});
		this.openDocuments.set(uri, version);
		return uri;
	}

	async getDiagnostics(filePath: string, content: string): Promise<Diagnostic[]> {
		const uri = await this.ensureDocument(filePath, content);

		const existing = this.latestDiagnostics.get(uri);
		if (existing && existing.length > 0) return existing;

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.diagnosticCallbacks.delete(uri);
				resolve(this.latestDiagnostics.get(uri) ?? []);
			}, 1500);

			this.diagnosticCallbacks.set(uri, (diags) => {
				clearTimeout(timeout);
				this.diagnosticCallbacks.delete(uri);
				resolve(diags);
			});
		});
	}

	async getDefinition(filePath: string, content: string, line: number, character: number): Promise<Location[]> {
		const uri = await this.ensureDocument(filePath, content);
		const result = await this.sendRequest("textDocument/definition", {
			textDocument: { uri },
			position: { line, character },
		});
		if (Array.isArray(result)) return result as Location[];
		if (result && typeof result === "object") return [result as Location];
		return [];
	}

	async getReferences(filePath: string, content: string, line: number, character: number): Promise<Location[]> {
		const uri = await this.ensureDocument(filePath, content);
		const result = await this.sendRequest("textDocument/references", {
			textDocument: { uri },
			position: { line, character },
			context: { includeDeclaration: true },
		});
		return (result as Location[]) ?? [];
	}

	async getHover(filePath: string, content: string, line: number, character: number): Promise<Hover | null> {
		const uri = await this.ensureDocument(filePath, content);
		const result = await this.sendRequest("textDocument/hover", {
			textDocument: { uri },
			position: { line, character },
		});
		return (result as Hover) ?? null;
	}

	async getDocumentSymbols(filePath: string, content: string): Promise<SymbolInformation[]> {
		const uri = await this.ensureDocument(filePath, content);
		const result = await this.sendRequest("textDocument/documentSymbol", {
			textDocument: { uri },
		});
		return (result as SymbolInformation[]) ?? [];
	}

	isRunning(): boolean {
		return this.server !== null && this.initialized;
	}
}

// ── Extension ──────────────────────────────────────────────────────────────

const clients: Map<string, LspClient> = new Map();

function getServerForFile(filePath: string): [string, LspServerConfig] | null {
	const ext = extname(filePath).toLowerCase();
	const basename = filePath.split("/").pop() ?? "";
	for (const [name, config] of Object.entries(LSP_SERVERS)) {
		if (config.fileExtensions.includes(ext)) return [name, config];
		if (basename === "CMakeLists.txt" && config.fileExtensions.includes("CMakeLists.txt")) return [name, config];
	}
	return null;
}

function getClient(name: string, config: LspServerConfig): LspClient {
	if (!clients.has(name)) clients.set(name, new LspClient(name, config));
	return clients.get(name)!;
}

function formatLocation(loc: Location, cwd: string): string {
	const path = loc.uri.replace("file://", "");
	const rel = path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
	const line = loc.range.start.line + 1;
	const col = loc.range.start.character + 1;
	return `${rel}:${line}:${col}`;
}

export default function (pi: ExtensionAPI) {
	// Capture args from tool_execution_start
	const pendingArgs = new Map<string, Record<string, unknown>>();

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			pendingArgs.set(event.toolCallId, event.args);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const args = pendingArgs.get(event.toolCallId);
		pendingArgs.delete(event.toolCallId);

		const isSupportedEdit = (event.toolName === "edit" || event.toolName === "write") && args?.path;

		if (!isSupportedEdit) return;

		const filePath = resolve(ctx.cwd, args.path as string);
		const match = getServerForFile(filePath);
		if (!match) return;

		const [serverName, config] = match;
		const client = getClient(serverName, config);

		try {
			const content = await readFile(filePath, "utf-8");
			const diagnostics = await client.getDiagnostics(filePath, content);

			if (diagnostics.length === 0) {
				ctx.ui.notify(`✓ ${serverName}: no issues`, "info");
				return;
			}

			const lines = [`${serverName}: ${diagnostics.length} issue(s) in ${args.path}`, ""];
			for (const diag of diagnostics.slice(0, 8)) {
				const severity = SEVERITY_MAP[diag.severity ?? 1] ?? "?";
				const line = diag.range.start.line + 1;
				lines.push(`  ${severity} L${line}: ${diag.message}`);
			}
			if (diagnostics.length > 8) lines.push(`  ... +${diagnostics.length - 8} more`);

			ctx.ui.notify(lines.join("\n"), diagnostics.some((d) => d.severity === 1) ? "error" : "warning");
		} catch {}
	});

	// ── LSP Tools ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "lsp_diagnostics",
		renderResult: createToolResultRenderer("lsp_diagnostics"),
		label: "LSP Diagnostics",
		description: "Get LSP diagnostics (errors, warnings) for a file",
		promptSnippet: "Get language server diagnostics for a file",
		promptGuidelines: ["Use lsp_diagnostics after editing a file to check for language-level errors and warnings."],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);
			const match = getServerForFile(filePath);
			if (!match) return { content: [{ type: "text" as const, text: `No LSP configured for ${params.path}` }], details: undefined };

			const [serverName, config] = match;
			const client = getClient(serverName, config);
			const content = await readFile(filePath, "utf-8");
			const diagnostics = await client.getDiagnostics(filePath, content);

			if (diagnostics.length === 0) {
				return { content: [{ type: "text" as const, text: `✓ ${serverName}: no issues in ${params.path}` }], details: undefined };
			}

			const lines = [`${serverName}: ${diagnostics.length} issue(s)`, ""];
			for (const diag of diagnostics) {
				const severity = SEVERITY_MAP[diag.severity ?? 1] ?? "?";
				const line = diag.range.start.line + 1;
				const col = diag.range.start.character + 1;
				lines.push(`${severity} L${line}:${col}: ${diag.message}`);
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "lsp_definition",
		renderResult: createToolResultRenderer("lsp_definition"),
		label: "LSP Go to Definition",
		description: "Go to definition of symbol at a position",
		promptSnippet: "Find definition of a symbol",
		promptGuidelines: ["Use lsp_definition to find where a function, variable, or type is defined."],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file" }),
			line: Type.Number({ description: "Line number (0-indexed)" }),
			character: Type.Number({ description: "Column number (0-indexed)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);
			const match = getServerForFile(filePath);
			if (!match) return { content: [{ type: "text" as const, text: `No LSP configured for ${params.path}` }], details: undefined };

			const [serverName, config] = match;
			const client = getClient(serverName, config);
			const content = await readFile(filePath, "utf-8");
			const locations = await client.getDefinition(filePath, content, params.line, params.character);

			if (locations.length === 0) {
				return { content: [{ type: "text" as const, text: "No definition found" }], details: undefined };
			}

			const lines = locations.map((loc) => formatLocation(loc, ctx.cwd));
			return { content: [{ type: "text" as const, text: `Definition(s):\n${lines.join("\n")}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "lsp_references",
		renderResult: createToolResultRenderer("lsp_references"),
		label: "LSP Find References",
		description: "Find all references to symbol at a position",
		promptSnippet: "Find all references to a symbol",
		promptGuidelines: ["Use lsp_references to find all usages of a function, variable, or type."],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file" }),
			line: Type.Number({ description: "Line number (0-indexed)" }),
			character: Type.Number({ description: "Column number (0-indexed)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);
			const match = getServerForFile(filePath);
			if (!match) return { content: [{ type: "text" as const, text: `No LSP configured for ${params.path}` }], details: undefined };

			const [serverName, config] = match;
			const client = getClient(serverName, config);
			const content = await readFile(filePath, "utf-8");
			const locations = await client.getReferences(filePath, content, params.line, params.character);

			if (locations.length === 0) {
				return { content: [{ type: "text" as const, text: "No references found" }], details: undefined };
			}

			const lines = locations.map((loc) => formatLocation(loc, ctx.cwd));
			return {
				content: [{ type: "text" as const, text: `Found ${lines.length} reference(s):\n${lines.join("\n")}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "lsp_hover",
		renderResult: createToolResultRenderer("lsp_hover"),
		label: "LSP Hover",
		description: "Get hover information (type, docs) for symbol at a position",
		promptSnippet: "Get type/docs for a symbol",
		promptGuidelines: ["Use lsp_hover to get the type signature or documentation for a symbol."],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file" }),
			line: Type.Number({ description: "Line number (0-indexed)" }),
			character: Type.Number({ description: "Column number (0-indexed)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);
			const match = getServerForFile(filePath);
			if (!match) return { content: [{ type: "text" as const, text: `No LSP configured for ${params.path}` }], details: undefined };

			const [serverName, config] = match;
			const client = getClient(serverName, config);
			const content = await readFile(filePath, "utf-8");
			const hover = await client.getHover(filePath, content, params.line, params.character);

			if (!hover) {
				return { content: [{ type: "text" as const, text: "No hover information available" }], details: undefined };
			}

			const text = typeof hover.contents === "string" ? hover.contents : hover.contents.value;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "lsp_symbols",
		renderResult: createToolResultRenderer("lsp_symbols"),
		label: "LSP Document Symbols",
		description: "List all symbols (functions, classes, variables) in a file",
		promptSnippet: "List symbols in a file",
		promptGuidelines: ["Use lsp_symbols to get an overview of all functions, classes, and variables in a file."],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);
			const match = getServerForFile(filePath);
			if (!match) return { content: [{ type: "text" as const, text: `No LSP configured for ${params.path}` }], details: undefined };

			const [serverName, config] = match;
			const client = getClient(serverName, config);
			const content = await readFile(filePath, "utf-8");
			const symbols = await client.getDocumentSymbols(filePath, content);

			if (symbols.length === 0) {
				return { content: [{ type: "text" as const, text: "No symbols found" }], details: undefined };
			}

			const lines = symbols.map((sym) => {
				const kind = SYMBOL_KIND_MAP[sym.kind] ?? "Unknown";
				const loc = formatLocation(sym.location, ctx.cwd);
				return `${kind} ${sym.name} @ ${loc}`;
			});

			return { content: [{ type: "text" as const, text: `Symbols (${lines.length}):\n${lines.join("\n")}` }], details: undefined };
		},
	});

	pi.on("session_shutdown", async () => {
		for (const client of clients.values()) await client.stop();
		clients.clear();
	});
}
