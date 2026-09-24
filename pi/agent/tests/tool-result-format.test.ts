import { describe, expect, test } from "bun:test";
import { formatToolOutput, sanitizeToolOutput, toolResultContentText } from "../extensions/tool-results/format.ts";

describe("shared tool-result formatting", () => {
	test("strips ANSI/control codes and normalizes newlines", () => {
		expect(sanitizeToolOutput("\u001b[31merror\u001b[0m\r\nnext\r\u0007line")).toBe("error\nnext\nline");
	});

	test("pretty-prints valid JSON and classifies it as structured output", () => {
		const result = formatToolOutput('{"ok":true,"items":[1,2]}', 1024);
		expect(result.kind).toBe("json");
		expect(result.text).toContain('\n  "ok": true,');
		expect(JSON.parse(result.text)).toEqual({ ok: true, items: [1, 2] });
		expect(result.truncated).toBe(false);
	});

	test("distinguishes Markdown, source-like code, and ordinary prose", () => {
		expect(formatToolOutput("# Summary\n\n- one\n- two", 1024).kind).toBe("markdown");
		expect(formatToolOutput("const answer = 42;\nfunction getAnswer() {\n  return answer;\n}", 1024).kind).toBe("code");
		expect(formatToolOutput("The command completed successfully.\nIt found three files.", 1024).kind).toBe("text");
	});

	test("keeps unified diffs out of Markdown parsing even when changed code contains fences", () => {
		const diff = [
			"diff --git a/settings.rs b/settings.rs",
			"--- a/settings.rs",
			"+++ b/settings.rs",
			"@@ -1 +1 @@",
			"-```rust",
			"+```rust",
		].join("\n");
		const result = formatToolOutput(diff, 2048, { toolName: "bash" });
		expect(result.kind).toBe("code");
		expect(result.text).toBe(diff);
		expect(result.language).toBeUndefined();
	});

	test("infers Bash and file-source languages for recognized code output", () => {
		const script = ["#!/usr/bin/env bash", "set -e", "for file in *.log; do", "  echo \"$file\"", "done"].join("\n");
		const bash = formatToolOutput(script, 2048, { toolName: "bash" });
		expect(bash.kind).toBe("code");
		expect(bash.language).toBe("bash");

		const file = formatToolOutput(["#!/bin/sh", "echo ready"].join("\n"), 2048, {
			toolName: "read",
			args: { path: "scripts/deploy.sh" },
		});
		expect(file.language).toBe("bash");
	});

	test("caps output on UTF-8 boundaries and marks truncation", () => {
		const result = formatToolOutput("🙂abc🙂def".repeat(3), 24);
		expect(result.truncated).toBe(true);
		expect(result.text.endsWith("… [truncated]")).toBe(true);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(24);
	});

	test("keeps malformed JSON readable and exposes non-text blocks safely", () => {
		const malformed = formatToolOutput('{"ok":', 1024);
		expect(malformed.kind).toBe("json");
		expect(malformed.text).toBe('{"ok":');
		const content = toolResultContentText([
			{ type: "text", text: "before" },
			{ type: "image", mimeType: "image/png", data: "SECRET_BASE64" } as any,
			{ type: "audio" },
		]);
		expect(content).toContain("before");
		expect(content).toContain("[image · image/png content]");
		expect(content).toContain("[audio content]");
		expect(content).not.toContain("SECRET_BASE64");
	});

	test("uses tool details to present edit diffs and read truncation metadata", () => {
		const edit = formatToolOutput("Successfully replaced 1 block(s) in src/a.ts.", 2048, {
			toolName: "edit",
			args: { path: "src/a.ts" },
			details: { diff: "@@ -1 +1 @@\n-old\n+new", firstChangedLine: 1 },
		});
		expect(edit.title).toBe("src/a.ts");
		expect(edit.summary).toContain("Successfully replaced");
		expect(edit.kind).toBe("code");
		expect(edit.text).toContain("+new");
		expect(edit.notes).toContain("First changed line: 1");

		const read = formatToolOutput("some file", 2048, {
			toolName: "read",
			args: { path: "src/a.ts" },
			details: { truncation: { truncated: true, truncatedBy: "bytes", totalBytes: 1000, outputBytes: 900 } },
		});
		expect(read.kind).toBe("code");
		expect(read.title).toBe("src/a.ts");
		expect(read.notes[0]).toContain("Tool output truncated by bytes limit");
	});

	test("formats question answers from structured details", () => {
		const result = formatToolOutput("User answered: destination=Paris", 2048, {
			toolName: "question",
			details: {
				answers: [{ id: "destination\u001b[0m", question: "Where to?\u001b[2J", answer: "Paris\u001b[31m" }],
				cancelled: false,
			},
		});
		expect(result.kind).toBe("markdown");
		expect(result.text).toContain("### 1. Where to? · destination");
		expect(result.text).toContain("Paris");
		expect(result.text).not.toContain("\u001b[");
	});

	test("bounds large JSON before parsing while preserving a truncation notice", () => {
		const result = formatToolOutput(`{"large":"${"x".repeat(1_000_000)}"}`, 1000);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(1000);
	});

	test("formats LSP diagnostics and preserves source locations", () => {
		const result = formatToolOutput("typescript: 1 issue(s)\nError L8:3: Missing name", 2048, {
			toolName: "lsp_diagnostics",
			args: { path: "src/file.ts" },
		});
		expect(result.kind).toBe("text");
		expect(result.title).toBe("src/file.ts");
		expect(result.text).toContain("• Error L8:3: Missing name");
	});

	test("keeps multiline LSP diagnostic messages together and safe from inline Markdown", () => {
		const result = formatToolOutput(
			[
				"rust_analyzer: 2 issue(s)",
				"",
				"Warning L755:9: variable does not need to be mutable",
				"  `#[warn(unused_mut)]` (part of `#[warn(unused)]` on by default)",
				"Hint L755:9: remove this mut",
			].join("\n"),
			2048,
			{ toolName: "lsp_diagnostics" },
		);
		expect(result.kind).toBe("text");
		expect(result.text.match(/^• /gm)).toHaveLength(2);
		expect(result.text).not.toContain("Issue:");
		expect(result.text).toContain("Warning L755:9");
		expect(result.text).toContain("unused_mut");
		expect(result.text).not.toContain("`");
		expect(result.text).toContain("Hint L755:9");
	});

	test("formats search, listing, write, and shell outputs with tool-specific context", () => {
		const grep = formatToolOutput("src/a.ts:4: match\nsrc/a.ts-3- context", 2048, {
			toolName: "grep",
			args: { pattern: "match", path: "src" },
		});
		expect(grep.kind).toBe("code");
		expect(grep.text).toContain("▸ src/a.ts");
		expect(grep.text).toContain("● 4");

		const find = formatToolOutput("src/a.ts\nsrc/b.ts", 2048, { toolName: "find", args: { pattern: "**/*.ts" } });
		expect(find.kind).toBe("list");
		expect(find.text).toContain("• src/a.ts");
		expect(find.title).toBe("**/*.ts");

		const ls = formatToolOutput("src/\nREADME.md", 2048, { toolName: "ls", args: { path: "." } });
		expect(ls.kind).toBe("list");
		expect(ls.text).toContain("• src/");

		const write = formatToolOutput("Successfully wrote 4 bytes.", 2048, {
			toolName: "write",
			args: { path: "README.md" },
		});
		expect(write.summary).toContain("Successfully wrote");
		expect(write.title).toBe("README.md");

		const longWrite = formatToolOutput("write result ".repeat(100), 32, { toolName: "write" });
		expect(longWrite.truncated).toBe(true);
		expect(Buffer.byteLength(longWrite.summary ?? "", "utf8")).toBeLessThanOrEqual(32);
		expect(longWrite.summary?.endsWith("… [truncated]")).toBe(true);

		const bash = formatToolOutput("done", 2048, {
			toolName: "bash",
			args: { command: "bun test" },
			details: { fullOutputPath: "/tmp/full-output.log" },
		});
		expect(bash.title).toBeUndefined();
		expect(bash.notes).toContain("Full output saved to /tmp/full-output.log");
	});
});
