import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type UsageTotals = {
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
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function collectUsage(ctx: ExtensionContext): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};

	for (const entry of ctx.sessionManager.getBranch()) {
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
		const usage = message.usage;
		if (!usage) continue;

		totals.input += numberOrZero(usage.input);
		totals.output += numberOrZero(usage.output);
		totals.cacheRead += numberOrZero(usage.cacheRead);
		totals.cacheWrite += numberOrZero(usage.cacheWrite);
		totals.cost += numberOrZero(usage.cost?.total);
	}

	return totals;
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

function formatPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

function contextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return "ctx —";
	const percent = usage.percent === null ? "—" : `${usage.percent.toFixed(0)}%`;
	return `ctx ${formatCount(usage.tokens)}/${formatCount(usage.contextWindow)} ${percent}`;
}

function compactContextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return "ctx —";
	const percent = usage.percent === null ? "—" : `${usage.percent.toFixed(0)}%`;
	return `ctx ${percent}`;
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

function joinFooterParts(parts: readonly FooterPart[]): string {
	return parts
		.filter((part) => visibleWidth(part.text) > 0)
		.map((part) => part.text)
		.join("  ");
}

/** Keep important segments visible by dropping lower-priority segments before truncating. */
export function fitFooterParts(parts: readonly FooterPart[], width: number): string {
	const available = Math.max(1, Math.floor(width));
	const selected = parts.filter((part) => visibleWidth(part.text) > 0);

	while (selected.length > 1 && visibleWidth(joinFooterParts(selected)) > available) {
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

	return truncateToWidth(joinFooterParts(selected), available, "…");
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

function renderFooterLine(width: number, parts: readonly FooterPart[], theme: ExtensionContext["ui"]["theme"]): string {
	return renderFrame(width, fitFooterParts(parts, footerContentWidth(width)), theme);
}

export default function footerExtension(pi: ExtensionAPI): void {
	let requestRender = (): void => {};
	let tpsTimer: ReturnType<typeof setInterval> | undefined;

	// Track the live generation window from stream events. Thinking, text, and
	// tool-call updates all extend the window; message_end settles it.
	function startTpsTick(): void {
		if (tpsTimer) return;
		tpsTimer = setInterval(requestRender, 500);
	}

	const tpsTracker = new TpsTracker();

	const onMessageStart = (event: { message: { role?: string } }) => {
		if (event.message.role !== "assistant") return;
		tpsTracker.messageStart(Date.now());
		startTpsTick();
	};

	const onMessageUpdate = (event: {
		message: { role?: string; content?: unknown };
		assistantMessageEvent?: { type?: string };
	}) => {
		if (event.message.role !== "assistant") return;
		tpsTracker.messageUpdate(event.assistantMessageEvent?.type, event.message.content, Date.now());
		startTpsTick();
	};

	const onStreamingEnd = () => {
		if (tpsTimer) {
			clearInterval(tpsTimer);
			tpsTimer = undefined;
		}
		requestRender();
	};

	pi.on("message_start", onMessageStart);
	pi.on("message_update", onMessageUpdate);
	pi.on("message_end", onStreamingEnd);
	pi.on("agent_end", onStreamingEnd);
	pi.on("turn_end", () => {
		tpsTracker.turnEnd(Date.now());
		onStreamingEnd();
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n[FOOTER CAPABILITY] A compact UI footer is active and displays model, context, usage, cost, branch, tool, and extension-status information. It requires no model action.`,
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
					const usage = collectUsage(ctx);
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
						.slice(0, 2);
					const working = !ctx.isIdle();
					const rates = tpsTracker.rates(Date.now());
					const tpsText =
						rates.think > 0
							? `think ${Math.round(rates.think)} t/s`
							: rates.output > 0
								? `out ${Math.round(rates.output)} t/s`
								: undefined;
					// The live rate is transient, so on cramped narrow lines it outranks the
					// cumulative cost and cache readouts that are still there when idle.
					const tpsPart: FooterPart | undefined =
						working && tpsText ? { text: theme.fg("success", tpsText), priority: 75 } : undefined;

					const project = formatPath(ctx.cwd);
					const brandPart: FooterPart = {
						text: theme.fg("accent", theme.bold("✦ pi")),
						priority: 100,
					};
					const sessionPart: FooterPart | undefined = sessionName
						? { text: theme.fg("text", `◦ ${sessionName}`), priority: 35 }
						: undefined;
					const projectPart: FooterPart = { text: theme.fg("muted", project), priority: 70 };
					const branchPart: FooterPart | undefined = branch
						? { text: theme.fg("accent", `⎇ ${branch}`), priority: 85 }
						: undefined;
					const workingPart: FooterPart | undefined = working
						? { text: theme.fg("warning", "● working"), priority: 90 }
						: undefined;
					const narrowBranchPart: FooterPart | undefined = branch
						? {
								text: theme.fg(
									"accent",
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

					const usagePart: FooterPart = {
						text: theme.fg("muted", `↑${formatCount(usage.input)} ↓${formatCount(usage.output)}`),
						priority: 100,
					};
					const compactUsagePart: FooterPart = {
						text: theme.fg("muted", `↑${compactCount(usage.input)} ↓${compactCount(usage.output)}`),
						priority: 100,
					};
					const cachePart: FooterPart = {
						text: theme.fg("dim", `cache ${formatCount(usage.cacheRead)}/${formatCount(usage.cacheWrite)}`),
						priority: 20,
					};
					const compactCachePart: FooterPart = {
						text: theme.fg("dim", `R${compactCount(usage.cacheRead)} W${compactCount(usage.cacheWrite)}`),
						priority: 15,
					};
					const costPart: FooterPart = {
						text: theme.fg("success", formatCost(usage.cost)),
						priority: 70,
					};
					const contextPart: FooterPart = {
						text: theme.fg("dim", contextLabel(ctx)),
						priority: 95,
					};
					const compactContextPart: FooterPart = {
						text: theme.fg("dim", compactContextLabel(ctx)),
						priority: 95,
					};
					const toolsPart: FooterPart = {
						text: theme.fg("dim", `tools ${activeTools}/${allTools}`),
						priority: 30,
					};
					const modelPart: FooterPart = {
						text: theme.fg("text", model),
						priority: 90,
					};
					const compactModelPart: FooterPart = {
						text: theme.fg("text", modelId),
						priority: 100,
					};
					const thinkingPart: FooterPart = {
						text: theme.fg("accent", thinkingLevel),
						priority: 65,
					};

					const layout = footerLayoutForWidth(width);
					if (layout === "wide") {
						return [
							renderFooterLine(
								width,
								footerParts(
									brandPart,
									sessionPart,
									projectPart,
									branchPart,
									workingPart,
									...statusParts,
								),
								theme,
							),
							renderFooterLine(
								width,
								footerParts(
									usagePart,
									tpsPart,
									cachePart,
									costPart,
									contextPart,
									toolsPart,
									modelPart,
									thinkingPart,
								),
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
									sessionPart,
									projectPart,
									branchPart,
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
									costPart,
									compactContextPart,
									compactModelPart,
									thinkingPart,
									toolsPart,
									compactCachePart,
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
						renderFooterLine(width, footerParts(compactUsagePart, tpsPart, costPart, compactContextPart), theme),
						renderFooterLine(
							width,
							footerParts(compactModelPart, thinkingPart, toolsPart, ...statusParts),
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
	pi.on("agent_start", refresh);
	pi.on("agent_end", refresh);
	pi.on("turn_end", refresh);
	pi.on("tool_execution_start", refresh);
	pi.on("tool_execution_end", refresh);

	pi.on("session_shutdown", async (_event, ctx) => {
		if (tpsTimer) {
			clearInterval(tpsTimer);
			tpsTimer = undefined;
		}
		ctx.ui.setFooter(undefined);
		requestRender = () => {};
	});
}
