import { getMarkdownTheme, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { formatToolOutput, type FormattedToolOutput, type ToolContentBlock } from "./format.ts";

const COLLAPSED_OUTPUT_CAP = 1_000;
const COLLAPSED_LINE_CAP = 8;
const EXPANDED_OUTPUT_CAP = 40_000;
const EXPLICIT_CODE_LANGUAGES = new Set([
	"python", "java", "go", "javascript", "cpp", "typescript", "php", "ruby", "c", "csharp", "nix",
	"bash", "rust", "scala", "kotlin", "swift", "dart", "groovy", "perl", "lua",
]);

export interface ToolResultLike {
	content?: readonly ToolContentBlock[];
	details?: unknown;
}

export interface ToolResultViewOptions {
	expanded: boolean;
	isPartial?: boolean;
}

export interface ToolResultViewContext {
	args?: unknown;
	isError?: boolean;
}

export interface ToolResultRendererConfig {
	/** Optional concise status label shown above the bounded output preview. */
	collapsedSummary?: (result: ToolResultLike, formatted: FormattedToolOutput) => string | undefined;
}

export type ToolResultSummary = ToolResultRendererConfig["collapsedSummary"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function preview(text: string, max = 220): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function trimDisplayNewlines(text: string): string {
	return text.replace(/^\n+|\n+$/g, "");
}

function displayCode(output: FormattedToolOutput): string {
	const source = trimDisplayNewlines(output.text);
	return output.language && EXPLICIT_CODE_LANGUAGES.has(output.language)
		? highlightCode(source, output.language).join("\n")
		: source;
}

function displayOutput(toolName: string, output: FormattedToolOutput): string {
	if (toolName === "bash") {
		return output.kind === "code" && output.language === "bash" ? displayCode(output) : trimDisplayNewlines(output.text);
	}
	return output.kind === "code" ? displayCode(output) : output.text;
}

function defaultCollapsedSummary(toolName: string, result: ToolResultLike, output: FormattedToolOutput): string {
	if (toolName === "edit") return "File updated";
	if (toolName === "write") return "File written successfully";
	if (toolName === "bash") return "Command completed";
	if (toolName === "question") {
		const details = asRecord(result.details);
		const answers = Array.isArray(details?.answers) ? details.answers.length : 0;
		return `${answers} answer${answers === 1 ? "" : "s"} received`;
	}
	if (toolName === "memory") {
		const details = asRecord(result.details);
		if (details?.action === "retrieve" && typeof details.count === "number") {
			return `${details.count} memor${details.count === 1 ? "y" : "ies"}`;
		}
		const action = ["create", "edit", "retrieve", "archive", "restore", "delete", "merge", "stats"].find(
			(candidate) => candidate === details?.action,
		);
		return action ? `Memory ${action}` : "Memory result ready";
	}
	if (toolName === "goal_complete") return "Goal completion result ready";
	if (toolName === "token_usage") return "Token usage report ready";
	if (toolName === "subagent_status") return "Subagent status ready";
	if (toolName === "subagent_history") {
		const details = asRecord(result.details);
		const count = Array.isArray(details?.runIds) ? details.runIds.length : 0;
		return `${count} subagent run${count === 1 ? "" : "s"}`;
	}
	if (toolName === "subagent_cancel") return "Cancellation result ready";
	if (toolName === "lsp_diagnostics") {
		const count = output.text.match(/\b(\d+) issue\(s\)/)?.[1];
		if (count) return `${count} diagnostic${count === "1" ? "" : "s"}`;
		if (/no issues/i.test(output.text)) return "No diagnostics";
		return "Diagnostics result ready";
	}
	if (toolName === "lsp_references") {
		const count = output.text.match(/Found (\d+) reference/)?.[1];
		return count ? `${count} reference${count === "1" ? "" : "s"}` : "References result ready";
	}
	if (toolName === "lsp_symbols") return output.text.match(/Symbols \(\d+\)/)?.[0] ?? "Symbols result ready";
	if (toolName === "lsp_definition") {
		const count = output.text.match(/(?:^- |^  - )/gm)?.length ?? 0;
		return count ? `${count} definition${count === 1 ? "" : "s"}` : "Definition result ready";
	}
	if (toolName === "lsp_hover") return "Hover information ready";
	if (toolName === "robinhood_search_tools") {
		const details = asRecord(result.details);
		const matches = Array.isArray(details?.matches) ? details.matches.length : 0;
		const added = Array.isArray(details?.added) ? details.added.length : 0;
		return `${matches} matching tool${matches === 1 ? "" : "s"} · ${added} newly loaded`;
	}
	if (toolName.startsWith("robinhood_")) return "Brokerage result ready · expand for details";
	if (toolName.startsWith("helium_")) return "Browser result ready · expand for details";
	return output.text ? `${Buffer.byteLength(output.text, "utf8")} bytes of output · expand for details` : "No text output";
}

export function collapsedToolResultSummary(
	toolName: string,
	result: ToolResultLike,
	context: ToolResultViewContext = {},
	config: ToolResultRendererConfig = {},
): string {
	const output = formatToolOutput(result.content ?? [], COLLAPSED_OUTPUT_CAP, {
		toolName,
		args: context.args,
		details: result.details,
	});
	const summary = config.collapsedSummary?.(result, output) ?? defaultCollapsedSummary(toolName, result, output);
	const outputPreview = output.text || output.summary;
	return preview(outputPreview ? `${summary} · ${outputPreview}` : summary);
}

function markdownContent(output: FormattedToolOutput): string {
	if (!output.text) return "";
	if (output.kind === "code" || output.kind === "json") {
		let fence = "```";
		while (output.text.includes(fence)) fence += "`";
		return `${fence}${output.language ?? (output.kind === "json" ? "json" : "text")}\n${output.text}\n${fence}`;
	}
	if (output.kind === "list") return output.text.replace(/^• /gm, "- ");
	return output.text;
}

/** Shared display-only renderer; tool content and details passed to the model are never modified. */
export function renderToolResult(
	toolName: string,
	result: ToolResultLike,
	options: ToolResultViewOptions,
	theme: Theme,
	context: ToolResultViewContext = {},
	config: ToolResultRendererConfig = {},
): Component {
	const output = formatToolOutput(result.content ?? [], options.expanded ? EXPANDED_OUTPUT_CAP : COLLAPSED_OUTPUT_CAP, {
		toolName,
		args: context.args,
		details: result.details,
	});
	const isError = context.isError === true;
	const container = new Container();
	const title = [toolName, options.expanded ? output.title : undefined].filter(Boolean).join(" · ");
	const icon = options.isPartial ? "⏳" : isError ? "✗" : "✓";
	container.addChild(
		new Text(theme.fg(isError ? "error" : options.isPartial ? "warning" : "success", `${icon} ${title}`), 0, 0),
	);

	if (!options.expanded) {
		const summary = config.collapsedSummary?.(result, output) ?? defaultCollapsedSummary(toolName, result, output);
		container.addChild(new Text(theme.fg(isError ? "error" : "dim", `  ${preview(summary)}`), 0, 0));
		const summarySource = output.text ? "" : output.summary ? preview(output.summary, COLLAPSED_OUTPUT_CAP) : "";
		const source = trimDisplayNewlines(output.text || summarySource);
		if (source) {
			const lines = source.split("\n");
			const lineTruncated = lines.length > COLLAPSED_LINE_CAP;
			const summaryTruncated = Boolean(output.summary && !output.text && summarySource !== output.summary);
			const visible = lines.slice(0, COLLAPSED_LINE_CAP).join("\n");
			const body = output.kind === "code" ? displayCode({ ...output, text: visible }) : visible;
			container.addChild(new Text(body.split("\n").map((line) => `  ${line}`).join("\n"), 0, 0));
			if (lineTruncated || output.truncated || summaryTruncated) {
				container.addChild(new Text(theme.fg("warning", "  ⚠ output preview truncated; expand for full output"), 0, 0));
			} else {
				container.addChild(new Text(theme.fg("muted", "  ↳ expand for full output"), 0, 0));
			}
		} else {
			container.addChild(new Text(theme.fg("muted", "  ↳ expand for details"), 0, 0));
		}
		if (output.notes.length) container.addChild(new Text(theme.fg("warning", "  ⚠ additional tool metadata is available when expanded"), 0, 0));
		return container;
	}

	if (output.summary) container.addChild(new Text(theme.fg(isError ? "error" : "success", `  ${output.summary}`), 0, 0));
	if (output.text && toolName === "bash") {
		container.addChild(new Text(displayOutput(toolName, output), 0, 0));
	} else if (output.text && toolName === "lsp_diagnostics") {
		container.addChild(new Text(output.text, 0, 0));
	} else if (output.text && output.kind === "code") {
		container.addChild(new Text(displayCode(output), 0, 0));
	} else if (output.text) {
		container.addChild(new Markdown(markdownContent(output), 0, 0, getMarkdownTheme()));
	}
	for (const note of output.notes) container.addChild(new Text(theme.fg("warning", `  ⚠ ${note}`), 0, 0));
	if (output.truncated) container.addChild(new Text(theme.fg("warning", "  ⚠ output truncated for display"), 0, 0));
	if (!output.text && !output.summary) container.addChild(new Text(theme.fg("dim", "  No text output"), 0, 0));
	return container;
}

/** Renderer factory for custom tool definitions without their own result renderer. */
export function createToolResultRenderer(toolName: string, config: ToolResultRendererConfig = {}) {
	return (
		result: ToolResultLike,
		options: ToolResultViewOptions,
		theme: Theme,
		context: ToolResultViewContext,
	): Component => renderToolResult(toolName, result, options, theme, context, config);
}
