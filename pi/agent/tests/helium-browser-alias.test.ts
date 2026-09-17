import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeAliasRequest, type AliasDependencies } from "../extensions/helium-browser/apw-alias-tool.ts";
import { hasApprovedAlias, isAliasHostname, saveApprovedAlias } from "../extensions/helium-browser/apw-alias-store.ts";

const origin = "https://login.example.test";
const saved = "example.test";
function harness(approve = true) {
	const calls = { inspect: 0, confirm: 0, save: 0 };
	const deps: AliasDependencies = {
		origin: async () => origin,
		inspect: async () => { calls.inspect++; return [saved]; },
		save: async (destination, hostname) => {
			calls.save++;
			expect(destination).toBe("login.example.test");
			expect(hostname).toBe(saved);
		},
	};
	const ctx = { hasUI: true, ui: { confirm: async (_title: string, text: string) => {
		calls.confirm++;
		expect(text).toContain(origin);
		expect(text).toContain(saved);
		return approve;
	} } } as any;
	return { calls, deps, ctx };
}

describe("agent-facing APW aliases", () => {
	test("inspection returns hostnames without confirmation or persistence", async () => {
		const h = harness();
		const result = await executeAliasRequest({}, h.ctx, undefined, h.deps);
		expect(result.details).toMatchObject({ status: "inspected", origin, savedHostnames: [saved] });
		expect(h.calls).toEqual({ inspect: 1, confirm: 0, save: 0 });
	});

	test("requires explicit approval and saves only the requested direction", async () => {
		for (const approved of [false, true]) {
			const h = harness(approved);
			const result = await executeAliasRequest({ savedHostname: saved }, h.ctx, undefined, h.deps);
			expect(result.details.status).toBe(approved ? "saved" : "canceled");
			expect(h.calls.save).toBe(approved ? 1 : 0);
		}
	});

	test("rejects missing UI, invalid hostnames, and candidates not returned by APW", async () => {
		const h = harness();
		await expect(executeAliasRequest({ savedHostname: saved }, { ...h.ctx, hasUI: false }, undefined, h.deps)).rejects.toThrow("interactive");
		await expect(executeAliasRequest({ savedHostname: "*.example.test" }, h.ctx, undefined, h.deps)).rejects.toThrow("hostname");
		expect(h.calls.inspect).toBe(0);
		await expect(executeAliasRequest({ savedHostname: "other.test" }, h.ctx, undefined, h.deps)).rejects.toThrow("not returned");
		expect(h.calls.confirm).toBe(0);
		expect(h.calls.save).toBe(0);
	});

	test("cancellation and navigation during confirmation do not save trust", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		await expect(executeAliasRequest({}, h.ctx, controller.signal, h.deps)).rejects.toThrow();
		expect(h.calls.inspect).toBe(0);
		const pending = new AbortController();
		h.ctx.ui.confirm = async () => { pending.abort(); return true; };
		await expect(executeAliasRequest({ savedHostname: saved }, h.ctx, pending.signal, h.deps)).rejects.toThrow();
		h.ctx.ui.confirm = async () => { h.deps.origin = async () => "https://other.test"; return true; };
		await expect(executeAliasRequest({ savedHostname: saved }, h.ctx, undefined, h.deps)).rejects.toThrow("Destination changed");
		expect(h.calls.save).toBe(0);
	});

	test("persistent aliases activate immediately, do not reverse/chain, and tolerate concurrent saves", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-alias-store-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		try {
			expect(await hasApprovedAlias("login.example.test", saved)).toBe(false);
			await Promise.all([
				saveApprovedAlias("login.example.test", saved),
				saveApprovedAlias("login.example.test", saved),
				saveApprovedAlias(saved, "another.test"),
			]);
			expect(await hasApprovedAlias("login.example.test", saved)).toBe(true);
			expect(await hasApprovedAlias(saved, "login.example.test")).toBe(false);
			expect(await hasApprovedAlias("login.example.test", "another.test")).toBe(false);
			const dir = join(root, "state", "helium-apw-aliases");
			const files = await readdir(dir);
			expect(files.length).toBe(2);
			for (const file of files) await writeFile(join(dir, file), "invalid");
			await expect(hasApprovedAlias("login.example.test", saved)).rejects.toThrow("Cannot read");
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("only accepts exact DNS hostnames", () => {
		for (const value of ["*.example.test", "https://example.test", "example.test/path", "EXAMPLE.test", "example.test.", "127.0.0.1", "localhost", "../escape", "example.test:443", "-bad.test"]) expect(isAliasHostname(value)).toBe(false);
		expect(isAliasHostname("login.example.test")).toBe(true);
	});
});
