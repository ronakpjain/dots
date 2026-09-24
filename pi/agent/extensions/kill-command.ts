import {
	createBashToolDefinition,
	highlightCode,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Box, Container, Text } from "@earendil-works/pi-tui";
import { sanitizeToolOutput } from "./tool-results/format.ts";
import { renderToolResult } from "./tool-results/render.ts";

export const KILL_COMMAND_SHORTCUT = "ctrl+alt+k" as const;
export const KILL_COMMAND_NAME = "kill-command" as const;
const KILL_COMMAND_STATUS = "kill-command";

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

export type RunningCommand = {
	id: string;
	command: string;
	controller: AbortController;
};

/** Track command-local cancellation without touching the agent's abort controller. */
export class RunningCommandRegistry {
	private readonly commands = new Map<string, RunningCommand>();

	constructor(private readonly onChange?: (count: number) => void) {}

	get size(): number {
		return this.commands.size;
	}

	start(id: string, command: string): RunningCommand {
		this.commands.get(id)?.controller.abort();
		const running: RunningCommand = { id, command, controller: new AbortController() };
		this.commands.set(id, running);
		this.onChange?.(this.commands.size);
		return running;
	}

	finish(running: RunningCommand): void {
		if (this.commands.get(running.id) !== running) return;
		this.commands.delete(running.id);
		this.onChange?.(this.commands.size);
	}

	killAll(): RunningCommand[] {
		const running = [...this.commands.values()];
		for (const command of running) command.controller.abort();
		return running;
	}

	clear(): void {
		if (this.commands.size === 0) return;
		this.commands.clear();
		this.onChange?.(0);
	}
}

export type LinkedAbortSignal = {
	signal: AbortSignal;
	dispose: () => void;
};

/** Combine the agent signal with a command-local signal and clean up listeners afterward. */
export function linkAbortSignals(...signals: (AbortSignal | undefined)[]): LinkedAbortSignal {
	const controller = new AbortController();
	const subscribed: AbortSignal[] = [];
	const abort = (): void => controller.abort();

	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) {
			controller.abort();
			break;
		}
		signal.addEventListener("abort", abort, { once: true });
		subscribed.push(signal);
	}

	return {
		signal: controller.signal,
		dispose: () => {
			for (const signal of subscribed) signal.removeEventListener("abort", abort);
		},
	};
}

export default function killCommandExtension(pi: ExtensionAPI): void {
	let statusContext: ExtensionContext | undefined;
	const commandRegistry = new RunningCommandRegistry((count) => {
		if (!statusContext) return;
		statusContext.ui.setStatus(
			KILL_COMMAND_STATUS,
			count > 0 ? `kill: Ctrl+C / Ctrl+Alt+K · ${count} running` : undefined,
		);
	});
	const notifyKill = (ctx: ExtensionContext): void => {
		const count = commandRegistry.killAll().length;
		if (count === 0) {
			ctx.ui.notify("No shell commands are running.", "info");
			return;
		}
		const noun = count === 1 ? "command" : "commands";
		ctx.ui.notify(`Killed ${count} shell ${noun}; the agent will continue.`, "info");
	};
	let removeTerminalInputListener: (() => void) | undefined;

	pi.registerCommand(KILL_COMMAND_NAME, {
		description: "Kill running shell commands without aborting the agent",
		handler: async (_args, ctx) => notifyKill(ctx),
	});

	pi.registerShortcut(KILL_COMMAND_SHORTCUT, {
		description: "Kill running shell commands without aborting the agent",
		handler: (ctx) => notifyKill(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		statusContext = ctx;
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;

		// Ctrl+C keeps its normal clear/exit behavior while idle, but becomes a
		// command-only kill switch while a shell tool is actually running.
		if (ctx.mode === "tui") {
			removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
				if (!matchesKey(data, "ctrl+c") || commandRegistry.size === 0) return;
				notifyKill(ctx);
				return { consume: true };
			});
		}

		if (!pi.getActiveTools().includes("bash")) return;

		const bashTool = createBashToolDefinition(ctx.cwd);
		pi.registerTool({
			...bashTool,
			renderShell: "self",
			renderCall(args, theme, context) {
				if (context.executionStarted && context.state.startedAt === undefined) {
					context.state.startedAt = Date.now();
					context.state.endedAt = undefined;
				}
				const rawCommand = sanitizeToolOutput(typeof args.command === "string" ? args.command : "");
				const command = rawCommand.slice(0, 4_000);
				const highlighted = highlightCode(command || "...", "bash").join("\n");
				const truncated = rawCommand.length > command.length ? "…" : "";
				const timeout = typeof args.timeout === "number" && args.timeout > 0
					? theme.fg("muted", ` (timeout ${args.timeout}s)`)
					: "";
				const background = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
				const box = new Box(0, 0, (text) => theme.bg(background, text));
				box.addChild(new Text(theme.fg("toolTitle", theme.bold("$ ")) + highlighted + truncated + timeout, 0, 0));
				return box;
			},
			renderResult(result, options, theme, context) {
				const state = context.state;
				if (state.startedAt !== undefined && options.isPartial && !state.interval) {
					state.interval = setInterval(() => context.invalidate(), 1_000);
				}
				if (!options.isPartial || context.isError) {
					state.endedAt ??= Date.now();
					if (state.interval) {
						clearInterval(state.interval);
						state.interval = undefined;
					}
				}
				const container = new Container();
				container.addChild(
					renderToolResult("bash", result, options, theme, context, {
						collapsedSummary: () => (context.isError ? "Command failed" : "Command completed"),
					}),
				);
				if (state.startedAt !== undefined) {
					const endTime = state.endedAt ?? Date.now();
					const label = options.isPartial ? "Elapsed" : "Took";
					container.addChild(new Text(theme.fg("muted", `${label} ${formatDuration(endTime - state.startedAt)}`), 0, 0));
				}
				const background = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
				const box = new Box(0, 0, (text) => theme.bg(background, text));
				box.addChild(container);
				return box;
			},
			async execute(toolCallId, params, signal, onUpdate, toolCtx) {
				const running = commandRegistry.start(toolCallId, params.command);
				const linked = linkAbortSignals(signal, running.controller.signal);
				try {
					return await bashTool.execute(toolCallId, params, linked.signal, onUpdate, toolCtx);
				} catch (error) {
					if (running.controller.signal.aborted && !signal?.aborted && error instanceof Error) {
						const message = error.message.replace(/Command aborted$/u, "Command killed by user");
						if (message !== error.message) throw new Error(message);
					}
					throw error;
				} finally {
					linked.dispose();
					commandRegistry.finish(running);
				}
			},
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		commandRegistry.killAll();
		commandRegistry.clear();
		statusContext = undefined;
		ctx.ui.setStatus(KILL_COMMAND_STATUS, undefined);
	});
}
