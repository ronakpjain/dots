import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type CheckStatus = "ok" | "warn" | "fail";

type Check = {
	label: string;
	status: CheckStatus;
	detail: string;
};

type JsonObject = Record<string, unknown>;

const DOCTOR_CAPABILITY =
	"[DOCTOR CAPABILITY] Use /doctor for a read-only health check of Pi extensions, configuration, memory storage, Robinhood auth/catalog state, Git, and LSP servers.";
const LSP_COMMANDS = [
	"clangd",
	"pylsp",
	"gopls",
	"rust-analyzer",
	"lua-language-server",
	"svelteserver",
	"typescript-language-server",
	"neocmakelsp",
	"verible-verilog-ls",
	"texlab",
];
const REQUIRED_EXTENSIONS = [
	"footer.ts",
	"goal-mode.ts",
	"memory.ts",
	"question.ts",
	"lsp.ts",
	"doctor.ts",
	"safety-gate.ts",
	"context-budget.ts",
	"checkpoint.ts",
	"session-automation.ts",
	"token-tracker.ts",
	"recheck/index.ts",
	"robinhood-mcp/index.ts",
];

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function memoryFile(): string {
	const configured = process.env.PI_MEMORY_FILE?.trim();
	if (configured) {
		if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
		return configured;
	}
	return join(agentDir(), "memories.json");
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readJson(path: string): Promise<JsonObject | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
	} catch {
		return undefined;
	}
}

function statusIcon(status: CheckStatus): string {
	return status === "ok" ? "✓" : status === "warn" ? "!" : "×";
}

function statusRank(status: CheckStatus): number {
	return status === "fail" ? 2 : status === "warn" ? 1 : 0;
}

async function runCheck(pi: ExtensionAPI, command: string, args: string[], cwd: string, timeout = 3_000) {
	return pi.exec(command, args, { cwd, timeout });
}

async function collectChecks(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<Check[]> {
	const rootResult = await runCheck(pi, "git", ["rev-parse", "--show-toplevel"], ctx.cwd);
	const gitRoot = rootResult.code === 0 ? rootResult.stdout.trim() : undefined;
	const settingsPath = join(agentDir(), "settings.json");
	const settings = await readJson(settingsPath);
	const storePath = memoryFile();
	const store = await readJson(storePath);
	const statePath = join(agentDir(), "extensions", "robinhood-mcp", ".state", "oauth.json");
	const oauth = await readJson(statePath);
	const allTools = pi.getAllTools().map((tool) => tool.name);
	const activeTools = new Set(pi.getActiveTools());
	const requiredTools = [
		"memory",
		"question",
		"goal_set_plan",
		"goal_verify",
		"goal_complete",
		"robinhood_search_tools",
	];
	const extensionChecks = await Promise.all(
		REQUIRED_EXTENSIONS.map(async (name): Promise<Check> => ({
			label: `extension ${name}`,
			status: (await exists(join(agentDir(), "extensions", name))) ? "ok" : "fail",
			detail: (await exists(join(agentDir(), "extensions", name))) ? "present" : "missing",
		})),
	);

	const checks: Check[] = [
		...extensionChecks,
		{
			label: "Pi settings",
			status: settings ? "ok" : "fail",
			detail: settings ? settingsPath : `invalid or missing: ${settingsPath}`,
		},
		{
			label: "memory store",
			status: !(await exists(storePath)) ? "ok" : store ? "ok" : "fail",
			detail: !(await exists(storePath))
				? `ready to create: ${storePath}`
				: store
					? `${storePath} is valid JSON`
					: `invalid JSON: ${storePath}`,
		},
		{
			label: "memory tool",
			status: allTools.includes("memory") ? "ok" : "fail",
			detail: allTools.includes("memory")
				? activeTools.has("memory")
					? "loaded and active"
					: "loaded but inactive"
				: "not loaded",
		},
		{
			label: "question tool",
			status: allTools.includes("question") ? "ok" : "fail",
			detail: allTools.includes("question")
				? activeTools.has("question")
					? "loaded and active"
					: "loaded but inactive"
				: "not loaded",
		},
		{
			label: "goal lifecycle tools",
			status: ["goal_set_plan", "goal_verify", "goal_complete"].every((name) => allTools.includes(name))
				? "ok"
				: "fail",
			detail: ["goal_set_plan", "goal_verify", "goal_complete"]
				.map((name) => `${name} ${allTools.includes(name) ? "loaded" : "missing"}`)
				.join(", "),
		},
		{
			label: "Robinhood search",
			status: allTools.includes("robinhood_search_tools") ? "ok" : "fail",
			detail: allTools.includes("robinhood_search_tools") ? "loaded" : "not loaded",
		},
		{
			label: "Robinhood auth",
			status:
				oauth?.tokens &&
				typeof oauth.tokens === "object" &&
				typeof (oauth.tokens as JsonObject).access_token === "string"
					? "ok"
					: "warn",
			detail:
				oauth?.tokens &&
				typeof oauth.tokens === "object" &&
				typeof (oauth.tokens as JsonObject).access_token === "string"
					? "token present (secret hidden)"
					: "authentication required",
		},
		{
			label: "Robinhood catalog",
			status: allTools.some((name) => name.startsWith("robinhood_") && name !== "robinhood_search_tools")
				? "ok"
				: "warn",
			detail: `${allTools.filter((name) => name.startsWith("robinhood_") && name !== "robinhood_search_tools").length} remote schema(s) registered; schemas load on demand`,
		},
		{
			label: "Git repository",
			status: gitRoot ? "ok" : "warn",
			detail: gitRoot ? gitRoot : "current directory is not inside a Git repository",
		},
	];

	if (!gitRoot) {
		checks.push({ label: "Git worktree", status: "warn", detail: "skipped" });
	} else {
		const branch = await runCheck(pi, "git", ["branch", "--show-current"], gitRoot);
		const status = await runCheck(pi, "git", ["status", "--short"], gitRoot);
		checks.push({
			label: "Git worktree",
			status: status.code === 0 ? "ok" : "warn",
			detail: `${branch.stdout.trim() || "detached HEAD"}${status.stdout.trim() ? ` · ${status.stdout.trim().split("\n").length} change(s)` : " · clean"}`,
		});
	}

	const lspChecks = await Promise.all(
		LSP_COMMANDS.map(async (command): Promise<Check> => {
			const result = await runCheck(pi, "which", [command], ctx.cwd, 2_000);
			return {
				label: `LSP ${command}`,
				status: result.code === 0 ? "ok" : "warn",
				detail: result.code === 0 ? result.stdout.trim() : "not found",
			};
		}),
	);
	checks.push(...lspChecks);

	const missingTools = requiredTools.filter((name) => !allTools.includes(name));
	if (missingTools.length > 0) {
		checks.push({ label: "required capabilities", status: "fail", detail: `missing: ${missingTools.join(", ")}` });
	}

	return checks;
}

function formatReport(checks: Check[]): string {
	const highest = checks.reduce<CheckStatus>(
		(current, check) => (statusRank(check.status) > statusRank(current) ? check.status : current),
		"ok",
	);
	const counts = checks.reduce(
		(result, check) => {
			result[check.status] += 1;
			return result;
		},
		{ ok: 0, warn: 0, fail: 0 } as Record<CheckStatus, number>,
	);
	const lines = [
		`Pi doctor · ${highest === "ok" ? "healthy" : highest === "warn" ? "attention needed" : "problems found"}`,
		`Summary: ${counts.ok} ok · ${counts.warn} warning · ${counts.fail} failed`,
		"",
		...checks.map((check) => `${statusIcon(check.status)} ${check.label}: ${check.detail}`),
	];
	return lines.join("\n");
}

export default function doctorExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${DOCTOR_CAPABILITY}`,
	}));

	pi.registerCommand("doctor", {
		description: "Run a read-only Pi health check",
		handler: async (_args, ctx) => {
			try {
				const report = formatReport(await collectChecks(pi, ctx));
				ctx.ui.notify(report, report.includes("×") ? "error" : report.includes("!") ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`Pi doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
