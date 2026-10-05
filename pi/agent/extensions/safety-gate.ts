import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

export type Risk = {
	category: string;
	detail: string;
	/** A conservative operation family that may be remembered for this session. */
	family?: string;
};

export type ApprovalStore = {
	exact: Set<string>;
	related: Set<string>;
};

type ShellFamily = string | ((command: string) => string);
type ShellCheck = [RegExp, string, ShellFamily];

type ApprovalScope = keyof ApprovalStore;

const BUILTIN_TOOL_NAMES = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
const ALLOW_ONCE = "Allow once";
const ALLOW_EXACT = "Always allow this exact command in this session";
const ALLOW_RELATED = "Always allow related commands in this session";
const DENY = "Deny";
const DENY_WITH_REASON = "Deny and tell model why";
const SAFETY_CAPABILITY =
	"[SAFETY CAPABILITY] A default-on permission gate protects destructive shell, Git, deployment, and sensitive-file actions. Normal coding edits do not need confirmation; denied dangerous actions must not be retried without approval. The gate can remember an explicitly selected exact command or operation family for the current session only.";

function normalizeCommand(command: string): string {
	// Keep newlines intact: unlike spaces/tabs, they can separate shell commands.
	return command.replace(/[ \t\r]+/g, " ").trim();
}

function stableSerialize(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value !== "object") return JSON.stringify(String(value));
	if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;

	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`)
		.join(",")}}`;
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function workspacePath(cwd: string): string {
	return resolve(cwd);
}

function canonicalInput(event: ToolCallEvent): unknown {
	if (event.toolName !== "bash" || !event.input || typeof event.input !== "object") return event.input;
	const input = event.input as Record<string, unknown>;
	if (typeof input.command !== "string") return input;
	return { ...input, command: normalizeCommand(input.command) };
}

/** Return a stable, horizontal-whitespace-insensitive fingerprint for a tool call. */
export function exactApprovalKey(event: ToolCallEvent, cwd: string, risk: Risk): string {
	return `exact:${fingerprint(
		stableSerialize({
			cwd: workspacePath(cwd),
			tool: event.toolName,
			category: risk.category,
			input: canonicalInput(event),
		}),
	)}`;
}

/** Return a session approval key for the operation family, when one is safe to offer. */
export function relatedApprovalKey(event: ToolCallEvent, cwd: string, risk: Risk): string | undefined {
	if (!risk.family) return undefined;
	return `related:${fingerprint(
		stableSerialize({
			cwd: workspacePath(cwd),
			tool: event.toolName,
			category: risk.category,
			family: risk.family,
		}),
	)}`;
}

export function createApprovalStore(): ApprovalStore {
	return { exact: new Set(), related: new Set() };
}

export function hasApproval(event: ToolCallEvent, cwd: string, risk: Risk, approvals: ApprovalStore): boolean {
	if (approvals.exact.has(exactApprovalKey(event, cwd, risk))) return true;
	const related = relatedApprovalKey(event, cwd, risk);
	return related !== undefined && approvals.related.has(related);
}

export function rememberApproval(
	scope: ApprovalScope,
	event: ToolCallEvent,
	cwd: string,
	risk: Risk,
	approvals: ApprovalStore,
): void {
	const key = scope === "exact" ? exactApprovalKey(event, cwd, risk) : relatedApprovalKey(event, cwd, risk);
	if (!key) return;

	approvals[scope].add(key);
}

function isSimpleShellCommand(command: string): boolean {
	// Shell expansions and compound commands are deliberately exact-only: a
	// remembered `rm` approval must not cover a newly introduced substitution,
	// glob, chain, or pipeline.
	return ![";", "&", "|", "\n", "`", "$", ">", "<", "*", "?", "[", "]", "{", "}"].some((token) =>
		command.includes(token),
	);
}

function gitFamily(operation: string, command: string): string {
	const normalized = normalizeCommand(command);
	const match = normalized.match(/(?:^|[;&|\n])git\s+(?:-C\s+(\S+)\s+)?/i);
	const prefix = `git${match?.[1] ? ` -C ${match[1]}` : ""}`;
	if (operation !== "push") return `${prefix} ${operation}`;

	const push = normalized.match(/(?:^|[;&|\n])git\s+(?:-C\s+\S+\s+)?push(?:\s+(.*))?$/i);
	const remote = push?.[1]?.split(" ").find((token) => !token.startsWith("-")) ?? "<default>";
	return `${prefix} push ${remote}`;
}

function sudoFamily(command: string): string {
	const tokens = normalizeCommand(command).split(" ");
	const sudoIndex = tokens.findIndex((token) => token.toLowerCase() === "sudo");
	if (sudoIndex < 0) return "sudo";

	let index = sudoIndex + 1;
	while (index < tokens.length && tokens[index]?.startsWith("-")) {
		const option = tokens[index];
		index += 1;
		if (["-u", "--user", "-g", "--group", "-h", "--host", "-C", "--chdir"].includes(option ?? "")) index += 1;
	}
	return `sudo ${tokens[index]?.toLowerCase() ?? "command"}`;
}

function rmFamily(command: string): string {
	const match = normalizeCommand(command).match(/(?:^|[;&|\n])(?:command\s+)?rm\s+(.+)$/i);
	if (!match) return "rm";
	const options: string[] = [];
	for (const token of match[1].split(" ")) {
		if (!token.startsWith("-")) break;
		options.push(token);
		if (token === "--") break;
	}
	return `rm${options.length ? ` ${options.join(" ")}` : ""}`;
}

function chmodFamily(command: string): string {
	const normalized = normalizeCommand(command);
	const mode = normalized.match(/\b(777|666)\b/i)?.[1] ?? "unsafe";
	return `chmod${/\bchmod\s+-R\s+/i.test(normalized) ? " -R" : ""} ${mode}`;
}

function shellRisk(command: string): Risk | undefined {
	const checks: ShellCheck[] = [
		[/(^|[;&|\n]\s*)(?:command\s+)?rm(?:\s+(?:--?[A-Za-z][A-Za-z-]*|--))*\s+\S+/i, "file deletion", rmFamily],
		[/(^|[;&|\n]\s*)(?:command\s+)?rmdir\s+/i, "directory deletion", "rmdir"],
		[
			/(^|[;&|\n]\s*)git\s+(?:-C\s+\S+\s+)?reset\s+--hard(?:\s|$)/i,
			"destructive Git operation",
			(value) => gitFamily("reset --hard", value),
		],
		[
			/(^|[;&|\n]\s*)git\s+(?:-C\s+\S+\s+)?clean\s+-[^\n]*f/i,
			"destructive Git operation",
			(value) => gitFamily("clean", value),
		],
		[
			/(^|[;&|\n]\s*)git\s+(?:-C\s+\S+\s+)?checkout\s+--(?:\s|$)/i,
			"destructive Git operation",
			(value) => gitFamily("checkout --", value),
		],
		[
			/(^|[;&|\n]\s*)git\s+(?:-C\s+\S+\s+)?restore\s+--worktree(?:\s|$)/i,
			"destructive Git operation",
			(value) => gitFamily("restore --worktree", value),
		],
		[
			/(^|[;&|\n]\s*)git\s+(?:-C\s+\S+\s+)?branch\s+-D(?:\s|$)/i,
			"destructive Git operation",
			(value) => gitFamily("branch -D", value),
		],
		[
			/(^|[;&|\n]\s*)git\s+(?:-C\s+\S+\s+)?rebase(?:\s|$)/i,
			"destructive Git operation",
			(value) => gitFamily("rebase", value),
		],
		[/(^|[;&|\n]\s*)git\s+(?:-C\s+\S+\s+)?push(?:\s|$)/i, "remote Git write", (value) => gitFamily("push", value)],
		[
			/(^|[;&|\n]\s*)git\s+(?:-C\s+\S+\s+)?commit(?:\s|$)/i,
			"Git history write",
			(value) => gitFamily("commit", value),
		],
		[/(^|[;&|\n]\s*)find\s+[^\n]*\s-delete/i, "file deletion", "find -delete"],
		[/(^|[;&|\n]\s*)(?:xargs|parallel)\s+[^\n]*\b(?:rm|rmdir)\b/i, "file deletion", "xargs/parallel deletion"],
		[
			/(^|[;&|\n]\s*)docker\s+compose\s+down(?:\s|$)/i,
			"deployment or infrastructure change",
			"docker compose down",
		],
		[/(^|[;&|\n]\s*)docker\s+compose\s+rm(?:\s|$)/i, "deployment or infrastructure change", "docker compose rm"],
		[/(^|[;&|\n]\s*)docker\s+compose\s+up(?:\s|$)/i, "deployment or infrastructure change", "docker compose up"],
		[/(^|[;&|\n]\s*)docker\s+run(?:\s|$)/i, "deployment or infrastructure change", "docker run"],
		[
			/(^|[;&|\n]\s*)docker\s+system\s+prune(?:\s|$)/i,
			"deployment or infrastructure change",
			"docker system prune",
		],
		[/(^|[;&|\n]\s*)docker\s+rm(?:\s|$)/i, "deployment or infrastructure change", "docker rm"],
		[/(^|[;&|\n]\s*)kubectl\s+apply(?:\s|$)/i, "deployment or infrastructure change", "kubectl apply"],
		[/(^|[;&|\n]\s*)kubectl\s+delete(?:\s|$)/i, "deployment or infrastructure change", "kubectl delete"],
		[/(^|[;&|\n]\s*)kubectl\s+replace(?:\s|$)/i, "deployment or infrastructure change", "kubectl replace"],
		[/(^|[;&|\n]\s*)helm\s+install(?:\s|$)/i, "deployment or infrastructure change", "helm install"],
		[/(^|[;&|\n]\s*)helm\s+upgrade(?:\s|$)/i, "deployment or infrastructure change", "helm upgrade"],
		[/(^|[;&|\n]\s*)helm\s+uninstall(?:\s|$)/i, "deployment or infrastructure change", "helm uninstall"],
		[/(^|[;&|\n]\s*)terraform\s+apply(?:\s|$)/i, "deployment or infrastructure change", "terraform apply"],
		[/(^|[;&|\n]\s*)terraform\s+destroy(?:\s|$)/i, "deployment or infrastructure change", "terraform destroy"],
		[/(^|[;&|\n]\s*)pulumi\s+up(?:\s|$)/i, "deployment or infrastructure change", "pulumi up"],
		[/(^|[;&|\n]\s*)pulumi\s+destroy(?:\s|$)/i, "deployment or infrastructure change", "pulumi destroy"],
		[/(^|[;&|\n]\s*)systemctl\s+start(?:\s|$)/i, "deployment or infrastructure change", "systemctl start"],
		[/(^|[;&|\n]\s*)systemctl\s+stop(?:\s|$)/i, "deployment or infrastructure change", "systemctl stop"],
		[/(^|[;&|\n]\s*)systemctl\s+restart(?:\s|$)/i, "deployment or infrastructure change", "systemctl restart"],
		[/(^|[;&|\n]\s*)systemctl\s+enable(?:\s|$)/i, "deployment or infrastructure change", "systemctl enable"],
		[/(^|[;&|\n]\s*)systemctl\s+disable(?:\s|$)/i, "deployment or infrastructure change", "systemctl disable"],
		[/(^|[;&|\n]\s*)npm\s+publish(?:\s|$)/i, "package publication", "npm publish"],
		[/(^|[;&|\n]\s*)pnpm\s+publish(?:\s|$)/i, "package publication", "pnpm publish"],
		[/(^|[;&|\n]\s*)yarn\s+publish(?:\s|$)/i, "package publication", "yarn publish"],
		[/(^|[;&|\n]\s*)bun\s+publish(?:\s|$)/i, "package publication", "bun publish"],
		[/(^|[;&|\n]\s*)rsync\s+[^\n]*--delete/i, "synchronized deletion", "rsync --delete"],
		[/(?:curl)\s+[^\n|]*\|\s*(?:sh|bash|zsh|sudo)/i, "remote script execution", "curl | shell"],
		[/(?:wget)\s+[^\n|]*\|\s*(?:sh|bash|zsh|sudo)/i, "remote script execution", "wget | shell"],
		[/(^|[;&|\n]\s*)sudo\s+/i, "privileged command", sudoFamily],
		[/(^|[;&|\n]\s*)chmod\s+(?:-R\s+)?(?:777|666)\b/i, "unsafe permission change", chmodFamily],
	];

	const checkedCommand = command.trim();
	const match = checks.find(([pattern]) => pattern.test(checkedCommand));
	if (!match) return undefined;

	const candidateFamily = typeof match[2] === "function" ? match[2](checkedCommand) : match[2];
	return {
		category: match[1],
		detail: checkedCommand.slice(0, 800),
		family: isSimpleShellCommand(checkedCommand) ? candidateFamily : undefined,
	};
}

function pathRisk(pathValue: unknown, cwd: string, toolName = "path"): Risk | undefined {
	if (typeof pathValue !== "string" || !pathValue.trim()) return undefined;
	const path = pathValue.trim();
	const workspace = workspacePath(cwd);
	const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
	const relative =
		absolute === workspace
			? ""
			: absolute.startsWith(`${workspace}/`)
				? absolute.slice(workspace.length + 1)
				: undefined;
	const sensitive =
		/(^|\/)(?:\.env(?:\.|$)|\.ssh(?:\/|$)|\.aws(?:\/|$)|credentials?\b|secrets?\b|oauth\.json$|id_rsa(?:\.pub)?$|settings\.json$|trust\.json$)/i.test(
			absolute,
		);
	if (relative === undefined || sensitive) {
		return {
			category: sensitive ? "sensitive file change" : "file change outside the workspace",
			detail: absolute,
			family: `${toolName}:${absolute}`,
		};
	}
	return undefined;
}

function customRisk(event: ToolCallEvent): Risk | undefined {
	if (BUILTIN_TOOL_NAMES.has(event.toolName)) return undefined;
	if (/(?:delete|destroy|deploy|publish|withdraw|transfer|close)/i.test(event.toolName)) {
		return { category: "high-impact tool", detail: event.toolName, family: `tool:${event.toolName}` };
	}
	return undefined;
}

export function riskFor(event: ToolCallEvent, cwd: string): Risk | undefined {
	if (isToolCallEventType("bash", event)) return shellRisk(event.input.command);
	if (isToolCallEventType("write", event)) return pathRisk(event.input.path, cwd, event.toolName);
	if (isToolCallEventType("edit", event)) return pathRisk(event.input.path, cwd, event.toolName);
	return customRisk(event);
}

function approvalCount(approvals: ApprovalStore): number {
	return approvals.exact.size + approvals.related.size;
}

export default function safetyGateExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let approvals = createApprovalStore();

	const updateStatus = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }): void => {
		const remembered = approvalCount(approvals);
		ctx.ui.setStatus(
			"safety-gate",
			`safety ${enabled ? "on" : "off"}${remembered ? ` · ${remembered} remembered` : ""}`,
		);
	};

	const clearApprovals = (): void => {
		approvals = createApprovalStore();
	};

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${SAFETY_CAPABILITY}`,
	}));

	pi.registerCommand("safety", {
		description: "Inspect or change the destructive-action permission gate",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command || command === "status") {
				ctx.ui.notify(
					`Safety gate: ${enabled ? "on" : "off"}\nSession approvals: ${approvals.exact.size} exact, ${approvals.related.size} related`,
					enabled ? "info" : "warning",
				);
				return;
			}
			if (command === "on") {
				enabled = true;
				updateStatus(ctx);
				ctx.ui.notify("Safety gate enabled.", "info");
				return;
			}
			if (command === "off") {
				if (
					!(await ctx.ui.confirm(
						"Disable safety gate?",
						"Destructive tools will run without confirmation until the session reloads.",
					))
				)
					return;
				enabled = false;
				updateStatus(ctx);
				ctx.ui.notify("Safety gate disabled for this session.", "warning");
				return;
			}
			if (command === "clear") {
				clearApprovals();
				updateStatus(ctx);
				ctx.ui.notify("Remembered safety approvals cleared for this session.", "info");
				return;
			}
			ctx.ui.notify("Usage: /safety [status|on|off|clear]", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearApprovals();
		updateStatus(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		clearApprovals();
		ctx.ui.setStatus("safety-gate", undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		const risk = riskFor(event, ctx.cwd);
		if (!risk) return;
		if (hasApproval(event, ctx.cwd, risk, approvals)) return;

		if (!ctx.hasUI) {
			return { block: true, reason: `Blocked ${risk.category}: interactive approval is unavailable.` };
		}

		const options = [ALLOW_ONCE, ALLOW_EXACT];
		if (risk.family) options.push(ALLOW_RELATED);
		options.push(DENY, DENY_WITH_REASON);
		const choice = await ctx.ui.select(`Approve ${risk.category}?\n\n${risk.detail}`, options, {
			signal: ctx.signal,
			timeout: 120_000,
		});

		if (choice === ALLOW_ONCE) return;
		if (choice === ALLOW_EXACT) {
			rememberApproval("exact", event, ctx.cwd, risk, approvals);
			updateStatus(ctx);
			return;
		}
		if (choice === ALLOW_RELATED && risk.family) {
			rememberApproval("related", event, ctx.cwd, risk, approvals);
			updateStatus(ctx);
			return;
		}
		if (choice === DENY_WITH_REASON) {
			let explanation: string | undefined;
			try {
				explanation = await ctx.ui.input(
					"Why deny this action? The explanation will be sent to the model.",
					"Explain why this action should not run",
					{ signal: ctx.signal, timeout: 120_000 },
				);
			} catch {
				// The user already chose denial; a failed explanation prompt must not allow the tool.
			}
			const reason = explanation?.trim();
			if (reason) return { block: true, reason: `User denied ${risk.category}. User's reason: ${reason}` };
		}
		return { block: true, reason: `User denied ${risk.category}.` };
	});
}
