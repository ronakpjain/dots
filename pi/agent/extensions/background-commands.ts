import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkCommitCommand } from "./commit-message.ts";
import { formatSeconds, MAX_TIMER_SECONDS } from "./named-timers.ts";

const MAX_JOBS = 8;
// Pass the path and command as separate arguments; do not interpolate them into the wrapper.
const LOG_WRAPPER = 'exec > "$1" 2>&1 || exit 1; exec bash -c "$2"';

export default function backgroundCommands(pi: ExtensionAPI): void {
	const jobs = new Map<string, { controller: AbortController; startedAt: number }>();

	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) job.controller.abort();
		jobs.clear();
	});

	pi.registerCommand("jobs", {
		description: "List background commands or cancel one with /jobs cancel <name|all>",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				const lines = [...jobs].map(([name, job]) =>
					`${name}: ${job.controller.signal.aborted ? "cancelling" : "running"} (${formatSeconds((Date.now() - job.startedAt) / 1000)})`,
				);
				ctx.ui.notify(lines.join("\n") || "No active background commands.", "info");
				return;
			}
			const match = /^cancel\s+(\S+)$/.exec(input);
			if (!match) {
				ctx.ui.notify("Usage: /jobs [cancel <name|all>]", "warning");
				return;
			}
			const target = match[1];
			const selected = [...jobs].filter(([name]) => target === "all" || target === name);
			for (const [, job] of selected) job.controller.abort();
			ctx.ui.notify(selected.length ? `Cancellation requested for ${selected.length} job(s).` : "No matching jobs.", "info");
		},
	});

	pi.registerTool({
		name: "background_command",
		label: "Background Command",
		description: "Run a named, non-interactive bash command in the current working directory and return immediately. When it exits, Pi asserts a completion message with the exit status and a temporary log path containing full combined stdout and stderr, waking the assistant if idle. Use this for long-running tests, builds, and other finite tasks instead of polling. Do not detach the command or launch an interactive program.",
		parameters: Type.Object({
			name: Type.String({ description: "Unique job name using letters, digits, dots, underscores, or hyphens", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$" }),
			command: Type.String({ description: "Shell command to run", minLength: 1 }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 3600)", minimum: 1, maximum: MAX_TIMER_SECONDS })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const { name, command, timeout = 3600 } = params;
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: { started: false }, isError: true });
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || name === "all") return fail("Invalid job name (\"all\" is reserved).");
			if (!command.trim()) return fail("Command must not be empty.");
			if (!Number.isFinite(timeout) || timeout < 1 || timeout > MAX_TIMER_SECONDS) return fail("Invalid job timeout.");
			const violation = checkCommitCommand(command, ctx.cwd);
			if (violation) return fail(violation);
			if (jobs.has(name)) return fail(`Job "${name}" is already active.`);
			if (jobs.size >= MAX_JOBS) return fail(`Too many active jobs (${MAX_JOBS}). See /jobs.`);

			let logPath: string;
			try {
				logPath = join(mkdtempSync(join(tmpdir(), "pi-background-")), "output.log");
				writeFileSync(logPath, "", { flag: "wx", mode: 0o600 });
			} catch (error) {
				return fail(`Could not create a temporary job log: ${String(error)}`);
			}

			const job = { controller: new AbortController(), startedAt: Date.now() };
			jobs.set(name, job);
			const { signal } = job.controller;
			void (async () => {
				let result: string;
				try {
					const { code, killed } = await pi.exec("bash", ["-c", LOG_WRAPPER, "pi-background", logPath, command], {
						cwd: ctx.cwd, signal, timeout: timeout * 1000,
					});
					const status = signal.aborted ? "was cancelled" : killed ? "timed out" : "finished";
					result = `${status} (exit ${code}).`;
				} catch (error) {
					result = signal.aborted ? "was cancelled." : `could not run: ${String(error)}`;
				}
				if (jobs.get(name) !== job) return; // Session shut down before completion.
				jobs.delete(name);
				const content = `Background job "${name}" ${result}\nCombined stdout/stderr log: ${logPath}`;
				try {
					pi.sendMessage({ customType: "background-command", content, display: true }, { triggerTurn: true, deliverAs: "steer" });
				} catch {
					ctx.ui.notify(content, "warning");
				}
			})();
			return {
				content: [{ type: "text" as const, text: `Started background job "${name}". Pi will assert completion; no polling is needed.\nCombined stdout/stderr log: ${logPath}` }],
				details: { started: true, name, logPath },
			};
		},
	});
}
