import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tokenizeShell } from "./commit-message.ts";

/** Blocking sleeps at or below this many seconds are allowed for polling and pacing. */
export const INLINE_SLEEP_LIMIT_SECONDS = 1;
export const MIN_TIMER_SECONDS = 0.1;
export const MAX_TIMER_SECONDS = 24 * 60 * 60;
const MAX_ACTIVE_TIMERS = 16;
const MAX_TIMER_NAME = 64;
const TIMER_STATUS_KEY = "named-timers";
const TIMER_MESSAGE_TYPE = "named-timer";

type ActiveTimer = {
	name: string;
	seconds: number;
	startedAt: number;
	dueAt: number;
	handle: ReturnType<typeof setTimeout>;
};

type ParsedSleep = {
	/** Text of the sleep invocation, for the block reason. */
	text: string;
	/** Total requested seconds, or undefined when the duration is dynamic or unsupported. */
	seconds: number | undefined;
};

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
const DURATION_PART = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?/i;

const PREFIX_WORDS = new Set([
	"sudo",
	"doas",
	"command",
	"exec",
	"nohup",
	"time",
	"builtin",
	"env",
	"then",
	"do",
	"else",
	"elif",
	"if",
	"while",
	"until",
	"!",
]);

const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"]);

export function formatSeconds(seconds: number): string {
	if (!Number.isFinite(seconds)) return "unknown";
	if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
	if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
	const total = Math.round(seconds);
	const minutes = Math.floor(total / 60);
	const remainder = total % 60;
	if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Parse `sleep` operands (5, 0.5, 1m, 1m30s, ...) into total seconds. */
export function parseSleepSeconds(args: readonly string[]): number | undefined {
	if (args.length === 0) return undefined;
	let total = 0;
	for (const arg of args) {
		if (!arg || arg.startsWith("-")) return undefined;
		let rest = arg;
		let matched = false;
		while (rest.length > 0) {
			const part = DURATION_PART.exec(rest);
			if (!part) return undefined;
			const value = Number(part[1]);
			if (!Number.isFinite(value)) return undefined;
			total += value * UNIT_SECONDS[(part[2] ?? "s").toLowerCase()];
			rest = rest.slice(part[0].length);
			matched = true;
		}
		if (!matched) return undefined;
	}
	return total;
}

function baseName(word: string): string {
	const segments = word.split("/");
	return segments[segments.length - 1] ?? word;
}

function isAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** Find sleep invocations whose duration is unknown or above the inline limit. */
export function findBlockingSleeps(command: string, limit = INLINE_SLEEP_LIMIT_SECONDS): ParsedSleep[] {
	const blocking: ParsedSleep[] = [];

	const scan = (text: string, depth: number): void => {
		if (depth > 3) return;
		const tokens = tokenizeShell(text);
		let expectCommand = true;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token.operator) {
				expectCommand = true;
				continue;
			}

			// The shell tokenizer keeps a subshell's opening parenthesis in the word.
			const word = token.value.replace(/^[({]+/, "");
			if (!expectCommand || !word) continue;
			if (PREFIX_WORDS.has(word) || isAssignment(word) || word.startsWith("-")) continue;

			const base = baseName(word);
			if (base === "sleep") {
				const args: string[] = [];
				let j = i + 1;
				while (j < tokens.length && !tokens[j].operator) {
					args.push(tokens[j].value);
					j++;
				}
				const informational = args.some((arg) => arg === "--help" || arg === "--version");
				// Bare `sleep` fails immediately; only operands can produce a real wait.
				const seconds = args.length === 0 ? 0 : parseSleepSeconds(args.map((arg) => arg.replace(/[)}]+$/, "")));
				if (args.length > 0 && !informational && (seconds === undefined || seconds > limit)) {
					blocking.push({ text: [word, ...args].join(" "), seconds });
				}
				expectCommand = false;
				i = j - 1;
				continue;
			}

			if (SHELL_NAMES.has(base) || base === "eval") {
				const args: string[] = [];
				let j = i + 1;
				while (j < tokens.length && !tokens[j].operator) {
					args.push(tokens[j].value);
					j++;
				}
				if (base === "eval") {
					if (args.length > 0) scan(args.join(" "), depth + 1);
				} else {
					const commandFlag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
					const payload = commandFlag >= 0 ? args[commandFlag + 1] : undefined;
					if (payload !== undefined) scan(payload, depth + 1);
				}
				expectCommand = false;
				i = j - 1;
				continue;
			}

			expectCommand = false;
		}
	};

	scan(command, 0);
	return blocking;
}

/** Return a block reason when a bash command contains a long blocking sleep. */
export function sleepBlockReason(command: string, limit = INLINE_SLEEP_LIMIT_SECONDS): string | undefined {
	const blocking = findBlockingSleeps(command, limit);
	if (blocking.length === 0) return undefined;

	const first = blocking[0];
	const detail =
		first.seconds === undefined
			? `\`${first.text}\` has a dynamic or unsupported duration`
			: `\`${first.text}\` would block for ${formatSeconds(first.seconds)}`;
	const suggested = Math.max(MIN_TIMER_SECONDS, Math.ceil(first.seconds ?? limit * 10));

	return `Blocked: ${detail}; the inline sleep limit is ${formatSeconds(limit)}. Start a named timer instead: timer(name="server-boot", seconds=${suggested}). It returns immediately and asserts a completion message so you can inspect logs or state then. Short polling sleeps of ${formatSeconds(limit)} or less are allowed.`;
}

function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function namedTimersExtension(pi: ExtensionAPI): void {
	const timers = new Map<string, ActiveTimer>();
	let ui: ExtensionContext["ui"] | undefined;

	const refreshStatus = (): void => {
		if (!ui) return;
		try {
			if (timers.size === 0) {
				ui.setStatus(TIMER_STATUS_KEY, undefined);
				return;
			}
			const label = timers.size === 1 ? [...timers.keys()][0] : `${timers.size} timers`;
			ui.setStatus(TIMER_STATUS_KEY, `⏱ ${label}`);
		} catch {
			// UI may be gone after reload or session replacement.
		}
	};

	const clearTimers = (): void => {
		for (const timer of timers.values()) clearTimeout(timer.handle);
		timers.clear();
		refreshStatus();
	};

	const fire = (timer: ActiveTimer): void => {
		if (timers.get(timer.name) !== timer) return;
		timers.delete(timer.name);
		refreshStatus();

		const elapsed = Math.max(0, (Date.now() - timer.startedAt) / 1000);
		const content = `Timer "${timer.name}" asserted completion after ${formatSeconds(elapsed)}. Check the logs, output, or state now. Do not block bash with sleep; start another timer if you need to wait longer.`;
		try {
			pi.sendMessage(
				{
					customType: TIMER_MESSAGE_TYPE,
					content,
					display: true,
					details: {
						name: timer.name,
						seconds: timer.seconds,
						startedAt: timer.startedAt,
						dueAt: timer.dueAt,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch {
			try {
				ui?.notify(content, "info");
			} catch {
				// Nothing left to notify through.
			}
		}
	};

	const errorResult = (text: string) => ({
		content: [{ type: "text" as const, text }],
		details: { started: false },
		isError: true,
	});

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		refreshStatus();
	});

	pi.on("session_shutdown", () => {
		clearTimers();
		ui = undefined;
	});

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const reason = sleepBlockReason(event.input.command);
		if (reason) return { block: true, reason };
	});

	pi.registerCommand("timers", {
		description: "List active named timers or cancel one with /timers cancel <name|all>",
		handler: async (args, ctx) => {
			ui = ctx.ui;
			const trimmed = args.trim();
			if (trimmed) {
				const [action, ...rest] = trimmed.split(/\s+/);
				if (action === "cancel") {
					const target = rest.join(" ").trim();
					if (!target) {
						ctx.ui.notify("Usage: /timers cancel <name|all>", "warning");
						return;
					}
					if (target === "all") {
						const count = timers.size;
						clearTimers();
						ctx.ui.notify(
							count === 0 ? "No active timers." : `Cancelled ${count} timer${count === 1 ? "" : "s"}.`,
							"info",
						);
						return;
					}
					const timer = timers.get(target);
					if (!timer) {
						ctx.ui.notify(`No active timer named "${target}".`, "warning");
						return;
					}
					clearTimeout(timer.handle);
					timers.delete(target);
					refreshStatus();
					ctx.ui.notify(`Cancelled timer "${target}".`, "info");
					return;
				}
			}

			if (timers.size === 0) {
				ctx.ui.notify("No active timers.", "info");
				return;
			}
			const now = Date.now();
			const lines = [...timers.values()]
				.sort((a, b) => a.dueAt - b.dueAt)
				.map((timer) => {
					const remaining = Math.max(0, (timer.dueAt - now) / 1000);
					return `"${timer.name}": ${formatSeconds(remaining)} left of ${formatSeconds(timer.seconds)} (done ${formatClock(timer.dueAt)})`;
				});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerTool({
		name: "timer",
		label: "Named Timer",
		description:
			"Start a named, non-blocking timer that returns immediately. When the duration elapses, the timer asserts a completion message into the conversation (waking you if idle) so you can inspect logs, output, or state yourself. Use this instead of long sleeps in bash commands.",
		promptSnippet: "Start a named non-blocking timer that asserts completion later",
		promptGuidelines: [
			"Do not run bash sleeps longer than 1 second. Start a named timer with timer, end the turn, and inspect logs or state when its completion message arrives.",
			"Give timer a descriptive name such as server-boot or migration-finish, plus a seconds duration.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Unique descriptive timer name, e.g. server-boot" }),
			seconds: Type.Number({
				description: "Duration in seconds; the timer asserts completion when it elapses",
				minimum: MIN_TIMER_SECONDS,
				maximum: MAX_TIMER_SECONDS,
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = params.name.trim();
			if (!name) return errorResult("Timer name must not be empty.");
			if (name.length > MAX_TIMER_NAME) {
				return errorResult(`Timer names must be ${MAX_TIMER_NAME} characters or fewer.`);
			}
			if (
				!Number.isFinite(params.seconds) ||
				params.seconds < MIN_TIMER_SECONDS ||
				params.seconds > MAX_TIMER_SECONDS
			) {
				return errorResult(
					`Timer duration must be between ${formatSeconds(MIN_TIMER_SECONDS)} and ${formatSeconds(MAX_TIMER_SECONDS)}.`,
				);
			}

			const existing = timers.get(name);
			if (existing) {
				const remaining = Math.max(0, (existing.dueAt - Date.now()) / 1000);
				return errorResult(
					`Timer "${name}" is already active with ${formatSeconds(remaining)} left. Use a unique name.`,
				);
			}
			if (timers.size >= MAX_ACTIVE_TIMERS) {
				return errorResult(
					`Too many active timers (${MAX_ACTIVE_TIMERS}). Cancel one with /timers cancel <name>.`,
				);
			}

			const startedAt = Date.now();
			const dueAt = startedAt + params.seconds * 1000;
			const timer: ActiveTimer = {
				name,
				seconds: params.seconds,
				startedAt,
				dueAt,
				handle: setTimeout(() => fire(timer), params.seconds * 1000),
			};

			timers.set(name, timer);
			ui = ctx.ui;
			refreshStatus();

			return {
				content: [
					{
						type: "text" as const,
						text: `Timer "${name}" started for ${formatSeconds(params.seconds)} (done ${formatClock(dueAt)}). It returns immediately; end the turn and inspect logs or state when the completion message arrives.`,
					},
				],
				details: { started: true, name, seconds: params.seconds, dueAt },
			};
		},
	});
}
