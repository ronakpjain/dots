import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getWorkMode, type WorkMode } from "./work-mode/state.ts";

export type VimMode = "INSERT" | "NORMAL" | "VISUAL" | "VISUAL_LINE";
export type VimSelectionKind = "characterwise" | "linewise";

export function workModeIndicator(mode: WorkMode): { label: string; color: string } {
	return mode === "orchestration"
		? { label: " ORCHESTRATION ", color: "\x1b[1;33m" }
		: { label: " BUILD ", color: "\x1b[1;34m" };
}

export interface VimSelection {
	anchor: VimCursor;
	active: VimCursor;
	kind: VimSelectionKind;
}

export interface VimRegister {
	text: string;
	kind: VimSelectionKind;
}

export interface VimRange {
	start: number;
	end: number;
}
export type VimMotion = "h" | "j" | "k" | "l" | "w" | "b" | "e" | "0" | "^" | "$" | "gg" | "G";
type VimDeleteMotion = "x" | "X" | "D" | "C" | "d" | "w" | "b" | "e" | "0" | "$" | "G";
const MAX_VIM_COUNT = 1_000_000;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

export interface VimCursor {
	line: number;
	col: number;
}

/**
 * Counts apply to motions, operators, and open-line commands. Counted insert
 * transitions enter INSERT once; repeating the inserted text is intentionally
 * not emulated.
 */
export type VimCommand =
	| { kind: "motion"; motion: VimMotion; count: number }
	| { kind: "insert-mode"; action: "i" | "a" | "I" | "A"; count: number }
	| { kind: "open-line"; action: "o" | "O"; count: number }
	| { kind: "delete"; motion: VimDeleteMotion; count: number }
	| { kind: "change"; motion: "w" | "$"; count: number }
	| { kind: "replace"; char: string; count: number }
	| { kind: "undo"; count: number }
	| { kind: "visual-toggle"; mode: "VISUAL" | "VISUAL_LINE" }
	| { kind: "paste"; after: boolean };

export interface VimMutation {
	lines: string[];
	cursor: VimCursor;
	mode?: VimMode;
	register?: VimRegister;
}

export interface VimSnapshot {
	text: string;
	cursor: VimCursor;
}

export interface VimUndoState {
	activeInsert?: VimSnapshot;
	history: VimSnapshot[];
}

export function beginVimInsertTransaction(state: VimUndoState, snapshot: VimSnapshot): VimUndoState {
	return state.activeInsert ? state : { ...state, activeInsert: snapshot };
}

export function commitVimInsertTransaction(state: VimUndoState): VimUndoState {
	if (!state.activeInsert) return state;
	return { history: [...state.history, state.activeInsert], activeInsert: undefined };
}

export function recordVimMutation(state: VimUndoState, snapshot: VimSnapshot): VimUndoState {
	const committed = commitVimInsertTransaction(state);
	return { history: [...committed.history, snapshot], activeInsert: undefined };
}

export function takeVimUndo(state: VimUndoState): { state: VimUndoState; snapshot?: VimSnapshot } {
	const committed = commitVimInsertTransaction(state);
	if (committed.history.length === 0) return { state: committed };
	const history = committed.history.slice(0, -1);
	return { state: { history }, snapshot: committed.history[committed.history.length - 1] };
}

export type VimParseResult = VimCommand | "pending" | null;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(text: string): string[] {
	return [...graphemeSegmenter.segment(text)].map((part) => part.segment);
}

function boundaries(text: string): number[] {
	return [...graphemeSegmenter.segment(text)].map((part) => part.index).concat(text.length);
}

function isWhitespace(grapheme: string): boolean {
	return /^\s$/u.test(grapheme);
}

function isWordGrapheme(grapheme: string): boolean {
	return /[\p{Letter}\p{Number}_]/u.test(grapheme);
}

function clampCursor(lines: string[], cursor: VimCursor): VimCursor {
	const line = Math.max(0, Math.min(lines.length - 1, cursor.line));
	const lineBoundaries = boundaries(lines[line] ?? "");
	const col = Math.max(0, Math.min(lineBoundaries[lineBoundaries.length - 1] ?? 0, cursor.col));
	let snapped = 0;
	for (const boundary of lineBoundaries) {
		if (boundary > col) break;
		snapped = boundary;
	}
	return { line, col: snapped };
}

function clampNormalCursor(lines: string[], cursor: VimCursor): VimCursor {
	const clamped = clampCursor(lines, cursor);
	const line = lines[clamped.line] ?? "";
	if (!line) return clamped;
	const parts = graphemes(line);
	const lineBoundaries = boundaries(line);
	if (clamped.col >= line.length) return { line: clamped.line, col: lineBoundaries[parts.length - 1]! };
	return clamped;
}

function moveOne(lines: string[], cursor: VimCursor, direction: 1 | -1): VimCursor {
	const line = lines[cursor.line] ?? "";
	const lineBounds = boundaries(line);
	const index = Math.max(0, lineBounds.indexOf(cursor.col));
	if (direction > 0) {
		if (index < lineBounds.length - 1) return { line: cursor.line, col: lineBounds[index + 1]! };
		if (cursor.line < lines.length - 1) return { line: cursor.line + 1, col: 0 };
	} else {
		if (index > 0) return { line: cursor.line, col: lineBounds[index - 1]! };
		if (cursor.line > 0) {
			const previous = lines[cursor.line - 1] ?? "";
			return { line: cursor.line - 1, col: previous.length };
		}
	}
	return cursor;
}

function moveHorizontal(lines: string[], cursor: VimCursor, direction: 1 | -1, count: number): VimCursor {
	const line = lines[cursor.line] ?? "";
	const lineBounds = boundaries(line);
	const parts = graphemes(line);
	const at = Math.max(0, lineBounds.indexOf(cursor.col));
	const last = Math.max(0, parts.length - 1);
	const target = direction > 0 ? Math.min(last, at + count) : Math.max(0, at - count);
	return { line: cursor.line, col: lineBounds[target] ?? 0 };
}

function firstNonWhitespace(line: string): number {
	const parts = [...graphemeSegmenter.segment(line)];
	return parts.find((part) => !isWhitespace(part.segment))?.index ?? 0;
}

function moveWordForward(lines: string[], cursor: VimCursor): VimCursor {
	let result = cursor;
	let line = lines[result.line] ?? "";
	let parts = graphemes(line);
	let index = boundaries(line).indexOf(result.col);
	if (index < 0) index = parts.length;
	if (index >= parts.length) {
		if (result.line < lines.length - 1)
			return { line: result.line + 1, col: firstNonWhitespace(lines[result.line + 1] ?? "") };
		return result;
	}
	const word = isWordGrapheme(parts[index]!);
	while (index < parts.length && !isWhitespace(parts[index]!) && isWordGrapheme(parts[index]!) === word) index++;
	while (index < parts.length && isWhitespace(parts[index]!)) index++;
	if (index < parts.length) return { line: result.line, col: boundaries(line)[index]! };
	if (result.line < lines.length - 1)
		return { line: result.line + 1, col: firstNonWhitespace(lines[result.line + 1] ?? "") };
	return { line: result.line, col: parts.length ? boundaries(line)[parts.length - 1]! : 0 };
}

function moveWordBackward(lines: string[], cursor: VimCursor): VimCursor {
	let line = lines[cursor.line] ?? "";
	let parts = graphemes(line);
	let index = boundaries(line).indexOf(cursor.col);
	if (index < 0) index = parts.length;
	index--;
	if (index < 0) {
		if (cursor.line === 0) return { line: 0, col: 0 };
		line = lines[cursor.line - 1] ?? "";
		parts = graphemes(line);
		index = parts.length - 1;
	}
	while (index > 0 && isWhitespace(parts[index]!)) index--;
	if (isWordGrapheme(parts[index]!)) {
		while (index > 0 && isWordGrapheme(parts[index - 1]!)) index--;
	} else if (index > 0 && !isWhitespace(parts[index - 1]!)) {
		index--;
	}
	return { line: cursor.line - (cursor.col === 0 ? 1 : 0), col: boundaries(line)[index] ?? 0 };
}

function moveWordEnd(lines: string[], cursor: VimCursor): VimCursor {
	let result = cursor;
	let line = lines[result.line] ?? "";
	let parts = graphemes(line);
	let index = boundaries(line).indexOf(result.col);
	if (index < 0) index = parts.length;
	if (
		index < parts.length &&
		!isWhitespace(parts[index]!) &&
		(index + 1 === parts.length || isWhitespace(parts[index + 1]!))
	) {
		index++;
	}
	while (index < parts.length && isWhitespace(parts[index]!)) index++;
	if (index >= parts.length) {
		if (result.line < lines.length - 1) return moveWordEnd(lines, { line: result.line + 1, col: 0 });
		return { line: result.line, col: parts.length ? boundaries(line)[parts.length - 1]! : 0 };
	}
	const word = isWordGrapheme(parts[index]!);
	while (index + 1 < parts.length && !isWhitespace(parts[index + 1]!) && isWordGrapheme(parts[index + 1]!) === word)
		index++;
	return { line: result.line, col: boundaries(line)[index] ?? line.length };
}

function gTargetLine(lines: string[], count: number): number {
	return count === 0 ? lines.length - 1 : Math.max(0, Math.min(lines.length - 1, count - 1));
}

function moveMotion(lines: string[], cursor: VimCursor, motion: VimMotion, count: number): VimCursor {
	let result = clampCursor(lines, cursor);
	if (motion === "0") return { line: result.line, col: 0 };
	if (motion === "^") return { line: result.line, col: firstNonWhitespace(lines[result.line] ?? "") };
	if (motion === "$") {
		const parts = graphemes(lines[result.line] ?? "");
		return { line: result.line, col: parts.length ? boundaries(lines[result.line]!)[parts.length - 1]! : 0 };
	}
	if (motion === "gg") return { line: Math.min(lines.length - 1, count > 1 ? count - 1 : 0), col: 0 };
	if (motion === "G") {
		const line = gTargetLine(lines, count);
		const parts = graphemes(lines[line] ?? "");
		return { line, col: parts.length ? boundaries(lines[line]!)[parts.length - 1]! : 0 };
	}
	if (motion === "h") return moveHorizontal(lines, result, -1, count);
	if (motion === "l") return moveHorizontal(lines, result, 1, count);
	if (motion === "j" || motion === "k") {
		const line = Math.max(0, Math.min(lines.length - 1, result.line + (motion === "j" ? count : -count)));
		const target = graphemes(lines[line] ?? "");
		if (target.length === 0) return { line, col: 0 };
		const sourceIndex = Math.max(0, boundaries(lines[result.line] ?? "").indexOf(result.col));
		return { line, col: boundaries(lines[line] ?? "")[Math.min(sourceIndex, target.length - 1)] ?? 0 };
	}
	for (let index = 0; index < count; index++) {
		result =
			motion === "w"
				? moveWordForward(lines, result)
				: motion === "b"
					? moveWordBackward(lines, result)
					: moveWordEnd(lines, result);
	}
	return result;
}

function absoluteOffset(lines: string[], cursor: VimCursor): number {
	return lines.slice(0, cursor.line).reduce((total, line) => total + line.length + 1, 0) + cursor.col;
}

/** Return the inclusive characterwise or complete-linewise range of a selection. */
export function getVimSelectionRange(lines: string[], selection: VimSelection): VimRange {
	const safeAnchor = clampNormalCursor(lines, selection.anchor);
	const safeActive = clampNormalCursor(lines, selection.active);
	if (selection.kind === "linewise") {
		const first = Math.min(safeAnchor.line, safeActive.line);
		const last = Math.max(safeAnchor.line, safeActive.line);
		const start = absoluteOffset(lines, { line: first, col: 0 });
		const endLine = lines[last] ?? "";
		return {
			start,
			end: absoluteOffset(lines, { line: last, col: endLine.length }) + (last < lines.length - 1 ? 1 : 0),
		};
	}
	const anchor = absoluteOffset(lines, safeAnchor);
	const active = absoluteOffset(lines, safeActive);
	const start = Math.min(anchor, active);
	const endCursor = anchor >= active ? safeAnchor : safeActive;
	const endLine = lines[endCursor.line] ?? "";
	const endParts = graphemes(endLine);
	const endIndex = Math.max(0, boundaries(endLine).indexOf(endCursor.col));
	// A normal cursor identifies a grapheme, not a UTF-16 code unit.
	const end = absoluteOffset(lines, endCursor) + (endParts[endIndex]?.length ?? 0);
	return { start, end: Math.max(start, end) };
}

export function getVimSelectionText(lines: string[], selection: VimSelection): string {
	if (selection.kind === "linewise") {
		const first = Math.min(selection.anchor.line, selection.active.line);
		const last = Math.max(selection.anchor.line, selection.active.line);
		return lines.slice(first, last + 1).join("\n");
	}
	const range = getVimSelectionRange(lines, selection);
	return lines.join("\n").slice(range.start, range.end);
}

function linewiseOperationRange(lines: string[], selection: VimSelection): VimRange {
	const first = Math.min(selection.anchor.line, selection.active.line);
	const last = Math.max(selection.anchor.line, selection.active.line);
	let start = absoluteOffset(lines, { line: first, col: 0 });
	let end = absoluteOffset(lines, { line: last, col: (lines[last] ?? "").length });
	if (last < lines.length - 1) end++;
	else if (first > 0) start--;
	return { start, end };
}

function registerForSelection(lines: string[], selection: VimSelection): VimRegister {
	return { kind: selection.kind, text: getVimSelectionText(lines, selection) };
}

function selectionToMutation(
	lines: string[],
	selection: VimSelection,
	action: "yank" | "delete" | "change",
): VimMutation {
	const register = registerForSelection(lines, selection);
	if (action === "yank")
		return { lines: [...lines], cursor: clampNormalCursor(lines, selection.active), mode: "NORMAL", register };
	const range =
		selection.kind === "linewise"
			? linewiseOperationRange(lines, selection)
			: getVimSelectionRange(lines, selection);
	const mutation = deleteRange(lines, range.start, range.end);
	mutation.register = register;
	mutation.mode = action === "change" ? "INSERT" : "NORMAL";
	return mutation;
}

/** Apply a visual operator without depending on an editor implementation. */
export function applyVimVisualCommand(
	inputLines: string[],
	inputCursor: VimCursor,
	selection: VimSelection,
	action: "yank" | "delete" | "change",
): VimMutation {
	const lines = inputLines.length ? [...inputLines] : [""];
	return selectionToMutation(
		lines,
		{
			...selection,
			anchor: clampNormalCursor(lines, selection.anchor),
			active: clampNormalCursor(lines, inputCursor),
		},
		action,
	);
}

function cursorAtOffset(text: string, offset: number): VimCursor {
	const safeOffset = Math.max(0, Math.min(text.length, offset));
	const before = text.slice(0, safeOffset);
	const line = before.split("\n").length - 1;
	const col = before.slice(before.lastIndexOf("\n") + 1).length;
	return { line, col };
}

function deleteRange(lines: string[], start: number, end: number): VimMutation {
	const text = lines.join("\n");
	const nextText = text.slice(0, start) + text.slice(end);
	const nextLines = nextText.split("\n");
	return { lines: nextLines, cursor: clampNormalCursor(nextLines, cursorAtOffset(nextText, start)) };
}

function lineDeleteRange(lines: string[], cursor: VimCursor, count: number): [number, number] {
	const startLine = cursor.line;
	const endLine = Math.min(lines.length - 1, startLine + count - 1);
	let start = absoluteOffset(lines, { line: startLine, col: 0 });
	let end = absoluteOffset(lines, { line: endLine, col: (lines[endLine] ?? "").length });
	if (endLine < lines.length - 1) end++;
	else if (startLine > 0) start--;
	return [start, end];
}

function dGDeleteRange(lines: string[], cursor: VimCursor, targetLine: number): [number, number] {
	const firstLine = Math.min(cursor.line, targetLine);
	const lastLine = Math.max(cursor.line, targetLine);
	let start = absoluteOffset(lines, { line: firstLine, col: 0 });
	let end = absoluteOffset(lines, { line: lastLine, col: (lines[lastLine] ?? "").length });
	if (lastLine < lines.length - 1) end++;
	else if (firstLine > 0) start--;
	return [start, end];
}

function parseCount(sequence: string, start: number): { count: number; index: number } {
	let count = 0;
	let index = start;
	if (index < sequence.length && /[1-9]/u.test(sequence[index]!)) {
		count = Number(sequence[index]);
		index++;
		while (index < sequence.length && /[0-9]/u.test(sequence[index]!)) {
			count = Math.min(MAX_VIM_COUNT, count * 10 + Number(sequence[index]));
			index++;
		}
	}
	return { count: count || 1, index };
}

function multiplyCounts(outer: number, local: number): number {
	return outer >= Math.ceil(MAX_VIM_COUNT / local) ? MAX_VIM_COUNT : Math.min(MAX_VIM_COUNT, outer * local);
}

/** Parse one complete Vim command. A partial multi-key command returns "pending". */
export function parseVimCommand(sequence: string): VimParseResult {
	if (!sequence) return null;
	const outer = parseCount(sequence, 0);
	const count = outer.count;
	const hasOuterCount = outer.index > 0;
	const key = sequence.slice(outer.index);
	if (!key) return "pending";
	if (key === "0" && outer.index === 0) return { kind: "motion", motion: "0", count: 1 };
	if (key === "v") return { kind: "visual-toggle", mode: "VISUAL" };
	if (key === "V") return { kind: "visual-toggle", mode: "VISUAL_LINE" };
	if (key === "p" || key === "P") return { kind: "paste", after: key === "p" };
	if (key === "g") return "pending";
	if (key === "gg") return { kind: "motion", motion: "gg", count };
	if (/^[hjklwbe0^$G]$/u.test(key))
		return { kind: "motion", motion: key as VimMotion, count: key === "G" && !hasOuterCount ? 0 : count };
	if (/^[iaIA]$/u.test(key)) return { kind: "insert-mode", action: key as "i" | "a" | "I" | "A", count };
	if (key === "o" || key === "O") return { kind: "open-line", action: key, count };
	if (key === "u") return { kind: "undo", count };
	if (key === "x" || key === "X" || key === "D" || key === "C") return { kind: "delete", motion: key, count };
	if (key.startsWith("d") || key.startsWith("c")) {
		const operator = key[0]!;
		const local = parseCount(key, 1);
		const motion = key.slice(local.index);
		if (!motion) return "pending";
		if (local.index === 1 && motion === "") return "pending";
		if (local.index > 1 && motion.length === 0) return "pending";
		if (operator === "d" && /^[dwebe0$G]$/u.test(motion)) {
			const hasLocalCount = local.index > 1;
			const effectiveCount =
				motion === "G"
					? !hasOuterCount && !hasLocalCount
						? 0
						: multiplyCounts(hasOuterCount ? count : 1, hasLocalCount ? local.count : 1)
					: multiplyCounts(count, local.count);
			return { kind: "delete", motion: motion as VimDeleteMotion, count: effectiveCount };
		}
		if (operator === "c" && /^[w$]$/u.test(motion)) {
			return { kind: "change", motion: motion as "w" | "$", count: multiplyCounts(count, local.count) };
		}
		// Keep an operator-local count pending while the user is still typing it.
		if (local.index > 1 && /^[1-9]*$/u.test(motion)) return "pending";
		return null;
	}
	if (key === "r") return "pending";
	if (key.startsWith("r")) {
		const char = [...graphemeSegmenter.segment(key.slice(1))][0]?.segment;
		if (!char || key.slice(1) !== char) return null;
		return { kind: "replace", char, count };
	}
	return null;
}

/** Apply a parsed command without editor/UI state. */
export function applyVimCommand(inputLines: string[], inputCursor: VimCursor, command: VimCommand): VimMutation {
	const lines = inputLines.length ? [...inputLines] : [""];
	const cursor = clampCursor(lines, inputCursor);
	if (command.kind === "motion") return { lines, cursor: moveMotion(lines, cursor, command.motion, command.count) };
	if (command.kind === "insert-mode") {
		let next = cursor;
		if (command.action === "a") {
			const line = lines[next.line] ?? "";
			const lineBounds = boundaries(line);
			const at = Math.max(0, lineBounds.indexOf(next.col));
			next = { line: next.line, col: lineBounds[Math.min(lineBounds.length - 1, at + 1)] ?? line.length };
		}
		if (command.action === "I") next = { line: next.line, col: firstNonWhitespace(lines[next.line] ?? "") };
		if (command.action === "A") next = { line: next.line, col: (lines[next.line] ?? "").length };
		return { lines, cursor: next, mode: "INSERT" };
	}
	if (command.kind === "open-line") {
		const line = cursor.line + (command.action === "o" ? 1 : 0);
		lines.splice(line, 0, ...Array.from({ length: command.count }, () => ""));
		return { lines, cursor: { line, col: 0 }, mode: "INSERT" };
	}
	if (command.kind === "undo") return { lines, cursor };
	if (command.kind === "visual-toggle") return { lines, cursor, mode: command.mode };
	if (command.kind === "paste") return { lines, cursor };
	if (command.kind === "replace") {
		const line = lines[cursor.line] ?? "";
		const parts = graphemes(line);
		const at = boundaries(line).indexOf(cursor.col);
		const amount = Math.min(command.count, Math.max(0, parts.length - at));
		parts.splice(at, amount, ...Array.from({ length: amount }, () => command.char));
		lines[cursor.line] = parts.join("");
		return { lines, cursor: clampCursor(lines, cursor) };
	}
	let start = absoluteOffset(lines, cursor);
	let end = start;
	const deleteMotion = command.kind === "delete" ? command.motion : command.motion;
	if (deleteMotion === "d") {
		[start, end] = lineDeleteRange(lines, cursor, command.count);
	} else if (deleteMotion === "x") {
		const line = lines[cursor.line] ?? "";
		const parts = graphemes(line);
		const at = boundaries(line).indexOf(cursor.col);
		end = absoluteOffset(lines, {
			line: cursor.line,
			col: boundaries(line)[Math.min(parts.length, at + command.count)] ?? line.length,
		});
	} else if (deleteMotion === "X") {
		const line = lines[cursor.line] ?? "";
		const at = boundaries(line).indexOf(cursor.col);
		start = absoluteOffset(lines, {
			line: cursor.line,
			col: boundaries(line)[Math.max(0, at - command.count)] ?? 0,
		});
	} else if (deleteMotion === "D" || deleteMotion === "C" || deleteMotion === "$") {
		end = absoluteOffset(lines, { line: cursor.line, col: (lines[cursor.line] ?? "").length });
		if (deleteMotion === "D" || deleteMotion === "C") end = Math.max(start, end);
	} else if (deleteMotion === "G") {
		[start, end] = dGDeleteRange(lines, cursor, gTargetLine(lines, command.count));
	} else if (deleteMotion === "0") {
		start = absoluteOffset(lines, { line: cursor.line, col: 0 });
	} else {
		const changeWordAsEnd =
			command.kind === "change" &&
			deleteMotion === "w" &&
			!isWhitespace(
				graphemes(lines[cursor.line] ?? "")[boundaries(lines[cursor.line] ?? "").indexOf(cursor.col)] ?? "",
			);
		const target = moveMotion(lines, cursor, changeWordAsEnd ? "e" : (deleteMotion as VimMotion), command.count);
		const targetOffset = absoluteOffset(lines, target);
		if (targetOffset >= start) {
			end = targetOffset;
			if (deleteMotion === "e" || changeWordAsEnd || (deleteMotion === "w" && end === start))
				end = absoluteOffset(lines, moveOne(lines, target, 1));
		} else {
			start = targetOffset;
		}
	}
	const rangeStart = Math.min(start, end);
	const rangeEnd = Math.max(start, end);
	const linewise = deleteMotion === "d" || deleteMotion === "G";
	const registerFirstLine =
		deleteMotion === "G" ? Math.min(cursor.line, gTargetLine(lines, command.count)) : cursor.line;
	const registerLastLine =
		deleteMotion === "G"
			? Math.max(cursor.line, gTargetLine(lines, command.count))
			: Math.min(lines.length - 1, cursor.line + command.count - 1);
	const registerText = linewise
		? lines.slice(registerFirstLine, registerLastLine + 1).join("\n")
		: lines.join("\n").slice(rangeStart, rangeEnd);
	const mutation = deleteRange(lines, rangeStart, rangeEnd);
	if (rangeEnd > rangeStart)
		mutation.register = { text: registerText, kind: linewise ? "linewise" : "characterwise" };
	if (command.kind === "change" || deleteMotion === "C") {
		mutation.mode = "INSERT";
		mutation.cursor = clampCursor(mutation.lines, cursorAtOffset(mutation.lines.join("\n"), Math.min(start, end)));
	}
	return mutation;
}

function isEscape(data: string): boolean {
	return matchesKey(data, "escape");
}

function isDelegatedKey(data: string): boolean {
	return (
		data.length === 0 ||
		data.charCodeAt(0) < 32 ||
		data.startsWith("\x1b") ||
		data.includes("\r") ||
		data.includes("\n")
	);
}

function pastedCursor(lines: string[], endOffset: number, pastedText: string): VimCursor {
	const end = clampCursor(lines, cursorAtOffset(lines.join("\n"), endOffset));
	if (!pastedText) return clampNormalCursor(lines, end);
	const line = lines[end.line] ?? "";
	const lineBounds = boundaries(line);
	const index = Math.max(0, lineBounds.indexOf(end.col));
	if (index > 0) return { line: end.line, col: lineBounds[index - 1]! };
	if (end.line > 0) {
		const previous = lines[end.line - 1] ?? "";
		const previousBounds = boundaries(previous);
		return { line: end.line - 1, col: previousBounds[Math.max(0, previousBounds.length - 2)] ?? 0 };
	}
	return clampNormalCursor(lines, end);
}

function pasteRegister(lines: string[], cursor: VimCursor, register: VimRegister, after: boolean): VimMutation {
	const text = lines.join("\n");
	if (register.kind === "linewise") {
		const atLine = Math.max(0, Math.min(lines.length - 1, cursor.line)) + (after ? 1 : 0);
		const inserted = register.text.split("\n");
		lines.splice(atLine, 0, ...inserted);
		return { lines, cursor: { line: Math.min(lines.length - 1, atLine), col: 0 } };
	}
	const line = lines[cursor.line] ?? "";
	const parts = graphemes(line);
	const index = Math.max(0, boundaries(line).indexOf(cursor.col));
	const offset = absoluteOffset(lines, cursor) + (after && index < parts.length ? parts[index]!.length : 0);
	const nextText = text.slice(0, offset) + register.text + text.slice(offset);
	const nextLines = nextText.split("\n");
	return { lines: nextLines, cursor: pastedCursor(nextLines, offset + register.text.length, register.text) };
}

export interface VimPendingRoute {
	pending: string;
	delegate: boolean;
	command: VimParseResult;
}

export function routeVimPendingInput(pending: string, data: string): VimPendingRoute {
	if (isDelegatedKey(data) || isEscape(data)) return { pending: "", delegate: true, command: null };
	const next = pending + data;
	const command = parseVimCommand(next);
	if (command === "pending") return { pending: next, delegate: false, command };
	return { pending: "", delegate: false, command };
}

interface VimVisualLayoutRow {
	line: number;
	text: string;
	startCol: number;
	endCol: number;
	hasCursor: boolean;
	cursorPos?: number;
}

interface VimWrappedChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

// Keep this in step with pi-tui's wordWrapLine without reaching into Editor's
// private state. The editor's public package currently does not re-export that
// helper, so this deliberately uses only public width and grapheme primitives.
const cjkGrapheme =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

function wrapVimLine(line: string, maxWidth: number): VimWrappedChunk[] {
	if (!line || maxWidth <= 0 || visibleWidth(line) <= maxWidth)
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	const parts = graphemes(line);
	const starts = boundaries(line);
	const chunks: VimWrappedChunk[] = [];
	let currentWidth = 0;
	let chunkStart = 0;
	let wrapOpportunity = -1;
	let wrapOpportunityWidth = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!;
		const partStart = starts[index]!;
		const partWidth = visibleWidth(part);
		if (currentWidth + partWidth > maxWidth) {
			if (wrapOpportunity >= 0 && currentWidth - wrapOpportunityWidth + partWidth <= maxWidth) {
				chunks.push({
					text: line.slice(chunkStart, wrapOpportunity),
					startIndex: chunkStart,
					endIndex: wrapOpportunity,
				});
				chunkStart = wrapOpportunity;
				currentWidth -= wrapOpportunityWidth;
			} else if (chunkStart < partStart) {
				chunks.push({ text: line.slice(chunkStart, partStart), startIndex: chunkStart, endIndex: partStart });
				chunkStart = partStart;
				currentWidth = 0;
			}
			wrapOpportunity = -1;
		}
		if (partWidth > maxWidth) {
			const subChunks = wrapVimLine(part, maxWidth);
			for (const subChunk of subChunks.slice(0, -1)) {
				chunks.push({
					text: subChunk.text,
					startIndex: partStart + subChunk.startIndex,
					endIndex: partStart + subChunk.endIndex,
				});
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = partStart + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOpportunity = -1;
			continue;
		}
		currentWidth += partWidth;
		const next = parts[index + 1];
		if (next && isWhitespace(part) && !isWhitespace(next)) {
			wrapOpportunity = starts[index + 1]!;
			wrapOpportunityWidth = currentWidth;
		} else if (
			next &&
			!isWhitespace(part) &&
			!isWhitespace(next) &&
			(cjkGrapheme.test(part) || cjkGrapheme.test(next))
		) {
			wrapOpportunity = starts[index + 1]!;
			wrapOpportunityWidth = currentWidth;
		}
	}
	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
	return chunks;
}

function vimVisualLayout(lines: string[], layoutWidth: number, cursor: VimCursor): VimVisualLayoutRow[] {
	if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
		return [{ line: 0, text: "", startCol: 0, endCol: 0, hasCursor: true, cursorPos: 0 }];
	}
	const result: VimVisualLayoutRow[] = [];
	for (let line = 0; line < lines.length; line++) {
		const text = lines[line] ?? "";
		if (visibleWidth(text) <= layoutWidth) {
			result.push({
				line,
				text,
				startCol: 0,
				endCol: text.length,
				hasCursor: line === cursor.line,
				cursorPos: line === cursor.line ? cursor.col : undefined,
			});
			continue;
		}
		const chunks = wrapVimLine(text, layoutWidth);
		for (let index = 0; index < chunks.length; index++) {
			const chunk = chunks[index]!;
			const last = index === chunks.length - 1;
			const hasCursor =
				line === cursor.line &&
				(last ? cursor.col >= chunk.startIndex : cursor.col >= chunk.startIndex && cursor.col < chunk.endIndex);
			result.push({
				line,
				text: chunk.text,
				startCol: chunk.startIndex,
				endCol: chunk.endIndex,
				hasCursor,
				cursorPos: hasCursor
					? Math.min(Math.max(0, cursor.col - chunk.startIndex), chunk.text.length)
					: undefined,
			});
		}
	}
	return result;
}

function hasUnsafeHighlightText(lines: string[]): boolean {
	return lines.some((line) => /\[paste #\d+(?: \+\d+ lines| \d+ chars)?\]/u.test(line) || line.includes("\x1b"));
}

export class VimEditor extends CustomEditor {
	private mode: VimMode = "INSERT";
	private pending = "";
	private editorTheme: EditorTheme;
	private undoState: VimUndoState = { history: [] };
	private selection?: VimSelection;
	private register?: VimRegister;
	/** Mirrors Editor's private scroll offset so visual rows share its viewport. */
	private visualScrollOffset = 0;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.editorTheme = theme;
	}

	private moveTo(target: VimCursor): void {
		const wanted = clampCursor(this.getLines(), target);
		let guard = 0;
		while (guard++ < 10_000) {
			const current = this.getCursor();
			if (current.line === wanted.line && current.col === wanted.col) return;
			const before = `${current.line}:${current.col}`;
			if (current.line > wanted.line) super.handleInput("\x1b[A");
			else if (current.line < wanted.line) super.handleInput("\x1b[B");
			else if (current.col > wanted.col) super.handleInput("\x1b[D");
			else super.handleInput("\x1b[C");
			const after = this.getCursor();
			if (`${after.line}:${after.col}` === before) return;
		}
	}

	getMode(): VimMode {
		return this.mode;
	}
	getSelection(): VimSelection | undefined {
		return this.selection
			? { ...this.selection, anchor: { ...this.selection.anchor }, active: { ...this.selection.active } }
			: undefined;
	}
	getRegister(): VimRegister | undefined {
		return this.register ? { ...this.register } : undefined;
	}

	private clearVisual(): void {
		this.selection = undefined;
		this.mode = "NORMAL";
		this.pending = "";
	}

	private enterVisual(kind: VimSelectionKind): void {
		const cursor = clampNormalCursor(this.getLines(), this.getCursor());
		this.selection = { anchor: cursor, active: cursor, kind };
		this.mode = kind === "linewise" ? "VISUAL_LINE" : "VISUAL";
		this.pending = "";
		this.moveTo(cursor);
	}

	private applyVisual(action: "yank" | "delete" | "change"): void {
		if (!this.selection) return;
		const before: VimSnapshot = { text: this.getText(), cursor: this.getCursor() };
		const result = applyVimVisualCommand(this.getLines(), before.cursor, this.selection, action);
		if (action !== "yank") {
			this.undoState =
				action === "change"
					? beginVimInsertTransaction(this.undoState, before)
					: recordVimMutation(this.undoState, before);
			if (result.lines.join("\n") !== before.text) this.setText(result.lines.join("\n"));
		}
		if (result.register) this.register = result.register;
		this.selection = undefined;
		this.mode = result.mode === "INSERT" ? "INSERT" : "NORMAL";
		this.moveTo(result.cursor);
	}

	private applyVisualPaste(_after: boolean): void {
		if (!this.selection || !this.register) return;
		const before: VimSnapshot = { text: this.getText(), cursor: this.getCursor() };
		const oldRegister = registerForSelection(this.getLines(), this.selection);
		let result: VimMutation;
		if (this.selection.kind === "linewise" || this.register.kind === "linewise") {
			const first = Math.min(this.selection.anchor.line, this.selection.active.line);
			const last = Math.max(this.selection.anchor.line, this.selection.active.line);
			const next = [...this.getLines()];
			next.splice(first, last - first + 1, ...this.register.text.split("\n"));
			result = { lines: next, cursor: { line: first, col: 0 } };
		} else {
			const range = getVimSelectionRange(this.getLines(), this.selection);
			const text = this.getText();
			const nextText = text.slice(0, range.start) + this.register.text + text.slice(range.end);
			const nextLines = nextText.split("\n");
			result = {
				lines: nextLines,
				cursor: pastedCursor(nextLines, range.start + this.register.text.length, this.register.text),
			};
		}
		this.undoState = recordVimMutation(this.undoState, before);
		this.setText(result.lines.join("\n"));
		this.register = oldRegister;
		this.selection = undefined;
		this.mode = "NORMAL";
		this.moveTo(result.cursor);
	}

	private apply(command: VimCommand): void {
		if (command.kind === "visual-toggle") {
			if (this.mode === command.mode) this.clearVisual();
			else this.enterVisual(command.mode === "VISUAL_LINE" ? "linewise" : "characterwise");
			return;
		}
		if (command.kind === "paste") {
			if (!this.register) return;
			const before: VimSnapshot = { text: this.getText(), cursor: this.getCursor() };
			const result = pasteRegister(this.getLines(), before.cursor, this.register, command.after);
			if (result.lines.join("\n") !== before.text) this.undoState = recordVimMutation(this.undoState, before);
			if (result.lines.join("\n") !== before.text) this.setText(result.lines.join("\n"));
			this.moveTo(result.cursor);
			return;
		}
		if (command.kind === "undo") {
			for (let index = 0; index < command.count; index++) {
				const undone = takeVimUndo(this.undoState);
				this.undoState = undone.state;
				if (!undone.snapshot) break;
				this.setText(undone.snapshot.text);
				this.moveTo(undone.snapshot.cursor);
			}
			return;
		}
		const before: VimSnapshot = { text: this.getText(), cursor: this.getCursor() };
		const result = applyVimCommand(this.getLines(), before.cursor, command);
		if (result.mode === "INSERT") this.undoState = beginVimInsertTransaction(this.undoState, before);
		else if (result.lines.join("\n") !== before.text) this.undoState = recordVimMutation(this.undoState, before);
		if (result.lines.join("\n") !== before.text) this.setText(result.lines.join("\n"));
		if (result.register) this.register = result.register;
		this.moveTo(result.cursor);
		if (result.mode) this.mode = result.mode;
	}

	handleInput(data: string): void {
		if (this.mode === "INSERT") {
			if (isEscape(data)) {
				if (this.isShowingAutocomplete()) {
					super.handleInput(data);
					return;
				}
				const cursor = this.getCursor();
				if (cursor.col > 0) super.handleInput("\x1b[D");
				this.undoState = commitVimInsertTransaction(this.undoState);
				this.mode = "NORMAL";
				this.pending = "";
				this.tui.requestRender();
				return;
			}
			const before: VimSnapshot = { text: this.getText(), cursor: this.getCursor() };
			super.handleInput(data);
			if (this.getText() !== before.text) this.undoState = beginVimInsertTransaction(this.undoState, before);
			return;
		}

		if (isEscape(data)) {
			if (this.mode === "VISUAL" || this.mode === "VISUAL_LINE") {
				this.clearVisual();
				this.tui.requestRender();
			} else {
				this.pending = "";
				super.handleInput(data);
			}
			return;
		}
		if (this.mode === "VISUAL" || this.mode === "VISUAL_LINE") {
			// These are normal-mode prefixes/commands, not visual commands. In
			// particular, do not leave `r` pending and steal the next visual key.
			if (
				!this.pending &&
				(data === "i" || data === "o" || data === "D" || data === "C" || data === "u" || data === "r")
			)
				return;
			if (data === "v" || data === "V") {
				if ((data === "v" && this.mode === "VISUAL") || (data === "V" && this.mode === "VISUAL_LINE"))
					this.clearVisual();
				else this.mode = data === "V" ? "VISUAL_LINE" : "VISUAL";
				if (this.selection) this.selection.kind = data === "V" ? "linewise" : "characterwise";
				this.tui.requestRender();
				return;
			}
			if (!this.pending && (data === "y" || data === "d" || data === "x" || data === "c")) {
				this.applyVisual(data === "y" ? "yank" : data === "c" ? "change" : "delete");
				return;
			}
			if (!this.pending && (data === "p" || data === "P")) {
				this.applyVisualPaste(data === "p");
				return;
			}
		}
		const wasVisual = this.mode === "VISUAL" || this.mode === "VISUAL_LINE";
		const routed = routeVimPendingInput(this.pending, data);
		if (routed.delegate) {
			this.pending = "";
			const beforeText = this.getText();
			super.handleInput(data);
			if (wasVisual) {
				if (this.getText() !== beforeText) this.clearVisual();
				else if (this.selection) {
					const normalized = clampNormalCursor(this.getLines(), this.getCursor());
					this.selection.active = normalized;
					this.moveTo(normalized);
				}
			}
			return;
		}
		this.pending = routed.pending;
		if (routed.command && routed.command !== "pending") {
			if (wasVisual && routed.command.kind === "motion") {
				const moved = applyVimCommand(this.getLines(), this.getCursor(), routed.command);
				if (this.selection) this.selection.active = clampNormalCursor(this.getLines(), moved.cursor);
				this.moveTo(moved.cursor);
			} else if (!wasVisual) this.apply(routed.command);
		}
	}

	private renderVisualContentRow(
		row: VimVisualLayoutRow,
		lines: string[],
		selection: VimSelection,
		range: VimRange,
		contentWidth: number,
		paddingX: number,
	): string {
		const leftPadding = " ".repeat(paddingX);
		const lineStart = lines.slice(0, row.line).reduce((total, line) => total + line.length + 1, 0);
		const rowParts = graphemes(row.text);
		const rowBounds = boundaries(row.text);
		const background = "\x1b[48;5;24m";
		let display = "";
		for (let index = 0; index < rowParts.length; index++) {
			const part = rowParts[index]!;
			const partStart = rowBounds[index]!;
			const absoluteStart = lineStart + row.startCol + partStart;
			const selected =
				selection.kind === "linewise"
					? row.line >= Math.min(selection.anchor.line, selection.active.line) &&
						row.line <= Math.max(selection.anchor.line, selection.active.line)
					: absoluteStart < range.end && absoluteStart + part.length > range.start;
			const cursor = row.hasCursor && row.cursorPos === partStart;
			const marker = cursor && this.focused ? CURSOR_MARKER : "";
			const rendered = cursor ? `\x1b[7m${part}\x1b[0m` : part;
			display += selected ? `${background}${marker}${rendered}\x1b[0m` : marker + rendered;
		}

		const lineVisibleWidth = visibleWidth(row.text);
		const cursorAtEnd = row.hasCursor && row.cursorPos === row.text.length;
		const cursorInPadding = cursorAtEnd && lineVisibleWidth + 1 > contentWidth && paddingX > 0;
		if (cursorAtEnd) {
			const selected =
				selection.kind === "characterwise" &&
				lineStart + row.endCol >= range.start &&
				lineStart + row.endCol < range.end;
			const cursor = `\x1b[7m \x1b[0m`;
			display += selected ? `${background}${cursor}\x1b[0m` : cursor;
		}
		const contentPadding = Math.max(0, contentWidth - lineVisibleWidth - (cursorAtEnd ? 1 : 0));
		const lineRightPadding = cursorInPadding ? leftPadding.slice(1) : leftPadding;
		return `${leftPadding}${display}${" ".repeat(contentPadding)}${lineRightPadding}`;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0 || width <= 0) return lines;

		const sourceLines = this.getLines();
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		const layout = vimVisualLayout(sourceLines, layoutWidth, this.getCursor());
		const maxVisibleLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		let cursorLineIndex = layout.findIndex((row) => row.hasCursor);
		if (cursorLineIndex < 0) cursorLineIndex = 0;
		if (cursorLineIndex < this.visualScrollOffset) this.visualScrollOffset = cursorLineIndex;
		else if (cursorLineIndex >= this.visualScrollOffset + maxVisibleLines)
			this.visualScrollOffset = cursorLineIndex - maxVisibleLines + 1;
		this.visualScrollOffset = Math.max(
			0,
			Math.min(this.visualScrollOffset, Math.max(0, layout.length - maxVisibleLines)),
		);

		if ((this.mode === "VISUAL" || this.mode === "VISUAL_LINE") && this.selection) {
			// Paste markers are atomic in Editor, raw ANSI cannot be segmented as
			// text, and autocomplete adds opaque rows. Fall back rather than risk
			// replacing a border or picker row when the mirrored layout is unsafe.
			const visibleRows = layout.slice(this.visualScrollOffset, this.visualScrollOffset + maxVisibleLines);
			const layoutMatchesRender = !this.isShowingAutocomplete() && lines.length === visibleRows.length + 2;
			if (!hasUnsafeHighlightText(sourceLines) && layoutMatchesRender) {
				const range = getVimSelectionRange(sourceLines, this.selection);
				for (let index = 0; index < visibleRows.length; index++) {
					lines[index + 1] = this.renderVisualContentRow(
						visibleRows[index]!,
						sourceLines,
						this.selection,
						range,
						contentWidth,
						paddingX,
					);
				}
			}
		}

		let label: string;
		let color: string;
		if (this.mode === "INSERT") {
			label = " INSERT ";
			color = "\x1b[1;32m";
		} else if (this.mode === "VISUAL" || this.mode === "VISUAL_LINE") {
			label = ` ${this.mode === "VISUAL_LINE" ? "VISUAL-LINE" : "VISUAL"} `;
			color = "\x1b[1;35m";
		} else {
			label = " NORMAL ";
			color = "\x1b[1;36m";
		}
		const workMode = workModeIndicator(getWorkMode());
		const border = "─".repeat(Math.max(0, width - visibleWidth(label) - visibleWidth(workMode.label) - 2));
		const borderColor = this.editorTheme.borderColor("─");
		const decorated =
			borderColor +
			`${color}${label}\x1b[0m` +
			borderColor +
			`${workMode.color}${workMode.label}\x1b[0m` +
			this.editorTheme.borderColor(border);
		lines[0] = truncateToWidth(decorated, width, "");
		return lines;
	}
}

export default function vimModeExtension(pi: ExtensionAPI): void {
	let previousFactory: EditorFactory | undefined;
	let installedFactory: EditorFactory | undefined;

	pi.on("session_start", (_event, ctx) => {
		previousFactory = ctx.ui.getEditorComponent();
		installedFactory = (tui, theme, keybindings) => new VimEditor(tui, theme, keybindings);
		ctx.ui.setEditorComponent(installedFactory);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (installedFactory && ctx.ui.getEditorComponent() === installedFactory) {
			ctx.ui.setEditorComponent(previousFactory);
		}
		installedFactory = undefined;
		previousFactory = undefined;
	});
}
