import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

interface PhaseState {
	startMs: number;
	lastMs: number;
	output: number;
}

// Providers stream real token usage only in the final chunk, so a live rate
// cannot come from `usage.output` (it stays 0 until the stream ends). Phases
// therefore track a running character estimate using the same chars-per-token
// heuristic pi applies to context estimation.
const CHARS_PER_TOKEN = 3.5;
const TPS_STALE_MS = 5000;
// The footer repaints every 500ms, so shorter phases use that window as the
// denominator to avoid spiking on the first few deltas of a phase.
const TPS_MIN_WINDOW_MS = 500;

type StreamingBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
};

/** Estimate thinking and answer tokens from the live partial message content. */
export function estimatePhaseTokens(content: unknown): { thinking: number; output: number } {
	let thinkingChars = 0;
	let outputChars = 0;
	if (Array.isArray(content)) {
		for (const candidate of content as StreamingBlock[]) {
			if (!candidate || typeof candidate !== "object") continue;
			if (candidate.type === "thinking") {
				thinkingChars += candidate.thinking?.length ?? 0;
			} else if (candidate.type === "text") {
				outputChars += candidate.text?.length ?? 0;
			} else if (candidate.type === "toolCall") {
				outputChars += candidate.name?.length ?? 0;
				try {
					outputChars += JSON.stringify(candidate.arguments ?? {}).length;
				} catch {
					// Unserializable partial arguments contribute nothing.
				}
			}
		}
	}
	return { thinking: thinkingChars / CHARS_PER_TOKEN, output: outputChars / CHARS_PER_TOKEN };
}

// Live generation rate for one phase (thinking or output): phase tokens
// divided by the wall-clock span of that phase.
function phaseTps(state: PhaseState | null, now: number): number {
	if (!state || state.output <= 0) return 0;
	if (now - state.lastMs > TPS_STALE_MS) return 0;
	const spanMs = Math.max(state.lastMs - state.startMs, TPS_MIN_WINDOW_MS);
	return state.output / (spanMs / 1000);
}

/**
 * Tracks live thinking and output rates for one streamed assistant message.
 * Thinking blocks precede text and tool calls, so updates arriving before the
 * first non-thinking event belong to the thinking phase.
 */
export class TpsTracker {
	private thinking: PhaseState | null = null;
	private output: PhaseState | null = null;
	private outputStarted = false;
	private averageRate = 0;
	private samples = 0;

	messageStart(now: number): void {
		this.thinking = { startMs: now, lastMs: now, output: 0 };
		this.output = null;
		this.outputStarted = false;
	}

	messageUpdate(kind: string | undefined, content: unknown, now: number): void {
		const isThinking = kind === "thinking_start" || kind === "thinking_delta" || kind === "thinking_end";
		const thinkingActive = isThinking && !this.outputStarted;
		const estimated = estimatePhaseTokens(content);
		if (kind !== undefined && !isThinking) this.outputStarted = true;
		if (thinkingActive) {
			if (!this.thinking) this.thinking = { startMs: now, lastMs: now, output: 0 };
			this.thinking.lastMs = now;
			// Content only grows within a phase, so an `*_end` event that carries
			// no content cannot retract tokens already counted.
			this.thinking.output = Math.max(this.thinking.output, estimated.thinking);
			return;
		}
		// An event without a kind cannot be attributed to thinking, so it is output.
		if (kind === undefined) this.outputStarted = true;
		if (!this.output) this.output = { startMs: now, lastMs: now, output: 0 };
		this.output.lastMs = now;
		this.output.output = Math.max(this.output.output, estimated.output);
	}

	/** A new model request after tool results starts a fresh output phase. */
	turnEnd(now: number): void {
		if (this.outputStarted) this.output = { startMs: now, lastMs: now, output: 0 };
	}

	rates(now: number): { think: number; output: number } {
		return {
			think: this.outputStarted ? 0 : phaseTps(this.thinking, now),
			output: phaseTps(this.output, now),
		};
	}

	/** Fold a finished answer phase into the session average (EWMA). */
	finish(): void {
		const phase = this.output;
		if (!phase || phase.output <= 0) return;
		const spanMs = phase.lastMs - phase.startMs;
		// A fast model finishes a short answer in well under a second, so the gate
		// is on real substance (tokens) rather than on a long enough span.
		if (spanMs < 40 || phase.output < 15) return;
		const rate = phase.output / (spanMs / 1000);
		this.averageRate = this.samples === 0 ? rate : this.averageRate * 0.7 + rate * 0.3;
		this.samples += 1;
	}

	/** Session-average answer rate, 0 until at least one answer has completed. */
	average(): number {
		return this.samples === 0 ? 0 : this.averageRate;
	}
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type SessionStats = {
	usage: UsageTotals;
	compactions: number;
};

function collectSessionStats(ctx: ExtensionContext): SessionStats {
	const usage: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	let compactions = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			compactions += 1;
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message as {
			role?: string;
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
			};
		};
		const messageUsage = message.usage;
		if (!messageUsage) continue;

		usage.input += numberOrZero(messageUsage.input);
		usage.output += numberOrZero(messageUsage.output);
		usage.cacheRead += numberOrZero(messageUsage.cacheRead);
		usage.cacheWrite += numberOrZero(messageUsage.cacheWrite);
		usage.cost += numberOrZero(messageUsage.cost?.total);
	}

	return { usage, compactions };
}

function formatCount(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCost(value: number): string {
	if (value === 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(3)}`;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

type ContextView = "wide" | "medium" | "narrow";

/** Context pressure drives its color, so a filling window announces itself. */
function contextLevel(percent: number): "success" | "warning" | "error" {
	if (percent >= 85) return "error";
	if (percent >= 60) return "warning";
	return "success";
}

/**
 * Small context gauge. The filled cells carry the pressure color; the empty
 * track stays one step darker than body text so a young session reads calm.
 */
function contextBar(percent: number, cells: number, theme: ThemePalette): string {
	const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
	return `${theme.fg(contextLevel(percent), "█".repeat(filled))}${theme.fg("borderMuted", "░".repeat(cells - filled))}`;
}

/**
 * Cache health: the share of prompt tokens that came from the provider cache
 * instead of being sent (and billed) fresh. Judging it needs enough history,
 * so a young session stays neutral rather than alarming.
 */
export function cacheLevel(rate: number, promptTokens: number): "success" | "warning" | "error" | "dim" {
	if (promptTokens < 20_000) return "dim";
	if (rate >= 75) return "success";
	if (promptTokens >= 100_000 && rate < 25) return "error";
	return "warning";
}

export function cacheView(usage: UsageTotals, view: ContextView, theme: ThemePalette): string | undefined {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	const rate = (usage.cacheRead / promptTokens) * 100;
	const level = cacheLevel(rate, promptTokens);
	const label = theme.fg("dim", "cache");
	const percent = theme.fg(level, `${rate.toFixed(0)}%`);
	if (view === "narrow") return `${label} ${percent}`;
	const cells = view === "wide" ? 6 : 4;
	const filled = Math.max(0, Math.min(cells, Math.round((rate / 100) * cells)));
	const bar = `${theme.fg(level, "█".repeat(filled))}${theme.fg("borderMuted", "░".repeat(cells - filled))}`;
	return `${label} ${bar} ${percent}`;
}

function contextView(ctx: ExtensionContext, view: ContextView, theme: ThemePalette): string {
	const label = theme.fg("dim", "ctx");
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.percent === null) return `${label} ${theme.fg("dim", "—")}`;
	const percentText = theme.fg(contextLevel(usage.percent), `${usage.percent.toFixed(0)}%`);
	if (view === "narrow") return `${label} ${percentText}`;
	const bar = contextBar(usage.percent, view === "wide" ? 8 : 5, theme);
	return `${label} ${bar} ${percentText}`;
}

/** Absolute context tokens, kept separate so they yield to the gauge when tight. */
function contextCountsView(ctx: ExtensionContext, theme: ThemePalette): string | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return undefined;
	return theme.fg("dim", `${formatCount(usage.tokens)}/${formatCount(usage.contextWindow)}`);
}

function compactCount(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${Math.round(value / 1_000_000)}m`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export type FooterPart = {
	text: string;
	priority: number;
};

export type FooterLayout = "wide" | "medium" | "narrow";

type ThemePalette = ExtensionContext["ui"]["theme"];

// A dim middot separates segments, so the footer reads as grouped chips rather
// than a run of double-spaced words.
const FOOTER_SEPARATOR = " · ";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const FRAME_WIDTH = 4;
const WIDE_CONTENT_WIDTH = 88;
const MEDIUM_CONTENT_WIDTH = 48;

function footerContentWidth(width: number): number {
	const renderWidth = Math.max(1, width);
	return renderWidth < 8 ? renderWidth : Math.max(1, renderWidth - FRAME_WIDTH);
}

export function footerLayoutForWidth(width: number): FooterLayout {
	const contentWidth = footerContentWidth(width);
	if (contentWidth >= WIDE_CONTENT_WIDTH) return "wide";
	if (contentWidth >= MEDIUM_CONTENT_WIDTH) return "medium";
	return "narrow";
}

function joinFooterParts(parts: readonly FooterPart[], separator = "  "): string {
	return parts
		.filter((part) => visibleWidth(part.text) > 0)
		.map((part) => part.text)
		.join(separator);
}

/** Keep important segments visible by dropping lower-priority segments before truncating. */
export function fitFooterParts(parts: readonly FooterPart[], width: number, separator = "  "): string {
	const available = Math.max(1, Math.floor(width));
	const selected = parts.filter((part) => visibleWidth(part.text) > 0);

	while (selected.length > 1 && visibleWidth(joinFooterParts(selected, separator)) > available) {
		let removeIndex = 0;
		for (let index = 1; index < selected.length; index++) {
			const candidate = selected[index]!;
			const current = selected[removeIndex]!;
			if (
				candidate.priority < current.priority ||
				(candidate.priority === current.priority && index > removeIndex)
			) {
				removeIndex = index;
			}
		}
		selected.splice(removeIndex, 1);
	}

	return truncateToWidth(joinFooterParts(selected, separator), available, "…");
}

function footerParts(...entries: Array<FooterPart | undefined>): FooterPart[] {
	return entries.filter((entry): entry is FooterPart => entry !== undefined);
}

function renderFrame(width: number, content: string, theme: ExtensionContext["ui"]["theme"]): string {
	const renderWidth = Math.max(1, width);
	if (renderWidth < 8) return truncateToWidth(content, renderWidth, "");

	const left = theme.fg("borderMuted", "│ ");
	const right = theme.fg("borderMuted", " │");
	const available = Math.max(1, renderWidth - visibleWidth(left) - visibleWidth(right));
	const body = truncateToWidth(content, available, "…");
	const padding = " ".repeat(Math.max(0, available - visibleWidth(body)));
	return truncateToWidth(`${left}${body}${padding}${right}`, renderWidth, "");
}

function renderFooterLine(width: number, parts: readonly FooterPart[], theme: ThemePalette): string {
	return renderFrame(width, fitFooterParts(parts, footerContentWidth(width), theme.fg("dim", FOOTER_SEPARATOR)), theme);
}

/**
 * One line with a left and a right cluster, so the model identity sits at the
 * far edge and the telemetry row reads as a balanced whole. Both clusters fall
 * back to priority-based packing when they cannot share the line.
 */
function renderAlignedFooterLine(
	width: number,
	left: readonly FooterPart[],
	right: readonly FooterPart[],
	theme: ThemePalette,
): string {
	const contentWidth = footerContentWidth(width);
	const separator = theme.fg("dim", FOOTER_SEPARATOR);
	const leftText = joinFooterParts(left, separator);
	const rightText = joinFooterParts(right, separator);
	const leftWidth = visibleWidth(leftText);
	const rightWidth = visibleWidth(rightText);

	if (leftWidth > 0 && rightWidth > 0 && leftWidth + rightWidth + 2 <= contentWidth) {
		const padding = " ".repeat(contentWidth - leftWidth - rightWidth);
		return renderFrame(width, `${leftText}${padding}${rightText}`, theme);
	}

	return renderFrame(width, fitFooterParts([...left, ...right], contentWidth, separator), theme);
}

export default function footerExtension(pi: ExtensionAPI): void {
	let requestRender = (): void => {};
	let tpsTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerIndex = 0;
	// Wall-clock start of the current agent run, for the elapsed working timer.
	let agentStartedAt = 0;
	// Upstream provider that served the latest router chunk. Routing is decided
	// per request, so this is refreshed as chunks arrive.
	let upstream: { model: string; name: string } | undefined;

	// The tick advances the spinner and keeps the live rate and elapsed timer
	// fresh for as long as the agent is working, including tool execution.
	function startWorkingTick(): void {
		if (tpsTimer) return;
		tpsTimer = setInterval(() => {
			spinnerIndex += 1;
			requestRender();
		}, 500);
	}

	function stopWorkingTick(): void {
		if (tpsTimer) {
			clearInterval(tpsTimer);
			tpsTimer = undefined;
		}
		requestRender();
	}

	const tpsTracker = new TpsTracker();

	const onMessageStart = (event: { message: { role?: string } }) => {
		if (event.message.role !== "assistant") return;
		tpsTracker.messageStart(Date.now());
		startWorkingTick();
	};

	const onMessageUpdate = (event: {
		message: { role?: string; content?: unknown };
		assistantMessageEvent?: { type?: string };
	}) => {
		if (event.message.role !== "assistant") return;
		tpsTracker.messageUpdate(event.assistantMessageEvent?.type, event.message.content, Date.now());
		startWorkingTick();
	};

	const onMessageEnd = (event: { message: { role?: string; stopReason?: string } }) => {
		if (event.message.role !== "assistant") return;
		// Aborted and failed responses are not generation-speed samples.
		if (event.message.stopReason !== "aborted" && event.message.stopReason !== "error") {
			tpsTracker.finish();
		}
		requestRender();
	};

	// OpenRouter tags every stream chunk with the upstream provider that served
	// it (for example "Morph"), which the model string alone cannot tell you.
	const onProviderStreamEvent = (event: { provider?: string; model?: string; data?: unknown }) => {
		if (event.provider !== "openrouter") return;
		const data = event.data as { provider?: unknown } | undefined;
		const name = data && typeof data === "object" ? data.provider : undefined;
		if (typeof name !== "string" || name.length === 0) return;
		const chunkModel = event.model ?? "";
		if (upstream?.name === name && upstream.model === chunkModel) return;
		upstream = { model: chunkModel, name };
		requestRender();
	};

	pi.on("message_start", onMessageStart);
	pi.on("message_update", onMessageUpdate);
	pi.on("message_end", onMessageEnd);
	pi.on("provider_stream_event", onProviderStreamEvent);
	pi.on("agent_start", () => {
		agentStartedAt = Date.now();
		startWorkingTick();
		requestRender();
	});
	pi.on("agent_end", stopWorkingTick);
	pi.on("agent_settled", stopWorkingTick);
	pi.on("turn_end", () => {
		tpsTracker.turnEnd(Date.now());
		requestRender();
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n[FOOTER CAPABILITY] A compact UI footer is active and already shows the user model, thinking level, session id, git branch, project trust, queued-message state, context gauge, token and cache totals, cost, compaction count, tool count, live thinking/output speed, session-average speed, and (on OpenRouter) the upstream provider that served the last request. It requires no model action, and the user never needs to ask for this information.`,
	}));

	function refresh(): void {
		requestRender();
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(requestRender);

			return {
				render(width: number): string[] {
					const { usage, compactions } = collectSessionStats(ctx);
					const branch = footerData.getGitBranch();
					const sessionName = pi.getSessionName();
					const activeTools = pi.getActiveTools().length;
					const allTools = pi.getAllTools().length;
					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
					const modelId = ctx.model?.id ?? "no model";
					const thinkingLevel = ctx.thinkingLevel ?? pi.getThinkingLevel();
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([, text]) => sanitizeStatusText(text))
						.filter(Boolean)
						.slice(0, 3);
					const working = !ctx.isIdle();
					const now = Date.now();
					const sessionId = ctx.sessionManager.getSessionId();
					const queued = ctx.hasPendingMessages();
					const untrusted = !ctx.isProjectTrusted();
					const elapsed = working && agentStartedAt > 0 ? Math.floor((now - agentStartedAt) / 1000) : 0;
					// Only trust a remembered provider when it belongs to the active model.
					const upstreamName = upstream && upstream.model === ctx.model?.id ? upstream.name : undefined;
					const rates = tpsTracker.rates(now);
					const averageRate = tpsTracker.average();
					const tpsText =
						rates.think > 0
							? `think ${Math.round(rates.think)} t/s`
							: rates.output > 0
								? `out ${Math.round(rates.output)} t/s`
								: undefined;
					// The live rate is transient, so on cramped narrow lines it outranks the
					// cumulative cost and cache readouts that are still there when idle.
					const tpsPart: FooterPart | undefined =
						working && tpsText ? { text: theme.fg("mdCode", tpsText), priority: 98 } : undefined;
					// Session-speed summary, so the line still says something useful when idle.
					const averagePart: FooterPart | undefined =
						!working && averageRate > 0
							? {
									text: `${theme.fg("dim", "avg")} ${theme.fg("mdCode", `${Math.round(averageRate)} t/s`)}`,
									priority: 52,
								}
							: undefined;

					const project = formatPath(ctx.cwd);
					const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]!;
					const brandPart: FooterPart = {
						text: theme.fg("accent", theme.bold("✦ pi")),
						priority: 100,
					};
					const sessionPart: FooterPart | undefined = sessionName
						? { text: `${theme.fg("mdListBullet", "◦")} ${theme.fg("text", sessionName)}`, priority: 35 }
						: undefined;
					const projectPart: FooterPart = { text: theme.fg("muted", project), priority: 70 };
					const branchPart: FooterPart | undefined = branch
						? { text: theme.fg("mdLink", `⎇ ${branch}`), priority: 85 }
						: undefined;
					const workingPart: FooterPart | undefined = working
						? {
								text: `${theme.fg("warning", spinner)} ${theme.fg("warning", "working")}${elapsed >= 1 ? theme.fg("dim", ` ${formatDuration(elapsed)}`) : ""}`,
								priority: 90,
							}
						: undefined;
					const untrustedPart: FooterPart | undefined = untrusted
						? { text: `${theme.fg("warning", "⚠")} ${theme.fg("warning", "untrusted")}`, priority: 96 }
						: undefined;
					const queuedPart: FooterPart | undefined = queued
						? { text: `${theme.fg("accent", "⏳")} ${theme.fg("muted", "queued")}`, priority: 88 }
						: undefined;
					const narrowBranchPart: FooterPart | undefined = branch
						? {
								text: theme.fg(
									"mdLink",
									truncateToWidth(
										`⎇ ${branch}`,
										Math.max(1, footerContentWidth(width) - visibleWidth(brandPart.text) - 2),
										"…",
									),
								),
								priority: 95,
							}
						: undefined;
					const statusParts = statuses.map((text, index): FooterPart => ({
						text,
						priority: 10 - index,
					}));

					const tokenCounts = (input: string, output: string): string =>
						`${theme.fg("dim", "↑")}${theme.fg("muted", input)} ${theme.fg("dim", "↓")}${theme.fg("muted", output)}`;
					const usagePart: FooterPart = {
						text: tokenCounts(formatCount(usage.input), formatCount(usage.output)),
						priority: 100,
					};
					const compactUsagePart: FooterPart = {
						text: tokenCounts(compactCount(usage.input), compactCount(usage.output)),
						priority: 100,
					};
					const cachePart: FooterPart | undefined = (() => {
						const text = cacheView(usage, "wide", theme);
						return text ? { text, priority: 62 } : undefined;
					})();
					const mediumCachePart: FooterPart | undefined = (() => {
						const text = cacheView(usage, "medium", theme);
						return text ? { text, priority: 62 } : undefined;
					})();
					const compactCachePart: FooterPart | undefined = (() => {
						const text = cacheView(usage, "narrow", theme);
						return text ? { text, priority: 62 } : undefined;
					})();
					// Providers that do not charge for cache writes report 0, so the read
					// volume carries the detail and the write count appears only when real.
					const cacheVolume = usage.cacheRead + usage.cacheWrite;
					const cacheDetailPart: FooterPart | undefined =
						cacheVolume > 0
							? {
									text: `${theme.fg("dim", "R")}${theme.fg("muted", compactCount(usage.cacheRead))}${usage.cacheWrite > 0 ? ` ${theme.fg("dim", "W")}${theme.fg("muted", compactCount(usage.cacheWrite))}` : ""}`,
									priority: 45,
								}
							: undefined;
					const costPart: FooterPart = {
						text: theme.fg("success", formatCost(usage.cost)),
						priority: 55,
					};
					const wideContextPart: FooterPart = {
						text: contextView(ctx, "wide", theme),
						priority: 95,
					};
					const mediumContextPart: FooterPart = {
						text: contextView(ctx, "medium", theme),
						priority: 95,
					};
					const compactContextPart: FooterPart = {
						text: contextView(ctx, "narrow", theme),
						priority: 95,
					};
					const contextCountsText = contextCountsView(ctx, theme);
					const contextCountsPart: FooterPart | undefined = contextCountsText
						? { text: contextCountsText, priority: 50 }
						: undefined;
					const toolsPart: FooterPart = {
						text: `${theme.fg("dim", "tools")} ${theme.fg("muted", `${activeTools}/${allTools}`)}`,
						priority: 30,
					};
					const upstreamSuffix = upstreamName
						? ` ${theme.fg("dim", "via")} ${theme.fg("mdListBullet", upstreamName)}`
						: "";
					// Knowing the upstream provider is more useful than repeating the router,
					// so routing detail replaces the "provider/" prefix when it is known.
					// With routing detail present, the vendor prefix is redundant (`deepseek/
					// deepseek-v4.1-flash`), so only the model itself is shown.
					const routedLabel = ctx.model?.id.split("/").pop() ?? modelId;
					const modelPart: FooterPart = {
						text: `${theme.fg("text", theme.bold(upstreamName ? routedLabel : model))}${upstreamSuffix}`,
						priority: 90,
					};
					const compactModelPart: FooterPart = {
						text: `${theme.fg("text", upstreamName ? routedLabel : modelId)}${upstreamSuffix}`,
						priority: 100,
					};
					const compactionPart: FooterPart | undefined =
						compactions > 0
							? {
									text: `${theme.fg("dim", "compact")} ${theme.fg("muted", `×${compactions}`)}`,
									priority: 25,
								}
							: undefined;
					const sessionIdPart: FooterPart | undefined = sessionId
						? { text: theme.fg("dim", `#${sessionId.slice(0, 8)}`), priority: 22 }
						: undefined;
					const thinkingPart: FooterPart = {
						text: `${theme.fg("dim", "◇")} ${theme.fg("accent", thinkingLevel)}`,
						priority: 65,
					};

					const layout = footerLayoutForWidth(width);
					if (layout === "wide") {
						return [
							renderFooterLine(
								width,
								footerParts(
									brandPart,
									untrustedPart,
									sessionPart,
									projectPart,
									branchPart,
									queuedPart,
									workingPart,
									...statusParts,
								),
								theme,
							),
							renderAlignedFooterLine(
								width,
								footerParts(
									usagePart,
									tpsPart,
									averagePart,
									cachePart,
									cacheDetailPart,
									costPart,
									contextCountsPart,
									wideContextPart,
									toolsPart,
									compactionPart,
									sessionIdPart,
								),
								footerParts(modelPart, thinkingPart),
								theme,
							),
						];
					}

					if (layout === "medium") {
						return [
							renderFooterLine(
								width,
								footerParts(
									brandPart,
									untrustedPart,
									sessionPart,
									projectPart,
									branchPart,
									queuedPart,
									workingPart,
									...statusParts,
								),
								theme,
							),
							renderFooterLine(
								width,
								footerParts(
									compactUsagePart,
									tpsPart,
									averagePart,
									costPart,
									mediumCachePart,
									cacheDetailPart,
									contextCountsPart,
									mediumContextPart,
									compactModelPart,
									thinkingPart,
									toolsPart,
									compactionPart,
									sessionIdPart,
								),
								theme,
							),
						];
					}

					const narrowIdentity =
						footerContentWidth(width) < 28
							? footerParts(brandPart, workingPart ?? narrowBranchPart)
							: footerParts(brandPart, narrowBranchPart, workingPart, projectPart);

					return [
						renderFooterLine(width, narrowIdentity, theme),
						renderFooterLine(
							width,
							footerParts(compactUsagePart, tpsPart, averagePart, costPart, compactCachePart, compactContextPart),
							theme,
						),
						renderFooterLine(
							width,
							footerParts(compactModelPart, thinkingPart, toolsPart, compactionPart, sessionIdPart, ...statusParts),
							theme,
						),
					];
				},
				invalidate() {},
				dispose: unsubscribe,
			};
		});

		refresh();
	});

	pi.on("session_info_changed", refresh);
	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("tool_execution_start", refresh);
	pi.on("tool_execution_end", refresh);

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWorkingTick();
		ctx.ui.setFooter(undefined);
		requestRender = () => {};
	});
}
