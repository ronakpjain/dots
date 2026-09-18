import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import vimModeExtension, {
	VimEditor,
	applyVimCommand,
	applyVimVisualCommand,
	getVimSelectionRange,
	getVimSelectionText,
	beginVimInsertTransaction,
	commitVimInsertTransaction,
	parseVimCommand,
	recordVimMutation,
	routeVimPendingInput,
	takeVimUndo,
	type VimCommand,
	type VimUndoState,
} from "../extensions/vim-mode.ts";

function command(sequence: string): VimCommand {
	const parsed = parseVimCommand(sequence);
	if (!parsed || parsed === "pending") throw new Error(`Expected command for ${sequence}`);
	return parsed;
}

describe("vim mode parser", () => {
	test("parses outer, operator-local, and combined counts", () => {
		expect(parseVimCommand("2dw")).toEqual({ kind: "delete", motion: "w", count: 2 });
		expect(parseVimCommand("10w")).toEqual({ kind: "motion", motion: "w", count: 10 });
		expect(parseVimCommand("d10w")).toEqual({ kind: "delete", motion: "w", count: 10 });
		expect(parseVimCommand("2d10w")).toEqual({ kind: "delete", motion: "w", count: 20 });
		expect(parseVimCommand("d2w")).toEqual({ kind: "delete", motion: "w", count: 2 });
		expect(parseVimCommand("d2e")).toEqual({ kind: "delete", motion: "e", count: 2 });
		expect(parseVimCommand("2d2w")).toEqual({ kind: "delete", motion: "w", count: 4 });
		expect(parseVimCommand("d2")).toBe("pending");
		expect(parseVimCommand("2d2")).toBe("pending");
		expect(parseVimCommand("0")).toEqual({ kind: "motion", motion: "0", count: 1 });
		expect(parseVimCommand("999999999999999999d999999999999w")).toMatchObject({ count: 1_000_000 });
	});

	test("parses motions, changes, opens, replacement, and undo", () => {
		expect(parseVimCommand("3gg")).toEqual({ kind: "motion", motion: "gg", count: 3 });
		expect(parseVimCommand("G")).toEqual({ kind: "motion", motion: "G", count: 0 });
		expect(parseVimCommand("1G")).toEqual({ kind: "motion", motion: "G", count: 1 });
		expect(parseVimCommand("2G")).toEqual({ kind: "motion", motion: "G", count: 2 });
		expect(parseVimCommand("dG")).toEqual({ kind: "delete", motion: "G", count: 0 });
		expect(parseVimCommand("d1G")).toEqual({ kind: "delete", motion: "G", count: 1 });
		expect(parseVimCommand("2dG")).toEqual({ kind: "delete", motion: "G", count: 2 });
		expect(parseVimCommand("2o")).toEqual({ kind: "open-line", action: "o", count: 2 });
		expect(parseVimCommand("c$")).toEqual({ kind: "change", motion: "$", count: 1 });
		expect(parseVimCommand("r")).toBe("pending");
		expect(parseVimCommand("r界")).toEqual({ kind: "replace", char: "界", count: 1 });
		expect(parseVimCommand("3u")).toEqual({ kind: "undo", count: 3 });
	});

	test("parses visual toggles and paste while rejecting registers/search/repeat", () => {
		expect(parseVimCommand("v")).toEqual({ kind: "visual-toggle", mode: "VISUAL" });
		expect(parseVimCommand("V")).toEqual({ kind: "visual-toggle", mode: "VISUAL_LINE" });
		expect(parseVimCommand("p")).toEqual({ kind: "paste", after: true });
		expect(parseVimCommand("P")).toEqual({ kind: "paste", after: false });
		expect(parseVimCommand('"a')).toBeNull();
		expect(parseVimCommand("/foo")).toBeNull();
		expect(parseVimCommand(".")).toBeNull();
	});
});

describe("vim mode pending routing", () => {
	test("keeps printable operator and replacement prefixes pending", () => {
		expect(routeVimPendingInput("", "d")).toMatchObject({ pending: "d", delegate: false });
		expect(routeVimPendingInput("d", "2")).toMatchObject({ pending: "d2", delegate: false });
		expect(routeVimPendingInput("d2", "w")).toMatchObject({
			pending: "",
			delegate: false,
			command: { kind: "delete", count: 2 },
		});
		expect(routeVimPendingInput("r", "界")).toMatchObject({
			pending: "",
			delegate: false,
			command: { kind: "replace", char: "界" },
		});
	});

	test("clears pending and delegates control, enter, navigation, and Escape", () => {
		for (const special of [
			"\x03",
			"\r",
			"\x1b[A",
			"\x1b[B",
			"\x1b[C",
			"\x1b[D",
			"\x1b",
			"\x1b[27u",
			"\x1b[27;1;27~",
		]) {
			expect(routeVimPendingInput("d", special)).toEqual({ pending: "", delegate: true, command: null });
		}
		for (const special of ["\x03", "\r", "\x1b[A", "\x1b", "\x1b[27u", "\x1b[27;1;27~"]) {
			expect(routeVimPendingInput("r", special)).toEqual({ pending: "", delegate: true, command: null });
		}
	});
});

describe("vim mode pure mutations", () => {
	test("moves and deletes using grapheme boundaries", () => {
		const lines = ["a😀 bc"];
		expect(applyVimCommand(lines, { line: 0, col: 0 }, command("w")).cursor.col).toBe(1);
		expect(applyVimCommand(lines, { line: 0, col: 1 }, command("x")).lines).toEqual(["a bc"]);
		expect(applyVimCommand(["a😀b"], { line: 0, col: 1 }, command("r界")).lines).toEqual(["a界b"]);
	});

	test("handles db, de, and dd at line and word boundaries", () => {
		expect(applyVimCommand(["one two"], { line: 0, col: 4 }, command("db")).lines).toEqual(["two"]);
		expect(applyVimCommand(["one two"], { line: 0, col: 0 }, command("de")).lines).toEqual([" two"]);
		expect(applyVimCommand(["one", "two", "three"], { line: 1, col: 2 }, command("dd")).lines).toEqual([
			"one",
			"three",
		]);
		expect(applyVimCommand(["one", "two", "three"], { line: 0, col: 0 }, command("2dd")).lines).toEqual(["three"]);
		expect(applyVimCommand(["one", "two", "three"], { line: 2, col: 1 }, command("dd")).lines).toEqual([
			"one",
			"two",
		]);
	});

	test("supports operator-local counts and linewise dG", () => {
		const words = ["one two three four five"];
		expect(applyVimCommand(words, { line: 0, col: 0 }, command("d2w")).lines).toEqual(["three four five"]);
		expect(applyVimCommand(words, { line: 0, col: 0 }, command("2d2w")).lines).toEqual(["five"]);
		expect(applyVimCommand(["one", "two", "three"], { line: 1, col: 2 }, command("dG"))).toMatchObject({
			lines: ["one"],
			cursor: { line: 0, col: 2 },
		});
		expect(applyVimCommand(["one", "two", "three", "four"], { line: 2, col: 1 }, command("d1G")).lines).toEqual([
			"four",
		]);
		expect(applyVimCommand(["one", "two", "three", "four"], { line: 2, col: 1 }, command("2dG")).lines).toEqual([
			"one",
			"four",
		]);
		expect(applyVimCommand(["one", "two"], { line: 0, col: 2 }, command("dG")).lines).toEqual([""]);
	});

	test("counts e and open-line operations", () => {
		expect(applyVimCommand(["one two three"], { line: 0, col: 0 }, command("d2e")).lines).toEqual([" three"]);
		expect(applyVimCommand(["one two"], { line: 0, col: 0 }, command("cw"))).toMatchObject({
			lines: [" two"],
			mode: "INSERT",
		});
		expect(applyVimCommand(["one", "two"], { line: 0, col: 0 }, command("2o"))).toMatchObject({
			lines: ["one", "", "", "two"],
			cursor: { line: 1, col: 0 },
			mode: "INSERT",
		});
		expect(applyVimCommand(["one", "two"], { line: 1, col: 1 }, command("2O"))).toMatchObject({
			lines: ["one", "", "", "two"],
			cursor: { line: 1, col: 0 },
			mode: "INSERT",
		});
	});

	test("supports line motions and insert transitions", () => {
		expect(applyVimCommand(["  one", "two", "three"], { line: 0, col: 3 }, command("^")).cursor.col).toBe(2);
		expect(applyVimCommand(["one", "two", "three"], { line: 0, col: 0 }, command("G")).cursor).toEqual({
			line: 2,
			col: 4,
		});
		expect(applyVimCommand(["one", "two", "three"], { line: 2, col: 1 }, command("1G")).cursor).toEqual({
			line: 0,
			col: 2,
		});
		expect(applyVimCommand(["long", "x"], { line: 0, col: 3 }, command("j")).cursor).toEqual({ line: 1, col: 0 });
		expect(applyVimCommand(["  ", "x"], { line: 0, col: 1 }, command("^")).cursor).toEqual({ line: 0, col: 0 });
		expect(applyVimCommand(["  ", "x"], { line: 0, col: 1 }, command("I")).cursor).toEqual({ line: 0, col: 0 });
		expect(applyVimCommand(["x", "  ", "word"], { line: 0, col: 0 }, command("w")).cursor).toEqual({
			line: 1,
			col: 0,
		});
		expect(applyVimCommand(["one"], { line: 0, col: 0 }, command("a")).cursor.col).toBe(1);
		expect(applyVimCommand(["one"], { line: 0, col: 2 }, command("A")).cursor.col).toBe(3);
		expect(applyVimCommand(["  one"], { line: 0, col: 4 }, command("I")).cursor.col).toBe(2);
		expect(applyVimCommand(["abc"], { line: 0, col: 2 }, command("x")).cursor).toEqual({ line: 0, col: 1 });
		expect(applyVimCommand(["abc", "x"], { line: 0, col: 2 }, command("d$")).cursor).toEqual({ line: 0, col: 1 });
	});
});

describe("vim visual selections and registers", () => {
	test("uses inclusive grapheme-safe ranges in either direction", () => {
		const selection = { anchor: { line: 0, col: 3 }, active: { line: 0, col: 1 }, kind: "characterwise" as const };
		expect(getVimSelectionRange(["a😀界b"], selection)).toEqual({ start: 1, end: 4 });
		expect(getVimSelectionText(["a😀界b"], selection)).toBe("😀界");
		expect(applyVimVisualCommand(["a😀界b"], selection.active, selection, "delete")).toMatchObject({
			lines: ["ab"],
			register: { text: "😀界", kind: "characterwise" },
		});
	});

	test("covers multiline and EOF linewise selections", () => {
		const selection = { anchor: { line: 2, col: 1 }, active: { line: 1, col: 0 }, kind: "linewise" as const };
		expect(getVimSelectionText(["one", "two", "three"], selection)).toBe("two\nthree");
		expect(applyVimVisualCommand(["one", "two", "three"], selection.active, selection, "delete")).toMatchObject({
			lines: ["one"],
			register: { text: "two\nthree", kind: "linewise" },
		});
		const eof = { anchor: { line: 1, col: 0 }, active: { line: 1, col: 0 }, kind: "linewise" as const };
		expect(getVimSelectionRange(["one", "two"], eof)).toEqual({ start: 4, end: 7 });
	});
});

describe("vim insert undo transactions", () => {
	const snapshot = (text: string, col = 0) => ({ text, cursor: { line: 0, col } });

	test("coalesces one insert session and does not replace its first snapshot", () => {
		let state: VimUndoState = { history: [] };
		state = beginVimInsertTransaction(state, snapshot("before"));
		state = beginVimInsertTransaction(state, snapshot("wrong"));
		state = commitVimInsertTransaction(state);
		const undone = takeVimUndo(state);
		expect(undone.snapshot).toEqual(snapshot("before"));
		expect(undone.state.history).toEqual([]);
	});

	test("coalesces command mutation with later typing, then records normal mutations separately", () => {
		let state: VimUndoState = { history: [] };
		state = beginVimInsertTransaction(state, snapshot("original"));
		state = recordVimMutation(state, snapshot("after insert"));
		state = recordVimMutation(state, snapshot("after delete"));
		expect(state.history.map((entry) => entry.text)).toEqual(["original", "after insert", "after delete"]);
		expect(takeVimUndo(state).snapshot?.text).toBe("after delete");
	});
});

describe("vim editor insert transactions", () => {
	function editor(text?: string): VimEditor {
		const tui = { requestRender: () => {}, terminal: { rows: 24 } };
		const theme = {
			borderColor: (value: string) => value,
			selectList: {},
			fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
			bold: (value: string) => `<bold>${value}</bold>`,
		};
		const keybindings = { matches: (data: string, key: string) => key === "app.interrupt" && data === "\x1b" };
		const instance = new VimEditor(tui as never, theme as never, keybindings as never);
		if (text !== undefined) instance.setText(text);
		return instance;
	}

	test("undoes initial INSERT typing as one transaction", () => {
		const instance = editor();
		instance.handleInput("a");
		instance.handleInput("b");
		instance.handleInput("\x1b");
		instance.handleInput("u");
		expect(instance.getText()).toBe("");
		expect(instance.render(30)[0]).toContain("NORMAL");
	});

	test.each(["i", "a", "I", "A", "o", "O"] as const)("undoes %s plus subsequent typing", (start) => {
		const instance = editor("one");
		instance.handleInput("\x1b");
		if (start === "o" || start === "O") instance.handleInput("2");
		instance.handleInput(start);
		instance.handleInput("x");
		instance.handleInput("\x1b");
		instance.handleInput("u");
		expect(instance.getText()).toBe("one");
	});

	test.each(["cw", "C"] as const)("undoes %s mutation and typing together", (change) => {
		const instance = editor("one two");
		instance.handleInput("\x1b");
		instance.handleInput("0");
		for (const key of change) instance.handleInput(key);
		instance.handleInput("x");
		instance.handleInput("\x1b");
		instance.handleInput("u");
		expect(instance.getText()).toBe("one two");
	});

	test("NORMAL Escape still delegates Pi's interrupt binding", () => {
		const instance = editor("abc");
		let interrupted = 0;
		instance.onEscape = () => interrupted++;
		instance.handleInput("\x1b");
		expect(instance.getMode()).toBe("NORMAL");
		instance.handleInput("\x1b");
		expect(interrupted).toBe(1);
	});

	test("enters, extends, toggles, switches, and exits visual modes", () => {
		const instance = editor("a😀界b");
		instance.handleInput("\x1b");
		instance.handleInput("0");
		instance.handleInput("v");
		expect(instance.getMode()).toBe("VISUAL");
		instance.handleInput("2l");
		expect(instance.getSelection()?.kind).toBe("characterwise");
		expect(instance.getSelection()?.active.col).toBe(3);
		instance.handleInput("V");
		expect(instance.getMode()).toBe("VISUAL_LINE");
		instance.handleInput("V");
		expect(instance.getMode()).toBe("NORMAL");
		instance.handleInput("v");
		instance.handleInput("\x1b");
		expect(instance.getMode()).toBe("NORMAL");
	});

	test("yanks/deletes and pastes characterwise and linewise registers", () => {
		const instance = editor("one two");
		instance.handleInput("\x1b");
		instance.handleInput("0");
		instance.handleInput("v");
		instance.handleInput("l");
		instance.handleInput("y");
		expect(instance.getRegister()).toEqual({ text: "on", kind: "characterwise" });
		instance.handleInput("p");
		expect(instance.getText()).toBe("onone two");

		const lines = editor("one\ntwo\nthree");
		lines.handleInput("\x1b");
		lines.handleInput("g");
		lines.handleInput("g");
		lines.handleInput("0");
		lines.handleInput("V");
		lines.handleInput("j");
		lines.handleInput("y");
		expect(lines.getRegister()).toEqual({ text: "one\ntwo", kind: "linewise" });
		lines.handleInput("p");
		expect(lines.getText()).toBe("one\ntwo\none\ntwo\nthree");

		const normal = editor("abc\ndef");
		normal.handleInput("\x1b");
		normal.handleInput("g");
		normal.handleInput("g");
		normal.handleInput("0");
		normal.handleInput("x");
		expect(normal.getRegister()).toEqual({ text: "a", kind: "characterwise" });
		normal.handleInput("P");
		expect(normal.getText()).toBe("abc\ndef");
		normal.handleInput("d");
		normal.handleInput("d");
		expect(normal.getRegister()).toEqual({ text: "abc", kind: "linewise" });

		const counted = editor("one\ntwo\nthree");
		counted.handleInput("\x1b");
		counted.handleInput("g");
		counted.handleInput("g");
		counted.handleInput("2dd");
		expect(counted.getRegister()).toEqual({ text: "one\ntwo", kind: "linewise" });
		expect(counted.getText()).toBe("three");
		counted.handleInput("p");
		expect(counted.getText()).toBe("three\none\ntwo");

		const before = editor("one\ntwo\nthree");
		before.handleInput("\x1b");
		before.handleInput("g");
		before.handleInput("g");
		before.handleInput("2dd");
		before.handleInput("P");
		expect(before.getText()).toBe("one\ntwo\nthree");
	});

	test("ignores unsupported normal commands while visual", () => {
		for (const key of ["i", "o", "D", "C", "u", "r"]) {
			const instance = editor("abc");
			instance.handleInput("\x1b");
			instance.handleInput("0");
			instance.handleInput("v");
			instance.handleInput("l");
			const selection = instance.getSelection();
			instance.handleInput(key);
			expect(instance.getMode(), key).toBe("VISUAL");
			expect(instance.getText(), key).toBe("abc");
			expect(instance.getSelection(), key).toEqual(selection);
		}
		const recoverable = editor("abc");
		recoverable.handleInput("\x1b");
		recoverable.handleInput("0");
		recoverable.handleInput("v");
		recoverable.handleInput("l");
		recoverable.handleInput("r");
		recoverable.handleInput("y");
		expect(recoverable.getRegister()).toEqual({ text: "ab", kind: "characterwise" });
	});

	test("delegated visual cursor movement updates selection and yank/delete", () => {
		const yanked = editor("abc");
		yanked.handleInput("\x1b");
		yanked.handleInput("0");
		yanked.handleInput("v");
		yanked.handleInput("\x1b[C");
		expect(yanked.getSelection()?.active).toEqual({ line: 0, col: 1 });
		expect(yanked.render(80)[0]).toContain(" VISUAL ");
		yanked.handleInput("y");
		expect(yanked.getRegister()).toEqual({ text: "ab", kind: "characterwise" });

		const deleted = editor("abc");
		deleted.handleInput("\x1b");
		deleted.handleInput("0");
		deleted.handleInput("v");
		deleted.handleInput("\x1b[C");
		deleted.handleInput("d");
		expect(deleted.getText()).toBe("c");
	});

	test("clears visual mode if delegated input changes text", () => {
		const instance = editor("abc");
		instance.handleInput("\x1b");
		instance.handleInput("0");
		instance.handleInput("v");
		instance.handleInput("\r");
		expect(instance.getMode()).toBe("NORMAL");
		expect(instance.getSelection()).toBeUndefined();
	});

	test("normalizes one-past-EOF entering visual", () => {
		const instance = editor("abc");
		instance.handleInput("\x1b");
		instance.handleInput("v");
		expect(instance.getSelection()?.anchor).toEqual({ line: 0, col: 2 });
		instance.handleInput("y");
		expect(instance.getRegister()).toEqual({ text: "c", kind: "characterwise" });
	});

	test("characterwise paste leaves cursor on final pasted grapheme", () => {
		const unicode = editor("a😀b");
		unicode.handleInput("\x1b");
		unicode.handleInput("0");
		unicode.handleInput("v");
		unicode.handleInput("l");
		unicode.handleInput("y");
		unicode.handleInput("p");
		expect(unicode.getText()).toBe("a😀a😀b");
		expect(unicode.getCursor()).toEqual({ line: 0, col: 4 });

		const visual = editor("abc");
		visual.handleInput("\x1b");
		visual.handleInput("0");
		visual.handleInput("v");
		visual.handleInput("y");
		visual.handleInput("l");
		visual.handleInput("v");
		visual.handleInput("p");
		expect(visual.getText()).toBe("aac");
		expect(visual.getCursor()).toEqual({ line: 0, col: 1 });

		const before = editor("a😀b");
		before.handleInput("\x1b");
		before.handleInput("0");
		before.handleInput("v");
		before.handleInput("l");
		before.handleInput("y");
		before.handleInput("P");
		expect(before.getText()).toBe("aa😀😀b");
		expect(before.getCursor()).toEqual({ line: 0, col: 2 });
	});

	test("visual change coalesces typing into one undo", () => {
		const instance = editor("one two");
		instance.handleInput("\x1b");
		instance.handleInput("0");
		instance.handleInput("v");
		instance.handleInput("l");
		instance.handleInput("c");
		expect(instance.getMode()).toBe("INSERT");
		instance.handleInput("X");
		instance.handleInput("Y");
		instance.handleInput("\x1b");
		instance.handleInput("u");
		expect(instance.getText()).toBe("one two");
	});

	test("shows only the visual mode name in the indicator", () => {
		const instance = editor("abc");
		instance.handleInput("\x1b");
		instance.handleInput("0");
		instance.handleInput("v");
		instance.handleInput("l");
		const indicator = instance.render(80)[0]!;
		expect(indicator).toContain(" VISUAL ");
		expect(indicator).not.toContain("chars");
		expect(indicator).not.toContain("0-2");
	});

	test("keeps the modal border indicator clear", () => {
		const instance = editor();
		expect(instance.render(30)[0]).toContain("\x1b[1;32m INSERT \x1b[0m");
		instance.handleInput("\x1b");
		expect(instance.render(30)[0]).toContain("\x1b[1;36m NORMAL \x1b[0m");
	});

	test("renders a background on selected characters but not unselected text", () => {
		const instance = editor("abcd");
		instance.handleInput("\x1b");
		instance.handleInput("0");
		instance.handleInput("v");
		instance.handleInput("l");
		const row = instance.render(20)[1]!;
		expect(row.match(/\x1b\[48;5;24m/gu)?.length).toBe(2);
		expect(row).toContain("cd");
	});

	test("highlights reversed Unicode graphemes and keeps the cursor distinct", () => {
		const instance = editor("a😀界b");
		instance.handleInput("\x1b");
		instance.handleInput("$");
		instance.handleInput("v");
		instance.handleInput("2h");
		instance.focused = true;
		const row = instance.render(20)[1]!;
		expect(row).toContain("😀");
		expect(row).toContain("界");
		expect(row.match(/\x1b\[48;5;24m/gu)?.length).toBeGreaterThanOrEqual(3);
		expect(row).toContain(CURSOR_MARKER);
		expect(row).toContain("\x1b[7m");
	});

	test("highlights only line characters in visual-line mode", () => {
		const instance = editor("one\ntwo\nthree");
		instance.setPaddingX(2);
		instance.handleInput("\x1b");
		instance.handleInput("g");
		instance.handleInput("g");
		instance.handleInput("0");
		instance.handleInput("V");
		instance.handleInput("j");
		const rendered = instance.render(18);
		expect(rendered[1]).toMatch(/^  \x1b\[48;5;24m/u);
		expect(rendered[2]).toMatch(/^  \x1b\[48;5;24m/u);
		expect(rendered[1]!.match(/\x1b\[48;5;24m/gu)?.length).toBe(3);
		expect(rendered[2]!.match(/\x1b\[48;5;24m/gu)?.length).toBe(3);
		expect(rendered[1]).toMatch(/\x1b\[0m +$/u);
		expect(rendered[2]).toMatch(/\x1b\[0m +$/u);
		expect(rendered[3]).not.toContain("\x1b[48;5;24m");
	});

	test("keeps highlighted wrapped rows within the requested width", () => {
		for (const text of ["abcdefghij", "hello界界world", "hello𠀀𠀀world", "helloㄅㄅworld"]) {
			const instance = editor(text);
			instance.handleInput("\x1b");
			instance.handleInput("0");
			instance.handleInput("v");
			instance.handleInput("$");
			const rendered = instance.render(10);
			const body = rendered.slice(1, -1).filter((row) => row.includes("\x1b[48;5;24m"));
			expect(body.length, text).toBeGreaterThanOrEqual(2);
			for (const row of rendered) expect(visibleWidth(row), text).toBeLessThanOrEqual(10);
		}
	});

	test("falls back safely for paste markers and raw ANSI text", () => {
		for (const text of ["[paste #1 +13 lines]", "\x1b[31mabcdefghij\x1b[0m"]) {
			const instance = editor(text);
			instance.handleInput("\x1b");
			instance.handleInput("0");
			instance.handleInput("v");
			instance.handleInput("$");
			const rendered = instance.render(12);
			expect(
				rendered.slice(1).some((row) => row.includes("\x1b[48;5;24m")),
				text,
			).toBe(false);
			// Raw ANSI width is owned by the base Editor; this extension only
			// guarantees that fallback leaves those rows untouched.
			if (!text.includes("\x1b")) {
				for (const row of rendered) expect(visibleWidth(row), text).toBeLessThanOrEqual(12);
			}
		}
	});

	test.each(["\x1b[27u", "\x1b[27;1;27~"])("recognizes terminal Escape sequence %j", (escape) => {
		const instance = editor();
		instance.handleInput(escape);
		expect(instance.render(30)[0]).toContain("NORMAL");
	});

	test("Esc from an opened blank line does not wrap to the previous line", () => {
		const instance = editor("one");
		instance.handleInput("\x1b");
		instance.handleInput("o");
		expect(instance.getCursor()).toEqual({ line: 1, col: 0 });
		instance.handleInput("\x1b");
		expect(instance.getCursor()).toEqual({ line: 1, col: 0 });
	});
});

describe("vim mode extension lifecycle", () => {
	test("restores a previous factory only when still installed", () => {
		const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
		const previous = () => ({}) as never;
		let current: unknown = previous;
		const setCalls: unknown[] = [];
		vimModeExtension({
			on(name: string, handler: (event: unknown, ctx: unknown) => void) {
				handlers[name] = handler;
			},
		} as never);
		const ctx = {
			ui: {
				getEditorComponent: () => current,
				setEditorComponent: (factory: unknown) => {
					current = factory;
					setCalls.push(factory);
				},
			},
		};
		handlers.session_start({}, ctx);
		const installed = current;
		expect(installed).not.toBe(previous);
		handlers.session_shutdown({}, ctx);
		expect(current).toBe(previous);
		expect(setCalls).toHaveLength(2);

		handlers.session_start({}, ctx);
		current = () => ({}) as never;
		handlers.session_shutdown({}, ctx);
		expect(current).not.toBe(previous);
	});
});
