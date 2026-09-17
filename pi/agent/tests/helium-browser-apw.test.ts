import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	APW_PROTOCOL_VERSION,
	apwStatus,
	assertExactHttpsOrigin,
	getApwCredential,
	isExactHttpsOrigin,
	inspectApwSavedHostnames,
	listApwLogins,
} from "../extensions/helium-browser/apw.ts";

import { saveApprovedAlias } from "../extensions/helium-browser/apw-alias-store.ts";

const ORIGIN = "https://login.example.test";
const WWW_ORIGIN = "https://www.example.test";
const APEX_ORIGIN = "https://example.test";
const CANARY = "APW_CANARY_DO_NOT_LEAK";

type FixtureOptions = {
	mode: string;
	json?: unknown;
	stderr?: string;
	expectedArgs?: string[];
};

async function withFakeApw<T>(fixture: FixtureOptions, operation: () => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pi-helium-apw-test-"));
	const executable = join(root, "fake-apw.mjs");
	const source = `#!${process.execPath}
const args = process.argv.slice(2);
const mode = process.env.APW_FIXTURE_MODE;
const expectedArgs = process.env.APW_FIXTURE_EXPECTED_ARGS;
if (expectedArgs !== undefined && JSON.stringify(args) !== expectedArgs) {
  process.stderr.write("unexpected invocation");
  process.exit(8);
} else if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write(process.env.APW_FIXTURE_STDERR || "fixture stderr");
  process.stdout.write(process.env.APW_FIXTURE_JSON || "{}");
  process.exit(7);
} else if (args[0] === "--version") {
  process.stdout.write("v${APW_PROTOCOL_VERSION} ${CANARY}");
} else if (args[0] === "pw" && args[1] === "list" && args[3] === "--json") {
  process.stdout.write(process.env.APW_FIXTURE_JSON || "{}");
} else if (args[0] === "pw" && args[1] === "get" && args[4] === "--json") {
  process.stdout.write(process.env.APW_FIXTURE_JSON || "{}");
} else {
  process.stderr.write("unexpected invocation ${CANARY}");
  process.exit(9);
}
`;
	await writeFile(executable, source, { encoding: "utf8", mode: 0o700 });
	await chmod(executable, 0o700);
	const previousPath = process.env.PI_HELIUM_APW_PATH;
	const previousMode = process.env.APW_FIXTURE_MODE;
	const previousJson = process.env.APW_FIXTURE_JSON;
	const previousStderr = process.env.APW_FIXTURE_STDERR;
	const previousExpectedArgs = process.env.APW_FIXTURE_EXPECTED_ARGS;
	process.env.PI_HELIUM_APW_PATH = executable;
	process.env.APW_FIXTURE_MODE = fixture.mode;
	process.env.APW_FIXTURE_JSON = JSON.stringify(fixture.json ?? {});
	if (fixture.expectedArgs === undefined) delete process.env.APW_FIXTURE_EXPECTED_ARGS;
	else process.env.APW_FIXTURE_EXPECTED_ARGS = JSON.stringify(fixture.expectedArgs);
	if (fixture.stderr === undefined) delete process.env.APW_FIXTURE_STDERR;
	else process.env.APW_FIXTURE_STDERR = fixture.stderr;
	try {
		return await operation();
	} finally {
		if (previousPath === undefined) delete process.env.PI_HELIUM_APW_PATH;
		else process.env.PI_HELIUM_APW_PATH = previousPath;
		if (previousMode === undefined) delete process.env.APW_FIXTURE_MODE;
		else process.env.APW_FIXTURE_MODE = previousMode;
		if (previousJson === undefined) delete process.env.APW_FIXTURE_JSON;
		else process.env.APW_FIXTURE_JSON = previousJson;
		if (previousStderr === undefined) delete process.env.APW_FIXTURE_STDERR;
		else process.env.APW_FIXTURE_STDERR = previousStderr;
		if (previousExpectedArgs === undefined) delete process.env.APW_FIXTURE_EXPECTED_ARGS;
		else process.env.APW_FIXTURE_EXPECTED_ARGS = previousExpectedArgs;
		await rm(root, { recursive: true, force: true });
	}
}

describe("standalone APW adapter", () => {
	test("exports the APW 1.1.1 contract and accepts only exact HTTPS origins", () => {
		expect(APW_PROTOCOL_VERSION).toBe("1.1.1");
		expect(isExactHttpsOrigin(ORIGIN, ORIGIN)).toBe(true);
		expect(isExactHttpsOrigin("https://login.example.test/", ORIGIN)).toBe(false);
		expect(isExactHttpsOrigin("https://sub.login.example.test", ORIGIN)).toBe(false);
		expect(isExactHttpsOrigin("http://login.example.test", ORIGIN)).toBe(false);
		expect(isExactHttpsOrigin("https://login.example.test.evil", ORIGIN)).toBe(false);
		expect(() => assertExactHttpsOrigin("https://login.example.test/path")).toThrow("exact HTTPS origin");
	});

	test("uses hostname argv while keeping www and apex hosts distinct", async () => {
		const wwwList = await withFakeApw(
			{
				mode: "list",
				expectedArgs: ["pw", "list", "www.example.test", "--json"],
				json: { results: [{ username: "www-user", domain: "www.example.test" }], status: 0 },
			},
			() => listApwLogins(WWW_ORIGIN),
		);
		expect(wwwList).toEqual([{ username: "www-user" }]);

		const wwwCredential = await withFakeApw(
			{
				mode: "get",
				expectedArgs: ["pw", "get", "www.example.test", "www-user", "--json"],
				json: { results: [{ username: "www-user", domain: "www.example.test", password: CANARY }], status: 0 },
			},
			() => getApwCredential(WWW_ORIGIN, "www-user"),
		);
		expect(wwwCredential).toEqual({ username: "www-user", password: CANARY });

		const apexList = await withFakeApw(
			{
				mode: "list",
				expectedArgs: ["pw", "list", "example.test", "--json"],
				json: { results: [{ username: "apex-user", domain: "example.test" }], status: 0 },
			},
			() => listApwLogins(APEX_ORIGIN),
		);
		expect(apexList).toEqual([{ username: "apex-user" }]);

		const apexCredential = await withFakeApw(
			{
				mode: "get",
				expectedArgs: ["pw", "get", "example.test", "apex-user", "--json"],
				json: { results: [{ username: "apex-user", domain: "example.test", password: CANARY }], status: 0 },
			},
			() => getApwCredential(APEX_ORIGIN, "apex-user"),
		);
		expect(apexCredential).toEqual({ username: "apex-user", password: CANARY });

		await withFakeApw(
			{
				mode: "list",
				expectedArgs: ["pw", "list", "www.example.test", "--json"],
				json: { results: [{ username: "apex-user", domain: "example.test" }], status: 0 },
			},
			async () => expect(listApwLogins(WWW_ORIGIN)).rejects.toThrow("another hostname"),
		);
	});

	test("accepts only the reviewed Gradescope alias in list and get without changing destination argv", async () => {
		for (const [host, saved] of [["www.gradescope.com", "gradescope.com"], ["gradescope.com", "www.gradescope.com"]]) {
			const origin = `https://${host}`;
			for (const command of ["list", "get"]) {
				const result = await withFakeApw<unknown>({
					mode: command,
					expectedArgs: ["pw", command, host, ...(command === "get" ? ["alice"] : []), "--json"],
					json: { status: 0, results: [{ username: "alice", domain: saved, password: CANARY }] },
				}, async () => command === "list" ? await listApwLogins(origin) : await getApwCredential(origin, "alice"));
				expect(result).toEqual(command === "list" ? [{ username: "alice" }] : { username: "alice", password: CANARY });
			}
			expect(isExactHttpsOrigin(`https://${saved}`, origin)).toBe(false);
		}
	});

	test("rejects unreviewed Gradescope subdomains, suffix attacks, and URL-shaped saved domains", async () => {
		for (const domain of ["login.gradescope.com", "www.www.gradescope.com", "gradescope.com.evil", "https://gradescope.com", "gradescope.com/", "GRADESCOPE.COM"]) {
			for (const command of ["list", "get"]) {
				await withFakeApw({ mode: command, json: { status: 0, results: [{ username: "alice", domain, password: CANARY }] } }, async () => {
					await expect(command === "list" ? listApwLogins("https://www.gradescope.com") : getApwCredential("https://www.gradescope.com", "alice")).rejects.toThrow("another hostname");
				});
			}
		}
		await withFakeApw({ mode: "list", json: { status: 0, results: [{ username: "alice", domain: "gradescope.com" }] } }, async () => {
			await expect(listApwLogins("https://login.gradescope.com")).rejects.toThrow("another hostname");
		});
	});

	test("alias inspection redacts account data and approved aliases work in both list and get immediately", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-apw-alias-adapter-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		try {
			await withFakeApw({ mode: "list", json: { status: 0, results: [{ domain: "example.test", username: "private-account", password: CANARY }] } }, async () => {
				expect(await inspectApwSavedHostnames(ORIGIN)).toEqual(["example.test"]);
				await expect(listApwLogins(ORIGIN)).rejects.toThrow("another hostname");
				await saveApprovedAlias("login.example.test", "example.test");
				expect(await listApwLogins(ORIGIN)).toEqual([{ username: "private-account" }]);
			});
			await withFakeApw({ mode: "get", expectedArgs: ["pw", "get", "login.example.test", "private-account", "--json"], json: { status: 0, results: [{ domain: "example.test", username: "private-account", password: CANARY }] } }, async () => {
				expect(await getApwCredential(ORIGIN, "private-account")).toEqual({ username: "private-account", password: CANARY });
			});
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("lists metadata with the exact pw list argv and never returns list secrets", async () => {
		const result = await withFakeApw(
			{
				mode: "list",
				expectedArgs: ["pw", "list", "login.example.test", "--json"],
				json: {
					results: [
						{ username: "alice", domain: "login.example.test", password: CANARY },
						{ username: "alice", domain: "login.example.test" },
					],
					status: 0,
				},
			},
			() => listApwLogins(ORIGIN),
		);
		expect(result).toEqual([{ username: "alice" }]);
		expect(JSON.stringify(result)).not.toContain(CANARY);
	});

	test("retrieves only the selected exact-origin credential", async () => {
		const result = await withFakeApw(
			{
				mode: "get",
				expectedArgs: ["pw", "get", "login.example.test", "alice", "--json"],
				json: {
					results: [
						{ username: "alice", domain: "login.example.test", password: CANARY },
						{ username: "bob", domain: "login.example.test", password: "other" },
					],
					status: 0,
				},
			},
			() => getApwCredential(ORIGIN, "alice"),
		);
		expect(result).toEqual({ username: "alice", password: CANARY });
	});

	test("rejects strict-domain violations and malformed JSON without exposing fixture data", async () => {
		await withFakeApw(
			{
				mode: "list",
				json: { results: [{ username: "alice", domain: "login.example.test.evil" }], status: 0 },
			},
			async () => {
				await expect(listApwLogins(ORIGIN)).rejects.toThrow("another hostname");
			},
		);

		await withFakeApw(
			{
				mode: "get",
				json: { results: [{ username: "alice", domain: "login.example.test", password: "" }], status: 0 },
			},
			async () => {
				await expect(getApwCredential(ORIGIN, "alice")).rejects.toThrow("no usable password");
			},
		);

		const error = await withFakeApw(
			{ mode: "malformed", json: `${CANARY} not-json`, stderr: `stderr-${CANARY}` },
			async () => {
				try {
					await listApwLogins(ORIGIN);
					throw new Error("expected APW failure");
				} catch (caught) {
					return caught instanceof Error ? caught.message : String(caught);
				}
			},
		);
		expect(error).not.toContain(CANARY);
	});

	test("bounds commands and supports caller cancellation", async () => {
		const timeoutError = await withFakeApw({ mode: "timeout" }, async () => {
			try {
				await listApwLogins(ORIGIN, { timeoutMs: 25 });
				throw new Error("expected timeout");
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		});
		expect(timeoutError).toBe("APW command timed out");

		const abortError = await withFakeApw({ mode: "timeout" }, async () => {
			const controller = new AbortController();
			const pending = listApwLogins(ORIGIN, { signal: controller.signal, timeoutMs: 5_000 });
			setTimeout(() => controller.abort(), 25);
			try {
				await pending;
				throw new Error("expected abort");
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		});
		expect(abortError).toBe("APW command aborted");
	});

	test("inspects an executable without claiming daemon authentication", async () => {
		const status = await withFakeApw({ mode: "version" }, () => apwStatus({ timeoutMs: 100 }));
		expect(status.installed).toBe(true);
		expect(status.socket).toBe("unknown");
		expect(status.authenticated).toBe("unknown");
	});
});
