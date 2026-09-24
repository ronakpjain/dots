import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";

export type ToolOutputKind = "text" | "markdown" | "code" | "json" | "list";

export interface ToolContentBlock {
	type?: string;
	text?: string;
	mimeType?: string;
}

export interface ToolOutputContext {
	toolName?: string;
	args?: unknown;
	details?: unknown;
}

export interface FormattedToolOutput {
	text: string;
	kind: ToolOutputKind;
	truncated: boolean;
	title?: string;
	summary?: string;
	language?: string;
	notes: string[];
}

const TRUNCATION_MARKER = "… [truncated]";

/** Keep text blocks and describe other content without exposing encoded media payloads. */
export function toolResultContentText(content: string | readonly ToolContentBlock[] | null | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block?.type === "text" && typeof block.text === "string") return block.text;
			if (block?.type === "image") {
				const mimeType = typeof block.mimeType === "string" ? sanitizeToolOutput(block.mimeType).replace(/\s+/g, " ").trim() : "";
				return `[image${mimeType ? ` · ${mimeType}` : ""} content]`;
			}
			const type = typeof block?.type === "string" ? sanitizeToolOutput(block.type).replace(/\s+/g, " ").trim() : "non-text";
			return `[${type || "non-text"} content]`;
		})
		.join("\n");
}

/** Remove terminal control sequences before results are styled or wrapped by the TUI. */
export function sanitizeToolOutput(text: string): string {
	return text
		.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
		.replace(/\x1B[P^_].*?\x1B\\/gs, "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u009B[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B[@-_]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			return asRecord(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	return asRecord(value);
}

function stringField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const safe = sanitizeToolOutput(value).replace(/\s+/g, " ").trim();
	return safe || undefined;
}

function makeTitle(toolName: string | undefined, args: Record<string, unknown> | undefined): string | undefined {
	if (!toolName) return undefined;
	const path = stringField(args?.path);
	const pattern = stringField(args?.pattern);
	const position =
		typeof args?.line === "number"
				? `:${args.line + 1}${typeof args.character === "number" ? `:${args.character + 1}` : ""}`
				: "";
	const target =
		toolName === "grep" || toolName === "find"
			? [pattern, path].filter(Boolean).join(" · ")
			: toolName?.startsWith("lsp_")
				? path ? `${path}${position}` : undefined
				: path;
	if (!target) return undefined;
	return target.length > 120 ? `${target.slice(0, 119)}…` : target;
}

function isJsonCandidate(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isMarkdownLike(text: string): boolean {
	return /^\s{0,3}(?:#{1,6}\s|>\s|[-*+]\s|\d+\.\s|\|.*\|)|```|~~~|\[[^\]]+\]\([^)]+\)/m.test(text);
}

function isUnifiedDiff(text: string): boolean {
	return /^diff --git .+$/m.test(text) || /^--- .+\n\+\+\+ .+$/m.test(text);
}

function isBashScript(text: string): boolean {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.some((line) => /^#!.*\b(?:ba)?sh\b/.test(line))) return true;
	const shellSyntax = /^(?:set\s+-[a-zA-Z]+|export\s+[A-Za-z_]\w*=|(?:if|elif|then|fi|for|while|do|done|case|esac)\b|(?:function\s+)?[A-Za-z_]\w*\s*\(\s*\)|\[\[|source\s+)/;
	return lines.filter((line) => shellSyntax.test(line)).length >= 2;
}

function isCodeLike(text: string): boolean {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.length < 2) return false;
	const codeLine = /^(?:#!|(?:import|export|const|let|var|function|class|type|interface|def|async)\b|(?:if|for|while|return)\s*\(?|[{}\[\];]\s*$|at .+\(.+:\d+:\d+\)|Traceback \()/;
	const matching = lines.filter((line) => codeLine.test(line)).length;
	return matching >= 2 || matching / lines.length >= 0.35;
}

function formatGrepMatches(text: string): { text: string; count: number } | undefined {
	const lines = text.split("\n");
	const matches: Array<{ path: string; line: string; isMatch: boolean; content: string }> = [];
	const notices: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const match = line.match(/^(.+?)(:|-)(\d+)(:|-)(?:\s?)(.*)$/);
		if (match) {
			matches.push({ path: match[1]!, line: match[3]!, isMatch: match[2] === ":", content: match[5]! });
		} else if (/^\[.*(?:limit|truncat).*\]$/i.test(line.trim())) {
			notices.push(line.trim());
		} else {
			return undefined;
		}
	}
	if (matches.length === 0) return undefined;
	const groups = new Map<string, typeof matches>();
	for (const match of matches) {
		const group = groups.get(match.path) ?? [];
		group.push(match);
		groups.set(match.path, group);
	}
	const formatted: string[] = [];
	for (const [path, group] of groups) {
		if (formatted.length) formatted.push("");
		formatted.push(`▸ ${path}`);
		for (const match of group) formatted.push(`  ${match.isMatch ? "●" : "·"} ${match.line}  ${match.content}`);
	}
	if (notices.length) formatted.push("", ...notices);
	return { text: formatted.join("\n"), count: matches.filter((match) => match.isMatch).length };
}

function formatList(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => (/^(?:[-*+]\s|•\s|\[.*\])/.test(line) ? line : `• ${line}`))
		.join("\n");
}

function formatQuestionOutput(details: Record<string, unknown> | undefined): string | undefined {
	if (!Array.isArray(details?.answers)) return undefined;
	const answers = details.answers;
	const sections = answers.map((item, index) => {
		const answer = asRecord(item);
		const question = stringField(answer?.question) ?? `Question ${index + 1}`;
		const answerText = typeof answer?.answer === "string" ? sanitizeToolOutput(answer.answer).trim() || "(no answer)" : "(no answer)";
		const id = stringField(answer?.id);
		return `### ${index + 1}. ${question}${id ? ` · ${id}` : ""}\n\n${answerText}`;
	});
	if (details.cancelled === true) sections.unshift(`> Question flow cancelled after ${answers.length} answer(s).`);
	return sections.join("\n\n");
}

function formatLspOutput(toolName: string, text: string): string {
	const lines = text.split("\n");
	const heading = lines[0]?.trim();
	if (!heading) return text;
	if (toolName === "lsp_diagnostics" && /\d+ issue\(s\)/.test(heading)) {
		const diagnostics: Array<{ location: string; message: string }> = [];
		for (const rawLine of lines.slice(1)) {
			const line = rawLine.trim();
			if (!line) continue;
			const match = line.match(/^((?:Error|Warning|Info|Hint) L\d+(?::\d+)?):\s*(.*)$/);
			if (match) {
				diagnostics.push({ location: match[1]!, message: match[2]! });
			} else {
				const previous = diagnostics[diagnostics.length - 1];
				if (previous) previous.message += ` ${line}`;
				else diagnostics.push({ location: "Issue", message: line });
			}
		}
		return [
			heading,
			"",
			...diagnostics.map(({ location, message }) =>
				`• ${location}: ${message.replace(/\s*\n\s*/g, " ").replace(/`([^`\n]+)`/g, "$1")}`,
			),
		].join("\n");
	}
	const normalizedLines = lines.map((line) => line.trim()).filter(Boolean);
	const items = normalizedLines.slice(1);
	if (toolName === "lsp_symbols" && /^Symbols \(\d+\)/.test(heading)) {
		return [`**${heading}**`, "", ...items.map((line) => `- ${line}`)].join("\n");
	}
	if (toolName === "lsp_references" && /^Found \d+ reference/.test(heading)) {
		return [`**${heading}**`, "", ...items.map((line) => `- ${line}`)].join("\n");
	}
	if (toolName === "lsp_definition" && heading === "Definition(s):") {
		return [`**${heading}**`, "", ...items.map((line) => `- ${line}`)].join("\n");
	}
	return text;
}

function toolNotes(toolName: string | undefined, details: Record<string, unknown> | undefined): string[] {
	if (!toolName || !details) return [];
	const notes: string[] = [];
	const truncation = asRecord(details.truncation);
	if (truncation?.truncated === true) {
		const by = stringField(truncation.truncatedBy);
		const totalLines = typeof truncation.totalLines === "number" ? truncation.totalLines : undefined;
		const outputLines = typeof truncation.outputLines === "number" ? truncation.outputLines : undefined;
		const totalBytes = typeof truncation.totalBytes === "number" ? truncation.totalBytes : undefined;
		const outputBytes = typeof truncation.outputBytes === "number" ? truncation.outputBytes : undefined;
		const counts = [
			totalLines !== undefined && outputLines !== undefined ? `${outputLines}/${totalLines} lines` : undefined,
			totalBytes !== undefined && outputBytes !== undefined ? `${outputBytes}/${totalBytes} bytes` : undefined,
		].filter(Boolean);
		notes.push(`Tool output truncated${by ? ` by ${by} limit` : ""}${counts.length ? ` (${counts.join(" · ")})` : ""}`);
	}
	if (toolName === "grep") {
		if (typeof details.matchLimitReached === "number") notes.push(`Match limit reached: ${details.matchLimitReached}`);
		if (details.linesTruncated === true) notes.push("Some matching lines were shortened; use read to see full lines");
	}
	if (toolName === "find" && typeof details.resultLimitReached === "number") {
		notes.push(`Result limit reached: ${details.resultLimitReached}`);
	}
	if (toolName === "ls" && typeof details.entryLimitReached === "number") {
		notes.push(`Entry limit reached: ${details.entryLimitReached}`);
	}
	if (toolName === "bash") {
		const fullOutputPath = stringField(details.fullOutputPath);
		if (fullOutputPath) notes.push(`Full output saved to ${fullOutputPath}`);
	}
	if (toolName === "edit" && typeof details.firstChangedLine === "number") {
		notes.push(`First changed line: ${details.firstChangedLine}`);
	}
	return notes;
}

function truncateUtf8(text: string, maxBytes: number): string {
	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	const includeMarker = maxBytes >= markerBytes;
	const contentLimit = includeMarker ? maxBytes - markerBytes : maxBytes;
	let used = 0;
	let content = "";
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (used + size > contentLimit) break;
		content += character;
		used += size;
	}
	return includeMarker ? `${content}${TRUNCATION_MARKER}` : content;
}

/** Normalize, classify, and byte-bound a tool result while retaining allowlisted metadata. */
export function formatToolOutput(
	content: string | readonly ToolContentBlock[],
	maxBytes: number,
	context: ToolOutputContext = {},
): FormattedToolOutput {
	const args = parseArgs(context.args);
	const details = asRecord(context.details);
	const toolName = context.toolName;
	let normalized = sanitizeToolOutput(toolResultContentText(content));
	// Bound expensive JSON parsing and tool-specific formatting before display truncation.
	const processingCap = Math.max(1, Math.min(160_000, maxBytes * 4));
	const inputTruncated = Buffer.byteLength(normalized, "utf8") > processingCap;
	if (inputTruncated) normalized = truncateUtf8(normalized, processingCap);
	let summary: string | undefined;
	let kind: ToolOutputKind = "text";
	const title = makeTitle(toolName, args);

	if (toolName === "edit" && typeof details?.diff === "string" && details.diff.trim()) {
		summary = normalized.trim() || "File updated";
		normalized = sanitizeToolOutput(details.diff);
		kind = "code";
	} else if (toolName === "question") {
		const formatted = formatQuestionOutput(details);
		if (formatted) {
			normalized = formatted;
			kind = "markdown";
		}
	} else if (toolName === "grep") {
		const grep = formatGrepMatches(normalized);
		if (grep) {
			normalized = grep.text;
			kind = "code";
		}
	} else if (toolName?.startsWith("lsp_")) {
		const formatted = formatLspOutput(toolName, normalized);
		if (formatted !== normalized) {
			normalized = formatted;
			kind = toolName === "lsp_diagnostics" ? "text" : "markdown";
		}
	} else if (toolName === "find" || toolName === "ls") {
		const empty = toolName === "find" ? /^No files found/i.test(normalized.trim()) : /^\(empty directory\)$/i.test(normalized.trim());
		if (!empty && normalized.trim()) {
			normalized = formatList(normalized);
			kind = "list";
		}
	} else if (toolName === "write") {
		summary = normalized.trim() || "File written successfully";
		normalized = "";
	}

	if (kind === "text" && toolName !== "lsp_diagnostics") {
		if (isJsonCandidate(normalized)) {
			kind = "json";
			try {
				normalized = JSON.stringify(JSON.parse(normalized), null, 2);
			} catch {
				// Keep malformed/partial JSON readable rather than failing rendering.
			}
		} else if (toolName === "bash" && (isBashScript(normalized) || isUnifiedDiff(normalized))) {
			kind = "code";
		} else if (isMarkdownLike(normalized)) {
			kind = "markdown";
		} else if (toolName === "read" && !/\.(?:md|mdx|markdown)$/i.test(stringField(args?.path) ?? "")) {
			kind = "code";
		} else if (isCodeLike(normalized)) {
			kind = "code";
		}
	}

	const language =
		kind === "code"
			? toolName === "read"
				? getLanguageFromPath(stringField(args?.path) ?? "")
				: toolName === "bash" && isBashScript(normalized)
					? "bash"
					: undefined
		: undefined;
	const summaryTruncated = summary !== undefined && Buffer.byteLength(summary, "utf8") > maxBytes;
	if (summaryTruncated) summary = truncateUtf8(summary ?? "", maxBytes);
	const output = Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : truncateUtf8(normalized, maxBytes);
	return {
		text: output,
		kind,
		truncated: inputTruncated || output !== normalized || summaryTruncated,
		title,
		summary,
		language,
		notes: toolNotes(toolName, details),
	};
}
