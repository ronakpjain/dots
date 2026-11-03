import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMIT_STYLE_CAPABILITY =
	"[COMMIT STYLE] Git commit messages must be a single oneline subject. Use exactly one inline `-m \"<subject>\"`; never add a body, a second `-m`, `-F`/editor input, or embedded newlines. A commit-message extension blocks violations.";

type Token = {
	value: string;
	/** The token contained an embedded newline (quoted newline or a `$'...\n...'` escape). */
	newline: boolean;
	operator: boolean;
};

/** Split a shell command into words, keeping unquoted separators as operator tokens. */
export function tokenizeShell(command: string): Token[] {
	const tokens: Token[] = [];
	const push = (value: string, newline: boolean, operator = false): void => {
		tokens.push({ value, newline, operator });
	};

	let i = 0;
	while (i < command.length) {
		const char = command[i];

		if (char === " " || char === "\t" || char === "\r") {
			i++;
			continue;
		}
		if (char === "\n") {
			push("\n", false, true);
			i++;
			continue;
		}
		if (char === ";" || char === "&" || char === "|") {
			let op = char;
			i++;
			while (i < command.length && (command[i] === "&" || command[i] === "|")) {
				op += command[i];
				i++;
			}
			push(op, false, true);
			continue;
		}

		let value = "";
		let newline = false;
		let started = false;

		while (i < command.length) {
			const ch = command[i];
			if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") break;
			if (ch === ";" || ch === "&" || ch === "|") break;
			started = true;

			if (ch === "\\") {
				const next = command[i + 1];
				if (next === undefined) {
					value += "\\";
					i++;
					break;
				}
				if (next === "\n") {
					newline = true;
					value += "\n";
					i += 2;
					continue;
				}
				value += next;
				i += 2;
				continue;
			}

			if (ch === "'") {
				i++;
				while (i < command.length && command[i] !== "'") {
					if (command[i] === "\n") newline = true;
					value += command[i];
					i++;
				}
				i++;
				continue;
			}

			if (ch === '"') {
				i++;
				while (i < command.length && command[i] !== '"') {
					if (command[i] === "\\") {
						const next = command[i + 1];
						if (next === "\n") {
							newline = true;
							value += "\n";
							i += 2;
							continue;
						}
						if (next !== undefined && '"\\$`'.includes(next)) {
							value += next;
							i += 2;
							continue;
						}
						value += "\\";
						i++;
						continue;
					}
					if (command[i] === "\n") newline = true;
					value += command[i];
					i++;
				}
				i++;
				continue;
			}

			if (ch === "$" && command[i + 1] === "'") {
				i += 2;
				while (i < command.length && command[i] !== "'") {
					if (command[i] === "\\") {
						const next = command[i + 1];
						if (next === "n") {
							newline = true;
							value += "\n";
							i += 2;
							continue;
						}
						if (next === "t") {
							value += "\t";
							i += 2;
							continue;
						}
						if (next === "\\" || next === "'" || next === '"') {
							value += next;
							i += 2;
							continue;
						}
						value += "\\";
						i++;
						continue;
					}
					value += command[i];
					i++;
				}
				i++;
				continue;
			}

			value += ch;
			i++;
		}

		if (started) push(value, newline);
	}

	return tokens;
}

type ParsedCommit = {
	messages: Token[];
	messageFlags: number;
	file: string | undefined;
	noEdit: boolean;
};

/** Return the argument index of a `git ... commit` invocation, or undefined. */
function commitArgStart(tokens: Token[]): number | undefined {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.operator || token.value !== "git") continue;

		let j = i + 1;
		while (j < tokens.length && !tokens[j].operator) {
			const value = tokens[j].value;
			if (value === "-C" || value === "--git-dir" || value === "--work-tree" || value === "-c") {
				j += 2;
				continue;
			}
			break;
		}
		if (tokens[j] && !tokens[j].operator && tokens[j].value === "commit") return j + 1;
	}
	return undefined;
}

function emptyToken(): Token {
	return { value: "", newline: false, operator: false };
}

function parseCommitArgs(tokens: Token[], start: number): ParsedCommit {
	const parsed: ParsedCommit = { messages: [], messageFlags: 0, file: undefined, noEdit: false };

	for (let i = start; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.operator) break;
		const value = token.value;

		if (value === "-m" || value === "--message") {
			parsed.messageFlags++;
			const next = tokens[i + 1];
			if (next && !next.operator) {
				parsed.messages.push(next);
				i++;
			} else {
				parsed.messages.push(emptyToken());
			}
			continue;
		}
		if (value.startsWith("--message=")) {
			parsed.messageFlags++;
			parsed.messages.push({ value: value.slice("--message=".length), newline: token.newline, operator: false });
			continue;
		}
		// Short option cluster that contains `m` (e.g. `-am`, `-am"msg"`, `-m"msg"`).
		if (value.startsWith("-") && !value.startsWith("--")) {
			const mIndex = value.indexOf("m", 1);
			if (mIndex >= 0) {
				parsed.messageFlags++;
				const attached = value.slice(mIndex + 1);
				if (attached) {
					parsed.messages.push({ value: attached, newline: token.newline, operator: false });
				} else {
					const next = tokens[i + 1];
					if (next && !next.operator) {
						parsed.messages.push(next);
						i++;
					} else {
						parsed.messages.push(emptyToken());
					}
				}
				continue;
			}
		}
		if (value === "-F" || value === "--file") {
			const next = tokens[i + 1];
			parsed.file = next && !next.operator ? next.value : "";
			if (next && !next.operator) i++;
			continue;
		}
		if (value.startsWith("--file=")) {
			parsed.file = value.slice("--file=".length);
			continue;
		}
		if (value === "--no-edit") {
			parsed.noEdit = true;
			continue;
		}
	}

	return parsed;
}

function fileViolation(file: string, cwd: string): string | undefined {
	if (!file || file === "-") return "a message file (-F) cannot be verified as a single line";
	const path = isAbsolute(file) ? file : resolve(cwd, file);
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return "a message file (-F) could not be read to verify a single line";
	}
	const body = content.replace(/\n$/, "");
	if (body.includes("\n") || body.includes("\r")) return "the message file (-F) contains more than one line";
	return undefined;
}

/**
 * Return a block reason when a `git commit` command cannot produce a one-line
 * message, or undefined when the command is absent or already a single line.
 */
export function checkCommitCommand(command: string, cwd: string): string | undefined {
	const start = commitArgStart(tokenizeShell(command));
	if (start === undefined) return undefined;

	const parsed = parseCommitArgs(tokenizeShell(command), start);
	const subject = "Commit messages must be a single oneline subject";

	if (parsed.messageFlags > 1) {
		return `${subject}: ${parsed.messageFlags} -m/--message flags create a multi-line body. Re-run with exactly one inline -m "subject".`;
	}
	if (parsed.messages.some((message) => message.newline || message.value.includes("\n") || message.value.includes("\r"))) {
		return `${subject}: the message contains a newline. Re-run with exactly one inline -m "subject" and no body.`;
	}
	if (parsed.file !== undefined) {
		const reason = fileViolation(parsed.file, cwd);
		if (reason) return `${subject}: ${reason}. Re-run with exactly one inline -m "subject".`;
	}
	if (parsed.messageFlags === 0 && parsed.file === undefined && !parsed.noEdit) {
		return `${subject}: no inline -m message was provided, so an editor or merge message would be used. Re-run with exactly one inline -m "subject".`;
	}
	return undefined;
}

export default function commitMessageExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${COMMIT_STYLE_CAPABILITY}`,
	}));

	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const reason = checkCommitCommand(event.input.command, ctx.cwd);
		if (reason) return { block: true, reason };
	});
}
