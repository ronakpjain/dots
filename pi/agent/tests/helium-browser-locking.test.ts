import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireHeliumStartLock,
	heliumOwnershipStatePath,
	openPiTab,
	OWNERSHIP_STATE_VERSION,
	profileLockState,
	waitForCausalPopup,
} from "../extensions/helium-browser/index.ts";

function blankPage(id: string, windowId = 42): any {
	let closed = false;
	const target = {
		_targetId: id,
		type: () => "page",
		createCDPSession: async () => ({
			send: async () => ({ windowId }),
			detach: async () => {},
		}),
	};
	return {
		target: () => target,
		browserContext: () => ({ isIncognito: () => false }),
		isClosed: () => closed,
		url: () => "about:blank",
		title: async () => "",
		evaluate: async () => true,
		goto: async () => {},
		close: async () => {
			closed = true;
		},
	};
}

describe("Helium locking and ownership safety", () => {
	test("reclaims a stale lock only after validating the published owner", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-helium-lock-reclaim-test-"));
		const lockPath = join(root, "start.lock");
		try {
			await mkdir(lockPath);
			await writeFile(
			join(lockPath, "owner.json"),
			JSON.stringify({ pid: 2_000_000_000, token: "old", startedAt: new Date(0).toISOString() }),
			);
			const lock = await acquireHeliumStartLock(lockPath);
			try {
				const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { token: string };
				expect(owner.token).not.toBe("old");
			} finally {
				await lock.release();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("three contenders cannot acquire around a live lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-helium-three-contender-lock-test-"));
		const lockPath = join(root, "start.lock");
		try {
			const first = await acquireHeliumStartLock(lockPath);
			try {
				const ownerBefore = await readFile(join(lockPath, "owner.json"), "utf8");
				const attempts = await Promise.all(
					[1, 2, 3].map(async () => {
						try {
							await acquireHeliumStartLock(lockPath);
							return "acquired";
						} catch (error) {
							return String(error);
						}
					}),
				);
				expect(attempts.every((result) => result !== "acquired")).toBe(true);
				expect(await readFile(join(lockPath, "owner.json"), "utf8")).toBe(ownerBefore);
			} finally {
				await first.release();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("recovers an ownerless crash remnant without deleting a fresh lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-helium-ownerless-lock-test-"));
		const lockPath = join(root, "start.lock");
		try {
			await mkdir(lockPath);
			const lock = await acquireHeliumStartLock(lockPath);
			await lock.release();
			expect(await readFile(join(lockPath, "owner.json"), "utf8").catch(() => undefined)).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("treats a dangling Chromium SingletonLock entry as present", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-helium-profile-lock-test-"));
		const lockPath = join(root, "SingletonLock");
		try {
			await symlink("host-does-not-exist-999999", lockPath);
			expect(await profileLockState(lockPath)).toBe("locked");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("retains a returned blank claim across sequential opens", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-helium-sequential-blank-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		try {
			await mkdir(join(root, "state", "helium-browser"), { recursive: true });
			await writeFile(
				heliumOwnershipStatePath(),
				JSON.stringify({ version: OWNERSHIP_STATE_VERSION, browserInstanceId: "browser-sequential", windowId: 42 }),
			);
			const firstPage = blankPage("blank-a");
			const secondPage = blankPage("blank-b");
			const browser = {
				pages: async () => [firstPage, secondPage],
				targets: async () => [],
			};
			const first = await openPiTab(browser as never, "browser-sequential");
			const second = await openPiTab(browser as never, "browser-sequential");
			expect(first.page).toBe(firstPage);
			expect(second.page).toBe(secondPage);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(root, { recursive: true, force: true });
		}
	});

	test("ignores an unrelated same-opener popup and accepts the named request", async () => {
		const openerTarget = {};
		const onListeners = new Set<(page: any) => void>();
		const onceListeners = new Set<(page: any) => void>();
		const emit = (page: any) => {
			for (const listener of [...onListeners, ...onceListeners]) listener(page);
			onceListeners.clear();
		};
		const makePopup = (name: string) => {
			let closeCalls = 0;
			return {
				target: () => ({ opener: () => openerTarget }),
				url: () => "about:blank",
				evaluate: async () => name,
				isClosed: () => false,
				close: async () => {
					closeCalls++;
				},
				closeCalls: () => closeCalls,
			};
		};
		let unrelated: any;
		let requested: any;
		const opener = {
			target: () => openerTarget,
			on: (_event: string, listener: (page: any) => void) => onListeners.add(listener),
			once: (_event: string, listener: (page: any) => void) => onceListeners.add(listener),
			off: (_event: string, listener: (page: any) => void) => {
				onListeners.delete(listener);
				onceListeners.delete(listener);
			},
			evaluate: async (_fn: unknown, name: string) => {
				unrelated = makePopup("other-popup");
				emit(unrelated);
				requested = makePopup(name);
				emit(requested);
			},
		};
		expect(await waitForCausalPopup(opener as never)).toBe(requested);
		expect(unrelated.closeCalls()).toBe(0);
	});
});
