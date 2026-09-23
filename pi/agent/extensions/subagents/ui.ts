/**
 * Subagents — TUI views.
 *
 * - Live run state (activities, usage, thinking preview) shared with index.ts
 * - Live dashboard rendered into the tool result while subagents run
 * - Full per-run transcript rendering for finished runs
 * - Interactive `/subagents` browser overlay (list + scrollable detail)
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	matchesKey,
	sliceByColumn,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { getFinalOutput, type SubagentRunResult, type SubagentUsage } from "./runner.ts";

// ---------------------------------------------------------------------------
// Live run state (written by index.ts, read by the views below)
// ---------------------------------------------------------------------------

export interface RunActivity {
	kind: "thinking" | "message" | "tool" | "toolResult" | "status";
	/** ms since run start */
	at: number;
	text?: string;
	toolName?: string;
	/** Full serialized tool arguments; the preview remains for compact views. */
	args?: string;
	argsPreview?: string;
	/** Full text tool output for expanded live views. */
	resultText?: string;
	resultPreview?: string;
	isError?: boolean;
}

export interface LiveRun {
	runId: string;
	groupId: string;
	/** Planned number of runs in this invocation group (display-only). */
	groupSize?: number;
	kind: "single" | "parallel" | "chain";
	step?: number;
	name: string;
	model: string;
	/** Exact task prompt sent by the main agent. */
	task: string;
	/** Resolved subagent instructions and controls, shown in the detail view. */
	systemPrompt?: string;
	tools?: string[];
	thinking?: string;
	cwd?: string;
	timeoutSec?: number;
	maxTurns?: number;
	status: "running" | "ok" | "error";
	/** epoch ms */
	startTime: number;
	endTime?: number;
	usage: SubagentUsage;
	activities: RunActivity[];
	currentThinking?: string;
	messages: AgentMessage[];
	stopReason?: string;
	errorMessage?: string;
	sessionId?: string;
	/** True when the persisted transcript was capped before storage. */
	transcriptTruncated?: boolean;
}

/** Fields searched by `/subagents`; optional fields keep legacy records safe. */
export interface RunFilterRecord {
	name?: unknown;
	model?: unknown;
	task?: unknown;
	kind?: unknown;
	status?: unknown;
	stopReason?: unknown;
	groupId?: unknown;
	sessionId?: unknown;
}

/** Match every whitespace-separated term against any searchable run field. */
export function runMatchesFilter(run: RunFilterRecord, filter: string): boolean {
	const terms = filter
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (terms.length === 0) return true;

	const fields = [
		run.name,
		run.model,
		run.task,
		run.kind,
		run.status,
		run.stopReason,
		run.groupId,
		run.sessionId,
	]
		.filter((value): value is string | number | boolean => value !== undefined && value !== null)
		.map((value) => String(value).toLowerCase());
	return terms.every((term) => fields.some((field) => field.includes(term)));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${s}s`;
}

export function usageLine(usage: SubagentUsage, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx ${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" · ");
}

export function preview(text: string, max = 60): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function statusIcon(status: "running" | "ok" | "error"): string {
	return status === "running" ? "⏳" : status === "ok" ? "✓" : "✗";
}

export function truncateBytes(text: string, cap: number): string {
	if (Buffer.byteLength(text, "utf8") <= cap) return text;
	let truncated = text.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
	return `${truncated}… [truncated]`;
}

export function isFailedResult(r: SubagentRunResult): boolean {
	return (
		r.exitCode !== 0 ||
		r.stopReason === "error" ||
		r.stopReason === "aborted" ||
		r.stopReason === "timeout" ||
		r.stopReason === "maxTurns"
	);
}

export function runDisplayName(r: { kind: "single" | "parallel" | "chain"; step?: number; name: string }): string {
	return r.kind === "single" ? r.name : `${r.kind}${r.step !== undefined ? ` ${r.step}` : ""} · ${r.name}`;
}

// ---------------------------------------------------------------------------
// Activity lines
// ---------------------------------------------------------------------------

export function activityLine(a: RunActivity, theme: Theme, expanded = false): string {
	switch (a.kind) {
		case "tool": {
			const args = expanded ? (a.args ?? a.argsPreview ?? "") : (a.argsPreview ?? a.args ?? "");
			return `  ${theme.fg("toolTitle", `🔧 ${a.toolName}`)} ${theme.fg("dim", args)}`;
		}
		case "toolResult": {
			const result = expanded ? (a.resultText ?? a.resultPreview ?? "") : (a.resultPreview ?? a.resultText ?? "");
			if (a.isError) {
				return `  ${theme.fg("error", `✗ ${a.toolName}`)}${result ? ` ${theme.fg("error", expanded ? result : preview(result, 90))}` : ""}`;
			}
			return `  ${theme.fg("success", `✓ ${a.toolName}`)}${result ? ` ${theme.fg("dim", expanded ? result : preview(result, 90))}` : ""}`;
		}
		case "message":
			return `  ${theme.fg("accent", "💬")} ${theme.fg("dim", preview(a.text ?? "", 110))}`;
		case "thinking":
			return `  ${theme.fg("thinkingLow", `💭 ${preview(a.text ?? "", 110)}`)}`;
		case "status":
			return `  ${theme.fg("warning", a.text ?? "")}`;
	}
}

/** Plain (no ANSI) one-liner for the last activity — used for onUpdate content text. */
export function activityPlainText(a: RunActivity): string {
	switch (a.kind) {
		case "tool":
			return `→ ${a.toolName} ${a.argsPreview ?? ""}`.trimEnd();
		case "toolResult":
			return `${a.isError ? "✗" : "✓"} ${a.toolName}${a.resultPreview ? ` ${preview(a.resultPreview, 90)}` : ""}`;
		case "message":
			return `💬 ${preview(a.text ?? "", 100)}`;
		case "thinking":
			return `💭 ${preview(a.text ?? "", 100)}`;
		case "status":
			return a.text ?? "";
	}
}

// ---------------------------------------------------------------------------
// Transcript segments (shared by Container renderer and browser plain lines)
// ---------------------------------------------------------------------------

type TranscriptSegment =
	| { type: "text"; turn: number; text: string }
	| { type: "thinking"; turn: number; text: string }
	| { type: "toolCall"; turn: number; name: string; args: string }
	| { type: "toolResult"; turn: number; name: string; args: string; text: string; isError: boolean };

function textOf(content: Array<{ type?: string; text?: string }>): string {
	return (content ?? [])
		.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export function messageSegments(messages: AgentMessage[]): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	const pending = new Map<string, { name: string; args: string }>();
	let turn = 0;
	for (const m of messages) {
		if (m.role === "assistant") {
			turn++;
			for (const part of m.content) {
				if (part.type === "text" && part.text.trim()) {
					segments.push({ type: "text", turn, text: part.text });
				} else if (part.type === "thinking" && part.thinking?.trim()) {
					segments.push({ type: "thinking", turn, text: part.thinking });
				} else if (part.type === "toolCall") {
					const args = JSON.stringify(part.arguments);
					pending.set(part.id, { name: part.name, args });
					segments.push({ type: "toolCall", turn, name: part.name, args });
				}
			}
		} else if (m.role === "toolResult") {
			const call = m.toolCallId ? pending.get(m.toolCallId) : undefined;
			if (call) pending.delete(m.toolCallId);
			segments.push({
				type: "toolResult",
				turn,
				name: call?.name ?? m.toolName,
				args: call?.args ?? "",
				text: textOf(m.content as Array<{ type?: string; text?: string }>),
				isError: m.isError,
			});
		}
	}
	return segments;
}

function runHeaderLine(r: SubagentRunResult, theme: Theme): string {
	const icon = isFailedResult(r) ? "✗" : "✓";
	const stop = r.stopReason ? ` ${theme.fg("warning", `[${r.stopReason}]`)}` : "";
	return `${icon} ${theme.fg("accent", r.name)}${stop} · ${theme.fg("dim", r.model)} · ${theme.fg("dim", formatElapsed(r.durationMs ?? 0))}`;
}

function appendSegment(
	container: Container,
	seg: TranscriptSegment,
	mdTheme: MarkdownTheme,
	theme: Theme,
	expanded = false,
): void {
	switch (seg.type) {
		case "text":
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(expanded ? seg.text : truncateBytes(seg.text, 6000), 0, 0, mdTheme));
			break;
		case "thinking":
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("thinkingLow", `💭 ${expanded ? seg.text : truncateBytes(seg.text, 2000)}`), 0, 0),
			);
			break;
		case "toolCall":
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg("toolTitle", `🔧 ${seg.name}`) + (seg.args ? ` ${theme.fg("dim", seg.args)}` : ""),
					0,
					0,
				),
			);
			break;
		case "toolResult":
			container.addChild(
				new Text(seg.isError ? theme.fg("error", `✗ ${seg.name}`) : theme.fg("success", `✓ ${seg.name}`), 0, 0),
			);
			if (seg.text)
				container.addChild(new Text(theme.fg("toolOutput", expanded ? seg.text : truncateBytes(seg.text, 4000)), 1, 0));
			break;
	}
}

// ---------------------------------------------------------------------------
// Live dashboard (streamed into the tool result while subagents run)
// ---------------------------------------------------------------------------

export function renderLiveDashboard(live: LiveRun[], expanded: boolean, theme: Theme): Component {
	const container = new Container();
	const running = live.filter((r) => r.status === "running").length;
	const totalCost = live.reduce((s, r) => s + r.usage.cost, 0);
	const header = `Subagents · ${live.length} run${live.length === 1 ? "" : "s"} · ${running} active · $${totalCost.toFixed(4)}${expanded ? "" : "  (Ctrl+O to expand)"}`;
	container.addChild(new Text(theme.fg("accent", header), 0, 0));

	for (const r of live) {
		container.addChild(new Spacer(1));
		const icon = statusIcon(r.status);
		const color: "accent" | "success" | "error" =
			r.status === "running" ? "accent" : r.status === "ok" ? "success" : "error";
		const elapsed = formatElapsed((r.status === "running" ? Date.now() : (r.endTime ?? Date.now())) - r.startTime);
		const stop = r.stopReason && r.status !== "running" ? ` ${theme.fg("warning", `[${r.stopReason}]`)}` : "";
		const group = r.groupSize ? ` · ${groupContext(r, live)}` : "";
		container.addChild(
			new Text(
				`${icon} ${theme.fg(color, runDisplayName(r))}${stop} · ${theme.fg("dim", r.model)} · ${theme.fg("dim", elapsed)}${theme.fg("dim", group)}`,
				0,
				0,
			),
		);
		container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", preview(r.task, 110)), 0, 0));
		if (r.currentThinking) {
			container.addChild(new Text(theme.fg("thinkingLow", `  💭 ${preview(r.currentThinking, 130)}`), 0, 0));
		}
		const recent = r.activities.slice(-(expanded ? 10 : 2));
		for (const a of recent) {
			container.addChild(new Text(activityLine(a, theme), 0, 0));
		}
		const u = usageLine(r.usage, r.model);
		if (u) container.addChild(new Text(theme.fg("dim", `  ${u}`), 0, 0));
	}
	return container;
}

/** Plain-text variant of the dashboard for onUpdate content. */
export function liveDashboardText(live: LiveRun[]): string {
	const lines: string[] = [];
	for (const r of live) {
		const icon = statusIcon(r.status);
		const elapsed = formatElapsed((r.status === "running" ? Date.now() : (r.endTime ?? Date.now())) - r.startTime);
		const group = r.groupSize ? ` · ${groupContext(r, live)}` : "";
		lines.push(`${icon} ${runDisplayName(r)} [${r.model}] ${elapsed}${group}`);
		if (r.currentThinking) lines.push(`   💭 ${preview(r.currentThinking, 100)}`);
		const last = r.activities[r.activities.length - 1];
		if (last) lines.push(`   ${activityPlainText(last)}`);
		const u = usageLine(r.usage);
		if (u) lines.push(`   ${u}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Final results view (renderResult after the tool completes)
// ---------------------------------------------------------------------------

export function renderRunResults(
	results: SubagentRunResult[],
	mode: string,
	expanded: boolean,
	theme: Theme,
): Component {
	const container = new Container();
	const mdTheme = getMarkdownTheme();
	const ok = results.filter((r) => !isFailedResult(r)).length;
	const totalCost = results.reduce((s, r) => s + r.usage.cost, 0);
	const header = `Subagents · ${mode} · ${ok}/${results.length} ok · $${totalCost.toFixed(4)}`;
	container.addChild(new Text(theme.fg("accent", header), 0, 0));

	for (const r of results) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(runHeaderLine(r, theme), 0, 0));
		container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", expanded ? r.task : preview(r.task, 120)), 0, 0));
		if (isFailedResult(r) && r.errorMessage) {
			container.addChild(new Text(theme.fg("error", r.errorMessage), 0, 0));
		}
		if (expanded) {
			let lastTurn = 0;
			for (const seg of messageSegments(r.messages)) {
				if (seg.turn && seg.turn !== lastTurn) {
					container.addChild(
						new Text(theme.fg("borderMuted", `  ── turn ${seg.turn} ───────────────────`), 0, 0),
					);
					lastTurn = seg.turn;
				}
				appendSegment(container, seg, mdTheme, theme, expanded);
			}
		}
		const final = getFinalOutput(r.messages);
		if (final) {
			container.addChild(new Spacer(1));
			if (expanded) container.addChild(new Text(theme.fg("muted", "Final output:"), 0, 0));
			container.addChild(new Markdown(expanded ? final : truncateBytes(final, 8000), 0, 0, mdTheme));
		} else if (!expanded && isFailedResult(r)) {
			container.addChild(new Text(theme.fg("error", r.stderr || "(no output)"), 0, 0));
		}
		const u = usageLine(r.usage, r.model);
		if (u) container.addChild(new Text(theme.fg("dim", u), 0, 0));
	}
	if (!expanded)
		container.addChild(
			new Text(theme.fg("muted", "(Ctrl+O to expand — full transcript, tool calls and results)"), 0, 0),
		);
	return container;
}

// ---------------------------------------------------------------------------
// Interactive /subagents browser
// ---------------------------------------------------------------------------

const BROWSER_MAX_ROWS = 30;
const BROWSER_PAGE = 20;
const BROWSER_DETAIL_ROWS = 34;
const BROWSER_DETAIL_CAP = 40_000;

/** Background roles used for the browser panel (subset of pi's ThemeBg). */
type PanelBg = "selectedBg" | "customMessageBg" | "toolPendingBg";

/** A rendered detail row: code rows keep full width and scroll horizontally; others wrap. */
type BodyLine = { text: string; code: boolean };

function appendSectionHeading(lines: BodyLine[], theme: Theme, width: number, label: string): void {
	const prefix = `  ── ${label} `;
	const fill = "─".repeat(Math.max(0, width - 2 - visibleWidth(prefix)));
	lines.push({ text: theme.fg("borderMuted", `${prefix}${fill}`), code: false });
}

function appendWrappedSection(
	lines: BodyLine[],
	theme: Theme,
	width: number,
	label: string,
	text: string,
	color: "dim" | "thinkingLow" = "dim",
): void {
	appendSectionHeading(lines, theme, width, label);
	const innerWidth = Math.max(1, width - 6);
	const value = text.trim() ? text : "(none)";
	for (const line of wrapTextWithAnsi(theme.fg(color, value), innerWidth)) {
		lines.push({ text: `    ${line}`, code: false });
	}
}

function appendKeyValueSection(
	lines: BodyLine[],
	theme: Theme,
	width: number,
	label: string,
	fields: Array<[string, string]>,
): void {
	appendSectionHeading(lines, theme, width, label);
	for (const [name, value] of fields) {
		const prefix = `    ${name}: `;
		const valueWidth = Math.max(1, width - 2 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(theme.fg("dim", value || "(none)"), valueWidth);
		for (let i = 0; i < wrapped.length; i++) {
			lines.push({
				text: `${i === 0 ? theme.fg("muted", prefix) : " ".repeat(prefix.length)}${wrapped[i]}`,
				code: false,
			});
		}
	}
}

function groupContext(run: LiveRun, runs: LiveRun[], allRuns: LiveRun[] = runs): string | undefined {
	if (!run.groupId) return undefined;
	const groupRuns = allRuns.filter((candidate) => candidate.groupId === run.groupId);
	const planned = run.groupSize && run.groupSize > 0 ? run.groupSize : Math.max(1, groupRuns.length);
	const completed = groupRuns.filter((candidate) => candidate.status !== "running").length;
	const step = run.step !== undefined ? `step ${run.step}/${planned} · ` : "";
	return `group ${run.groupId.slice(0, 8)} · ${step}${completed}/${planned} done`;
}

function transcriptBodyLines(
	messages: AgentMessage[],
	theme: Theme,
	width: number,
	capChars: number,
	expanded = false,
): BodyLine[] {
	const lines: BodyLine[] = [];
	let lastTurn = 0;
	let budget = expanded ? Number.POSITIVE_INFINITY : capChars;
	const innerWidth = Math.max(1, width - 2);
	// code rows are never wrapped or truncated (they scroll horizontally); prose rows wrap.
	const pushStyled = (styled: string, code: boolean) => {
		if (code) {
			lines.push({ text: styled, code: true });
		} else {
			for (const l of wrapTextWithAnsi(styled, innerWidth)) lines.push({ text: l, code: false });
		}
	};
	const pushNotice = (text: string) => lines.push({ text: theme.fg("warning", `  ⚠ ${text}`), code: false });
	for (const seg of messageSegments(messages)) {
		if (Number.isFinite(budget) && budget <= 0) {
			pushNotice("transcript display truncated; more content is not shown");
			break;
		}
		if (seg.turn && seg.turn !== lastTurn) {
			lines.push({ text: theme.fg("borderMuted", `  ── turn ${seg.turn} ───────────────────`), code: false });
			lastTurn = seg.turn;
		}
		switch (seg.type) {
			case "text": {
				const t = expanded ? seg.text : truncateBytes(seg.text, Math.min(4000, Math.max(1, budget)));
				if (!expanded && t !== seg.text) pushNotice("message text truncated for display");
				budget -= Math.min(budget, t.length);
				for (const l of t.split("\n")) pushStyled(`  💬 ${l}`, false);
				break;
			}
			case "thinking": {
				const t = expanded ? seg.text : truncateBytes(seg.text, Math.min(1500, Math.max(1, budget)));
				if (!expanded && t !== seg.text) pushNotice("thinking text truncated for display");
				budget -= Math.min(budget, t.length);
				for (const l of t.split("\n")) {
					pushStyled(theme.fg("thinkingLow", `  💭 ${l}`), false);
				}
				break;
			}
			case "toolCall": {
				const args = expanded ? seg.args : preview(seg.args, 140);
				pushStyled(`  ${theme.fg("toolTitle", `🔧 ${seg.name}`)} ${theme.fg("dim", args)}`, true);
				break;
			}
			case "toolResult": {
				lines.push({
					text: seg.isError ? theme.fg("error", `  ✗ ${seg.name}`) : theme.fg("success", `  ✓ ${seg.name}`),
					code: false,
				});
				if (seg.text) {
					const t = expanded ? seg.text : truncateBytes(seg.text, Math.min(3000, Math.max(1, budget)));
					if (!expanded && t !== seg.text) pushNotice("tool output truncated for display");
					budget -= Math.min(budget, t.length);
					for (const l of t.split("\n")) pushStyled(theme.fg("toolOutput", `    ${l}`), true);
				}
				break;
			}
		}
	}
	return lines;
}

export class SubagentsBrowser implements Component {
	private view: "list" | "detail" = "list";
	private selected = 0;
	private selectedRunId?: string;
	private detailRunId?: string;
	private detailExpanded = false;
	private scroll = 0;
	private scrollX = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private cachedWidth = 0;
	private cachedRows = 0;
	private cachedSignature = "";
	private cachedLines: string[] = [];
	private getAllRuns: () => LiveRun[];

	constructor(
		private theme: Theme,
		private tui: { requestRender(): void; terminal?: { rows?: number } },
		private onClose: () => void,
		private getRuns: () => LiveRun[],
		private keybindings?: KeybindingsManager,
		getAllRuns?: () => LiveRun[],
	) {
		this.getAllRuns = getAllRuns ?? getRuns;
		// Refresh while active for elapsed-time changes, and whenever any data
		// changes so the first completed tick cannot leave a stale cached row.
		this.timer = setInterval(() => {
			const runs = this.getRuns();
			const allRuns = this.getAllRuns();
			const signature = this.runsSignature(runs) + this.runsSignature(allRuns);
			if (signature !== this.cachedSignature || runs.some((r) => r.status === "running")) {
				this.invalidate();
				this.tui.requestRender();
			}
		}, 500);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedRows = 0;
		this.cachedSignature = "";
		this.cachedLines = [];
	}

	/** Dark panel fill (mantle) — darker than the session base so the overlay reads as a distinct window. */
	private static readonly PANEL_BG: PanelBg = "toolPendingBg";

	private terminalRows(): number | undefined {
		const rows = this.tui.terminal?.rows;
		return typeof rows === "number" && rows > 0 ? rows : undefined;
	}

	/** Capture every mutable field consumed by browser output, including nested content. */
	private runsSignature(runs: LiveRun[]): string {
		return JSON.stringify(
			runs.map((run) => {
				return [
					run.runId,
					run.groupId,
					run.groupSize,
					run.kind,
					run.step,
					run.name,
					run.model,
					run.task,
					run.systemPrompt,
					run.tools,
					run.thinking,
					run.cwd,
					run.timeoutSec,
					run.maxTurns,
					run.status,
					run.startTime,
					run.endTime,
					run.usage.input,
					run.usage.output,
					run.usage.cacheRead,
					run.usage.cacheWrite,
					run.usage.cost,
					run.usage.contextTokens,
					run.usage.turns,
					run.currentThinking,
					run.messages.length,
					// Detail rendering derives segments from nested message fields, so an
					// array length alone is insufficient when a record is updated in place.
					JSON.stringify(run.messages),
					run.activities.length,
					JSON.stringify(run.activities),
					run.stopReason,
					run.errorMessage,
					run.sessionId,
					run.transcriptTruncated,
				];
			}),
		);
	}

	/** Keep the overlay within the visible terminal, with a safe fallback for test/RPC TUIs. */
	private viewportRows(): number {
		const rows = this.terminalRows();
		return rows === undefined ? BROWSER_DETAIL_ROWS + 8 : Math.max(4, Math.floor(rows * 0.8));
	}

	private matches(
		data: string,
		binding: Parameters<KeybindingsManager["matches"]>[1],
	): boolean {
		return this.keybindings?.matches(data, binding) ?? false;
	}

	/** Enforce the total overlay height, not just its scrollable body height. */
	private fitHeight(lines: string[], width: number, detail = false): string[] {
		const rows = this.terminalRows();
		if (rows === undefined) return lines;
		const budget = Math.max(1, Math.floor(rows * 0.8));
		if (lines.length <= budget) return lines;
		if (budget === 1) return lines.slice(0, 1);
		if (budget === 2) return [lines[0]!, lines[lines.length - 1]!];
		if (budget === 3) {
			return detail
				? [lines[0]!, lines[lines.length - 2]!, lines[lines.length - 1]!]
				: [
						lines[0]!,
						this.boxed("⚠ terminal too small; resize to see browser content", width),
						lines[lines.length - 1]!,
				];
		}
		const footer = lines[lines.length - 2] ?? lines[lines.length - 1]!;
		const bottom = lines[lines.length - 1]!;
		if (budget === 4) {
			return detail
				? [lines[0]!, lines[1]!, footer, bottom]
				: [
						lines[0]!,
						lines[1]!,
						this.boxed("⚠ compact view; resize terminal for navigation hints", width),
						bottom,
				];
		}
		const middleSlots = budget - 5;
		const middle = lines.slice(2, -2).slice(0, middleSlots);
		return [
			...lines.slice(0, 2),
			...middle,
			this.boxed("⚠ some content omitted to fit terminal height", width),
			footer,
			bottom,
		];
	}

	/** One content row: │ interior │, full-width bg so the box interior is solid. */
	private boxed(content: string, width: number, bg: PanelBg = SubagentsBrowser.PANEL_BG): string {
		const safeWidth = Math.max(1, width);
		if (safeWidth === 1) {
			return this.theme.bg(bg, truncateToWidth(content.replace(/[\r\n]+/g, " "), 1, "...", true));
		}
		const inner = truncateToWidth(content.replace(/[\r\n]+/g, " "), safeWidth - 2, "...", true);
		// truncateToWidth emits full resets (\x1b[0m) around the ellipsis; neutralize them
		// to a fg-only reset so the panel background survives on the trailing characters.
		const clean = inner.replace(/\x1b\[0m/g, "\x1b[39m");
		return this.theme.bg(bg, `${this.theme.fg("border", "│")}${clean}${this.theme.fg("border", "│")}`);
	}

	/** Top (╭─╮) or bottom (╰─╯) border row of the box. */
	private boxBorder(width: number, top: boolean): string {
		const safeWidth = Math.max(1, width);
		if (safeWidth === 1) return this.theme.bg(SubagentsBrowser.PANEL_BG, top ? "╭" : "╰");
		const l = top ? "╭" : "╰";
		const r = top ? "╮" : "╯";
		const mid = "─".repeat(safeWidth - 2);
		return this.theme.bg(SubagentsBrowser.PANEL_BG, this.theme.fg("border", `${l}${mid}${r}`));
	}

	private blankRow(width: number): string {
		return this.boxed("", width);
	}

	/** Keep the selected run stable when live updates reorder or add entries. */
	private syncSelection(runs: LiveRun[]): void {
		if (runs.length === 0) {
			this.selected = 0;
			this.selectedRunId = undefined;
			return;
		}
		const byId = this.selectedRunId ? runs.findIndex((run) => run.runId === this.selectedRunId) : -1;
		if (byId >= 0) this.selected = byId;
		else this.selected = Math.min(this.selected, runs.length - 1);
		this.selectedRunId = runs[this.selected]?.runId;
	}

	handleInput(data: string): void {
		if (
			this.matches(data, "tui.select.cancel") ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c"))
		) {
			if (this.view === "detail") {
				this.view = "list";
				this.detailRunId = undefined;
				this.scroll = 0;
				this.scrollX = 0;
			} else {
				this.onClose();
				return;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (this.view === "detail") {
			this.handleDetailInput(data);
		} else {
			this.handleListInput(data);
		}
	}

	private handleListInput(data: string): void {
		const runs = this.getRuns();
		this.syncSelection(runs);
		if (runs.length === 0) return;
		if (this.matches(data, "tui.select.up") || matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
		}
		else if (this.matches(data, "tui.select.down") || matchesKey(data, Key.down) || data === "j")
			this.selected = Math.min(runs.length - 1, this.selected + 1);
		else if (this.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp))
			this.selected = Math.max(0, this.selected - BROWSER_PAGE);
		else if (this.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown))
			this.selected = Math.min(runs.length - 1, this.selected + BROWSER_PAGE);
		else if (matchesKey(data, Key.home)) this.selected = 0;
		else if (matchesKey(data, Key.end)) this.selected = runs.length - 1;
		else if (
			this.matches(data, "tui.select.confirm") ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.right) ||
			data === "l"
		) {
			const run = runs[this.selected];
			this.selectedRunId = run?.runId;
			if (run) {
				this.detailRunId = run.runId;
				this.scroll = 0;
				this.scrollX = 0;
				this.view = "detail";
			}
		} else {
			return;
		}
		this.selectedRunId = runs[this.selected]?.runId;
		this.invalidate();
		this.tui.requestRender();
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.backspace)) {
			this.view = "list";
			this.detailRunId = undefined;
			this.scroll = 0;
			this.scrollX = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data === "o" || data === "O" || matchesKey(data, Key.ctrl("o"))) {
			this.detailExpanded = !this.detailExpanded;
			this.scroll = 0;
			this.scrollX = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		const hStep = Math.max(1, Math.floor((this.cachedWidth - 2) / 2));
		if (matchesKey(data, Key.left) || data === "h") this.scrollX = Math.max(0, this.scrollX - hStep);
		else if (matchesKey(data, Key.right) || data === "l") this.scrollX += hStep;
		else if (this.matches(data, "tui.select.up") || matchesKey(data, Key.up) || data === "k")
			this.scroll = Math.max(0, this.scroll - 1);
		else if (this.matches(data, "tui.select.down") || matchesKey(data, Key.down) || data === "j") this.scroll += 1;
		else if (this.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp))
			this.scroll = Math.max(0, this.scroll - BROWSER_PAGE);
		else if (this.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) this.scroll += BROWSER_PAGE;
		else if (matchesKey(data, Key.home) || data === "g") this.scroll = 0;
		else if (matchesKey(data, Key.end) || data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
		else return;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const rows = this.terminalRows() ?? 0;
		const runs = this.getRuns();
		const allRuns = this.getAllRuns();
		const signature = this.runsSignature(runs) + this.runsSignature(allRuns);
		if (
			this.cachedLines.length > 0 &&
			this.cachedWidth === width &&
			this.cachedRows === rows &&
			this.cachedSignature === signature
		) {
			return this.cachedLines;
		}
		if (this.view === "detail" && this.detailRunId) {
			const run = runs.find((r) => r.runId === this.detailRunId);
			if (run) {
				this.cachedLines = this.fitHeight(this.renderDetail(run, width, runs, allRuns), width, true);
				this.cachedWidth = width;
				this.cachedRows = rows;
				this.cachedSignature = signature;
				return this.cachedLines;
			}
			this.view = "list";
		}
		this.syncSelection(runs);
		this.cachedLines = this.fitHeight(this.renderList(runs, width, allRuns), width);
		this.cachedWidth = width;
		this.cachedRows = rows;
		this.cachedSignature = signature;
		return this.cachedLines;
	}

	private listRunLimit(): number {
		// A run uses three rows (summary + metadata + prompt); reserve room for
		// borders, header, and footer so small terminals do not get over-tall.
		const rows = this.terminalRows();
		if (rows === undefined) return BROWSER_MAX_ROWS;
		return Math.max(
			1,
			Math.min(BROWSER_MAX_ROWS, Math.floor(Math.max(1, this.viewportRows() - 8) / 3)),
		);
	}


	private renderList(runs: LiveRun[], width: number, allRuns: LiveRun[]): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const active = runs.filter((r) => r.status === "running").length;
		const totalCost = runs.reduce((s, r) => s + r.usage.cost, 0);
		const title = th.fg("accent", th.bold(" Subagents "));
		const summaryParts = [`${runs.length} runs`, `${active} active`];
		if (totalCost > 0) summaryParts.push(`$${totalCost.toFixed(4)}`);
		const summary = ` ${summaryParts.join(" · ")}`;
		const filler = th.fg(
			"borderMuted",
			"─".repeat(Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(summary))),
		);
		lines.push(this.boxBorder(width, true));
		lines.push(this.boxed(`${title}${filler}${summary}`, width));
		lines.push(this.blankRow(width));

		if (runs.length === 0) {
			lines.push(
				this.boxed(
					`  ${th.fg("dim", "No subagent runs yet — delegate work with the subagent tool and check back here.")}`,
					width,
				),
			);
		} else {
			const maxRows = this.listRunLimit();
			const start = Math.max(
				0,
				Math.min(this.selected - Math.floor(maxRows / 2), Math.max(0, runs.length - maxRows)),
			);
			const end = Math.min(runs.length, start + maxRows);
			if (start > 0) lines.push(this.boxed(`  ${th.fg("dim", `… ${start} older runs`)}`, width));
			for (let i = start; i < end; i++) {
				const r = runs[i]!;
				const selected = i === this.selected;
				const bg: PanelBg = selected ? "selectedBg" : SubagentsBrowser.PANEL_BG;
				const indent = selected ? th.fg("accent", "▍ ") : "  ";
				const line = `${indent}${this.listRow(r, width)}`;
				lines.push(this.boxed(line, width, bg));
				lines.push(this.boxed(this.listMetaRow(r, runs, allRuns, width), width, bg));
				const task = preview(r.task, width < 55 ? 100 : 160);
				const error = r.status === "error" && r.errorMessage ? ` · ${preview(r.errorMessage, 100)}` : "";
				lines.push(
					this.boxed(`    ${th.fg(error ? "error" : "dim", `${task}${error}`)}`, width, bg),
				);
			}
			if (end < runs.length)
				lines.push(this.boxed(`  ${th.fg("dim", `… ${runs.length - end} newer runs`)}`, width));
			if (runs.length > maxRows)
				lines.push(this.boxed(`  ${th.fg("dim", `showing ${start + 1}–${end} of ${runs.length}`)}`, width));
		}
		lines.push(this.blankRow(width));
		const footer = width < 36 ? " ↑↓ move · enter · esc" : " ↑↓/jk move · enter open · esc close";
		lines.push(this.boxed(th.fg("dim", footer), width));
		lines.push(this.boxBorder(width, false));
		return lines;
	}

	private listRow(r: LiveRun, width: number): string {
		const th = this.theme;
		const icon = statusIcon(r.status);
		const elapsed =
			r.status === "running"
				? formatElapsed(Date.now() - r.startTime)
				: r.endTime
					? formatElapsed(r.endTime - r.startTime)
					: "…";
		const status =
			r.status === "running"
				? th.fg("accent", `running · ${elapsed}`)
				: r.status === "ok"
					? th.fg("success", `ok · ${elapsed}`)
					: th.fg("error", `error · ${elapsed}`);
		return [icon, th.fg("accent", th.bold(preview(runDisplayName(r), width < 45 ? 36 : 80))), status].join(" · ");
	}

	private listMetaRow(r: LiveRun, runs: LiveRun[], allRuns: LiveRun[], width: number): string {
		const th = this.theme;
		const parts: string[] = [];
		const group = groupContext(r, runs, allRuns);
		if (group) parts.push(group);
		if (width >= 45) parts.push(`model: ${r.model}`);
		if (width >= 100) {
			const u = usageLine(r.usage);
			if (u) parts.push(u);
		}
		return `    ${th.fg("dim", parts.length > 0 ? parts.join(" · ") : "details available on enter")}`;
	}

	private renderDetail(run: LiveRun, width: number, runs: LiveRun[], allRuns: LiveRun[]): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const icon = statusIcon(run.status);
		const elapsed =
			run.status === "running"
				? formatElapsed(Date.now() - run.startTime)
				: run.endTime
					? formatElapsed(run.endTime - run.startTime)
					: "…";
		const status =
			run.status === "running"
				? th.fg("accent", `RUNNING · ${elapsed}`)
				: run.status === "ok"
					? th.fg("success", `OK · ${elapsed}`)
					: th.fg("error", `ERROR · ${elapsed}`);
		lines.push(this.boxBorder(width, true));
		lines.push(this.boxed(`  ${icon} ${th.fg("accent", th.bold(runDisplayName(run)))}`, width));
		lines.push(this.boxed(`  ${status} · ${th.fg("dim", `model: ${run.model}`)}`, width));
		const u = usageLine(run.usage);
		if (u) lines.push(this.boxed(th.fg("dim", `  usage: ${u}`), width));
		if (run.errorMessage) lines.push(this.boxed(th.fg("error", `  error: ${run.errorMessage}`), width));
		if (run.sessionId) lines.push(this.boxed(th.fg("dim", `  session: ${run.sessionId}`), width));
		const group = groupContext(run, runs, allRuns);
		if (group) lines.push(this.boxed(th.fg("dim", `  ${group}`), width));
		lines.push(this.blankRow(width));

		const innerWidth = Math.max(1, width - 2);
		const body: BodyLine[] = [];
		appendWrappedSection(body, th, width, "Prompt · main agent → subagent", run.task);
		if (run.systemPrompt?.trim()) {
			appendWrappedSection(body, th, width, "System prompt", run.systemPrompt);
		}
		appendKeyValueSection(body, th, width, "Config", [
			["tools", run.tools?.length ? run.tools.join(", ") : "default"],
			["thinking", run.thinking ?? "default"],
			["cwd", run.cwd ?? "session directory"],
			["timeout", run.timeoutSec ? `${run.timeoutSec}s` : "default"],
			["max turns", run.maxTurns ? String(run.maxTurns) : "default"],
		]);

		const appendActivities = (label: string): void => {
			appendSectionHeading(body, th, width, label);
			if (run.activities.length === 0) {
				body.push({ text: th.fg("dim", "    No activity recorded."), code: false });
				return;
			}
			body.push(
				...run.activities.flatMap((a) =>
					wrapTextWithAnsi(
						`${th.fg("dim", `    +${formatElapsed(a.at)}`)} ${activityLine(a, th, this.detailExpanded)}`,
						innerWidth,
					).map((text) => ({ text, code: false })),
				),
			);
		};

		const hasMessages = run.messages.length > 0;
		const hasActivities = run.activities.length > 0;
		if (run.status === "running" && hasActivities) appendActivities("Live activity");
		if (run.status === "running" && run.currentThinking) {
			appendWrappedSection(body, th, width, "Current thinking", run.currentThinking, "thinkingLow");
		}
		if (hasMessages) {
			appendSectionHeading(body, th, width, "Transcript");
			if (run.transcriptTruncated) {
				body.push({
					text: th.fg("warning", "    ⚠ transcript was shortened before storage; expand only reveals available content"),
					code: false,
				});
			}
			body.push(...transcriptBodyLines(run.messages, th, width, BROWSER_DETAIL_CAP, this.detailExpanded));
		} else if (run.status !== "running" || !hasActivities) {
			appendActivities("Activity");
		}

		const maxCodeWidth = body.reduce((m, l) => (l.code ? Math.max(m, visibleWidth(l.text)) : m), 0);
		const hasOverflow = maxCodeWidth > innerWidth;
		if (hasOverflow) this.scrollX = Math.min(this.scrollX, maxCodeWidth - innerWidth);
		else this.scrollX = 0;

		// Header rows vary with usage, errors, sessions, groups, and truncation
		// notices. Reserve the actual header plus the three footer rows, rather
		// than subtracting a fixed chrome estimate from the terminal height.
		const totalBudget = this.terminalRows() === undefined ? undefined : Math.max(1, Math.floor(this.terminalRows()! * 0.8));
		const footerRows = 3; // blank row, navigation hints, bottom border
		const detailRows =
			totalBudget === undefined
				? BROWSER_DETAIL_ROWS
				: Math.max(0, Math.min(BROWSER_DETAIL_ROWS, totalBudget - lines.length - footerRows));
		const maxScroll = Math.max(0, body.length - detailRows);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		const start = this.scroll;
		const end = Math.min(body.length, start + detailRows);
		for (let i = start; i < end; i++) {
			const row = body[i]!;
			const text = row.code && hasOverflow ? sliceByColumn(row.text, this.scrollX, innerWidth) : row.text;
			lines.push(this.boxed(text, width));
		}

		lines.push(this.blankRow(width));
		const compact = width < 36;
		const hints = compact ? ["↑↓ scroll"] : ["↑/↓ scroll"];
		if (body.length > detailRows && !compact) {
			const pct = Math.min(100, Math.round((end / body.length) * 100));
			hints.unshift(` ${pct}% · ${body.length} lines`);
		}
		if (hasOverflow && !compact) hints.push("←/→ horiz");
		hints.push(compact ? (this.detailExpanded ? "o compact" : "o expand") : this.detailExpanded ? "o collapse" : "o expand");
		hints.push(compact ? "esc close" : "backspace back · esc close");
		lines.push(this.boxed(th.fg("dim", ` ${hints.join(" · ")}`), width));
		lines.push(this.boxBorder(width, false));
		return lines;
	}
}
