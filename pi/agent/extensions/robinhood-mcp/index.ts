import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createToolResultRenderer } from "../tool-results/render.ts";

const MCP_URL = process.env.ROBINHOOD_MCP_URL ?? "https://agent.robinhood.com/mcp/trading";
const DATA_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "robinhood-mcp", ".state");
const STATE_FILE = path.join(DATA_DIR, "oauth.json");
const REDIRECT_URI = process.env.ROBINHOOD_MCP_REDIRECT_URI ?? "http://127.0.0.1:3334/callback";

type McpClient = import("@modelcontextprotocol/sdk/client/index.js", { with: { "resolution-mode": "import" } }).Client;
type McpTransport = import("@modelcontextprotocol/sdk/client/streamableHttp.js", {
	with: { "resolution-mode": "import" },
}).StreamableHTTPClientTransport;

type Stored = {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	state?: string;
	discoveryState?: OAuthDiscoveryState;
};

async function load(): Promise<Stored> {
	try {
		return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}
async function save(patch: Partial<Stored>) {
	await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
	const next = { ...(await load()), ...patch };
	await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}
function openUrl(url: URL) {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
	execFile(cmd, args, () => {});
}

function isUnauthorizedError(error: unknown): boolean {
	return (
		error instanceof Error && (error.name === "UnauthorizedError" || error.constructor.name === "UnauthorizedError")
	);
}

class FileOAuthProvider implements OAuthClientProvider {
	get redirectUrl() {
		return REDIRECT_URI;
	}
	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "pi-coding-agent Robinhood MCP",
			redirect_uris: [REDIRECT_URI],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: "openid profile email",
		};
	}
	async state() {
		const s = crypto.randomBytes(16).toString("hex");
		await save({ state: s });
		return s;
	}
	async clientInformation() {
		return (await load()).clientInformation;
	}
	async saveClientInformation(clientInformation: OAuthClientInformationMixed) {
		await save({ clientInformation });
	}
	async tokens() {
		return (await load()).tokens;
	}
	async saveTokens(tokens: OAuthTokens) {
		await save({ tokens });
	}
	async codeVerifier() {
		return (await load()).codeVerifier ?? "";
	}
	async saveCodeVerifier(codeVerifier: string) {
		await save({ codeVerifier });
	}
	async redirectToAuthorization(authorizationUrl: URL) {
		console.log(`\nRobinhood MCP authorization required:\n${authorizationUrl}\n`);
		openUrl(authorizationUrl);
	}
	async saveDiscoveryState(discoveryState: OAuthDiscoveryState) {
		await save({ discoveryState });
	}
	async discoveryState() {
		return (await load()).discoveryState;
	}
}

const ROBINHOOD_SEARCH_TOOL = "robinhood_search_tools";
const ROBINHOOD_CAPABILITY_PROMPT =
	"[ROBINHOOD CAPABILITY] Robinhood capabilities are available on demand. Use robinhood_search_tools with a focused task to load only the matching brokerage tool schemas; do not assume every Robinhood tool is active.";

type CatalogTool = {
	name: string;
	piName: string;
	description: string;
};

export default function (pi: ExtensionAPI) {
	let client: McpClient | undefined;
	let catalogLoad: Promise<void> | undefined;

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${ROBINHOOD_CAPABILITY_PROMPT}`,
	}));
	let transport: McpTransport | undefined;
	let toolsRegistered = false;
	const catalog = new Map<string, CatalogTool>();

	async function connect() {
		if (client) return client;

		// The MCP SDK is only needed when a Robinhood capability is used. Keeping
		// it out of the startup module graph avoids ~50ms of cold-start work.
		const [{ Client: McpClient }, { StreamableHTTPClientTransport: McpTransport }] = await Promise.all([
			import("@modelcontextprotocol/sdk/client/index.js"),
			import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
		]);
		const authProvider = new FileOAuthProvider();
		const nextTransport = new McpTransport(new URL(MCP_URL), { authProvider });
		transport = nextTransport;
		const c = new McpClient({ name: "pi-coding-agent", version: "1.0.0" });
		await c.connect(nextTransport);
		client = c;
		return c;
	}

	pi.registerTool({
		name: ROBINHOOD_SEARCH_TOOL,
		renderResult: createToolResultRenderer(ROBINHOOD_SEARCH_TOOL),
		label: "Robinhood: Search tools",
		description:
			"Search the authenticated Robinhood capability catalog and load only the tools needed for the current task. Capabilities include quotes, portfolio, positions, orders, options, earnings, watchlists, screeners, and market data.",
		promptSnippet: "Search and load Robinhood capabilities on demand",
		promptGuidelines: [
			"Use robinhood_search_tools before calling a Robinhood tool; only matching tool definitions are loaded into context.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Capability or task to search for, such as portfolio value, AAPL quote, or option chain",
			}),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of matching tools to load" }),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!toolsRegistered) {
				catalogLoad ??= registerMcpTools(ctx).finally(() => {
					catalogLoad = undefined;
				});
				try {
					await catalogLoad;
				} catch (error) {
					const message = isUnauthorizedError(error)
						? "Robinhood MCP needs authentication. Complete the browser login, then run /robinhood-auth with the redirected URL or code."
						: `Robinhood MCP unavailable: ${error instanceof Error ? error.message : String(error)}`;
					return {
						content: [{ type: "text", text: message }],
						details: { matches: [], added: [], error: message },
					};
				}
			}

			const terms = params.query
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter(Boolean);
			const matches = [...catalog.values()]
				.map((tool) => {
					const haystack = `${tool.piName} ${tool.name} ${tool.description}`.toLowerCase();
					const score =
						terms.length === 0
							? 1
							: terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
					return { tool, score };
				})
				.filter((match) => match.score > 0)
				.sort((a, b) => b.score - a.score || a.tool.piName.localeCompare(b.tool.piName))
				.slice(0, params.limit ?? 5)
				.map((match) => match.tool);

			const active = pi.getActiveTools();
			const added = matches.map((tool) => tool.piName).filter((name) => !active.includes(name));
			pi.setActiveTools([...new Set([...active, ...added])]);

			const text =
				matches.length === 0
					? `No Robinhood tools matched: ${params.query}`
					: `${added.length > 0 ? `Loaded ${added.length} Robinhood tool${added.length === 1 ? "" : "s"}` : "Matching Robinhood tools are already loaded"}:\n${matches.map((tool) => `- ${tool.piName}: ${tool.description}`).join("\n")}`;
			return {
				content: [{ type: "text", text }],
				details: { matches: matches.map((tool) => tool.piName), added },
			};
		},
	});

	async function registerMcpTools(ctx?: ExtensionContext) {
		const c = await connect();
		const listed = await c.listTools();
		const registeredNames: string[] = [];

		for (const t of listed.tools ?? []) {
			const name = `robinhood_${t.name.replace(/[^A-Za-z0-9_]/g, "_")}`;
			const description = t.description ?? `Robinhood MCP tool ${t.name}`;
			catalog.set(name, { name: t.name, piName: name, description });
			registeredNames.push(name);

			pi.registerTool({
				name,
				renderResult: createToolResultRenderer(name),
				label: `Robinhood: ${t.name}`,
				description,
				// Deliberately omit promptSnippet/promptGuidelines. These tools are
				// registered up front but activated only by robinhood_search_tools.
				parameters: Type.Unsafe(t.inputSchema ?? { type: "object", properties: {} }),
				async execute(_id, params, signal) {
					const res = await (
						await connect()
					).callTool({ name: t.name, arguments: params as any }, undefined, { signal });
					return {
						content: (res.content as any) ?? [{ type: "text", text: JSON.stringify(res) }],
						details: { tool: t.name },
					};
				},
			});
		}

		toolsRegistered = true;
		const activeWithoutRobinhood = pi.getActiveTools().filter((name) => !registeredNames.includes(name));
		pi.setActiveTools([...new Set([...activeWithoutRobinhood, ROBINHOOD_SEARCH_TOOL])]);
		ctx?.ui?.notify(`Robinhood MCP catalog ready: ${registeredNames.length} tools available on demand`, "info");
	}

	pi.registerCommand("robinhood-auth", {
		description: "Finish Robinhood MCP OAuth with the redirected URL or code",
		handler: async (args, ctx) => {
			if (!transport) {
				try {
					await connect();
				} catch (error) {
					if (!isUnauthorizedError(error)) {
						ctx.ui.notify(
							`Robinhood MCP failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
				}
			}

			const code = args.includes("code=") ? new URL(args).searchParams.get("code") : args.trim();
			if (!code || !transport) {
				ctx.ui.notify("Authorize in the browser, then pass the redirected URL or code.", "error");
				return;
			}
			await transport.finishAuth(code);
			client = undefined;
			if (!toolsRegistered) await registerMcpTools(ctx);
			ctx.ui.notify("Robinhood MCP authenticated.", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		try {
			await transport?.close();
		} catch {}
		client = undefined;
		transport = undefined;
	});
}
