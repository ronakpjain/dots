import { describe, expect, test } from "bun:test";
import safetyGate, {
	createApprovalStore,
	hasApproval,
	rememberApproval,
	riskFor,
	type Risk,
} from "../extensions/safety-gate.ts";

function bash(command: string) {
	return {
		type: "tool_call",
		toolCallId: command,
		toolName: "bash",
		input: { command },
	} as any;
}

function file(toolName: "write" | "edit", path: string, content: string) {
	return {
		type: "tool_call",
		toolCallId: `${toolName}:${path}:${content}`,
		toolName,
		input: toolName === "write" ? { path, content } : { path, edits: [{ oldText: "old", newText: content }] },
	} as any;
}

function risk(event: any, cwd = "/tmp/project"): Risk {
	const result = riskFor(event, cwd);
	if (!result) throw new Error(`Expected a risk for ${JSON.stringify(event)}`);
	return result;
}

describe("safety gate session approvals", () => {
	test("remembers exact calls while ignoring harmless whitespace differences", () => {
		const approvals = createApprovalStore();
		const first = bash("rm -rf build/output");
		const equivalent = bash("  rm   -rf   build/output  ");
		const different = bash("rm -rf build/cache");
		const firstRisk = risk(first);

		rememberApproval("exact", first, "/tmp/project", firstRisk, approvals);

		expect(hasApproval(equivalent, "/tmp/project", risk(equivalent), approvals)).toBe(true);
		expect(hasApproval(different, "/tmp/project", risk(different), approvals)).toBe(false);
	});

	test("related approvals cover the same operation family, not a different operation", () => {
		const approvals = createApprovalStore();
		const push = bash("git push origin main");
		const anotherBranch = bash("git push origin feature/login");
		const otherRemote = bash("git push upstream feature/login");
		const commit = bash("git commit -m done");

		rememberApproval("related", push, "/tmp/project", risk(push), approvals);

		expect(hasApproval(anotherBranch, "/tmp/project", risk(anotherBranch), approvals)).toBe(true);
		expect(hasApproval(otherRemote, "/tmp/project", risk(otherRemote), approvals)).toBe(false);
		expect(hasApproval(commit, "/tmp/project", risk(commit), approvals)).toBe(false);
	});

	test("related approvals do not cover compound commands", () => {
		const approvals = createApprovalStore();
		const simple = bash("rm -rf build/output");
		const compound = bash("rm -rf build/cache && echo done");

		rememberApproval("related", simple, "/tmp/project", risk(simple), approvals);

		expect(risk(compound).family).toBeUndefined();
		expect(hasApproval(compound, "/tmp/project", risk(compound), approvals)).toBe(false);
	});

	test("approvals are scoped to the workspace", () => {
		const approvals = createApprovalStore();
		const command = bash("git push origin main");
		const commandRisk = risk(command, "/tmp/project");

		rememberApproval("related", command, "/tmp/project", commandRisk, approvals);

		expect(hasApproval(command, "/tmp/project", commandRisk, approvals)).toBe(true);
		expect(hasApproval(command, "/tmp/other-project", risk(command, "/tmp/other-project"), approvals)).toBe(false);
	});

	test("related file approvals keep the same sensitive path while allowing new content", () => {
		const approvals = createApprovalStore();
		const first = file("write", ".env", "TOKEN=one");
		const changed = file("write", ".env", "TOKEN=two");
		const other = file("write", ".env.production", "TOKEN=three");

		rememberApproval("related", first, "/tmp/project", risk(first), approvals);

		expect(hasApproval(changed, "/tmp/project", risk(changed), approvals)).toBe(true);
		expect(hasApproval(other, "/tmp/project", risk(other), approvals)).toBe(false);
	});

	test("the interactive related choice skips later prompts until the session changes", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		let promptCount = 0;
		let selected = "Always allow related commands in this session";
		let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
		safetyGate({
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				handlers[name] = handler;
			},
			registerCommand(_name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
				commandHandler = spec.handler;
			},
		} as any);

		const ctx = {
			cwd: "/tmp/project",
			hasUI: true,
			signal: undefined,
			ui: {
				select: async () => {
					promptCount += 1;
					return selected;
				},
				confirm: async () => true,
				notify: () => {},
				setStatus: () => {},
			},
		};
		const first = bash("git push origin main");
		const second = bash("git push origin feature/login");

		await handlers.tool_call(first, ctx);
		await handlers.tool_call(second, ctx);
		expect(promptCount).toBe(1);

		await handlers.session_start({}, ctx);
		selected = "Deny";
		const denied = await handlers.tool_call(second, ctx);
		expect(promptCount).toBe(2);
		expect(denied).toEqual({ block: true, reason: "User denied remote Git write." });
		expect(commandHandler).toBeDefined();
		await commandHandler!("clear", ctx);
	});

	test("sends an optional denial explanation to the model in the block reason", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		let offeredOptions: string[] = [];
		let inputPrompt = "";
		safetyGate({
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				handlers[name] = handler;
			},
			registerCommand() {},
		} as any);

		const explanation = "Do not push until I have reviewed the changes.";
		const ctx = {
			cwd: "/tmp/project",
			hasUI: true,
			signal: undefined,
			ui: {
				select: async (_title: string, options: string[]) => {
					offeredOptions = options;
					return "Deny and tell model why";
				},
				input: async (title: string) => {
					inputPrompt = title;
					return explanation;
				},
				confirm: async () => true,
				notify: () => {},
				setStatus: () => {},
			},
		};
		const result = await handlers.tool_call(bash("git push origin main"), ctx);

		expect(offeredOptions).toContain("Deny and tell model why");
		expect(inputPrompt).toBe("Why deny this action? The explanation will be sent to the model.");
		expect(result).toEqual({
			block: true,
			reason: `User denied remote Git write. User's reason: ${explanation}`,
		});
	});

	test("keeps denials blocked for cancelled, empty, and failed explanation prompts", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		let promptCount = 0;
		let inputValue: string | undefined;
		let failInput = false;
		safetyGate({
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				handlers[name] = handler;
			},
			registerCommand() {},
		} as any);

		const ctx = {
			cwd: "/tmp/project",
			hasUI: true,
			signal: undefined,
			ui: {
				select: async () => {
					promptCount += 1;
					return "Deny and tell model why";
				},
				input: async () => {
					if (failInput) throw new Error("dialog failed");
					return inputValue;
				},
				confirm: async () => true,
				notify: () => {},
				setStatus: () => {},
			},
		};
		const event = bash("git push origin main");
		const genericDenial = { block: true, reason: "User denied remote Git write." };

		for (const value of [undefined, "", " \t "]) {
			inputValue = value;
			expect(await handlers.tool_call(event, ctx)).toEqual(genericDenial);
		}
		inputValue = "  Wait until I review the changes.  ";
		expect(await handlers.tool_call(event, ctx)).toEqual({
			block: true,
			reason: "User denied remote Git write. User's reason: Wait until I review the changes.",
		});
		failInput = true;
		expect(await handlers.tool_call(event, ctx)).toEqual(genericDenial);
		expect(promptCount).toBe(5);
	});
});
