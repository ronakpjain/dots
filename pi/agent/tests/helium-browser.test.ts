import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import heliumBrowserExtension, {
	acquireHeliumOwnershipLock,
	acquireHeliumStartLock,
	buildHeliumLaunchArgs,
	classifyCdpExecutables,
	classifyOwnershipRecord,
	browserInstanceIdFromWebSocketUrl,
	filterTabScope,
	formatTabList,
	heliumSetupInstructions,
	buildNativeNotificationScript,
	parseCdpPageTargetIds,
	discoverLoginFormEvaluator,
	loginFormEvaluator,
	confirmApwLogin,
	clickElementHandle,
	disposeAllRefs,
	disposeRefHandles,
	getHeliumRefCacheStats,
	makeSnapshot,
	snapshotEvaluator,
	assertScreenshotDimensions,
	clearInterventionCooldowns,
	getInterventionCooldownCount,
	recordInterventionCooldown,
	MAX_INTERVENTION_COOLDOWNS,
	MAX_SCREENSHOT_DIMENSION,
	MAX_SCREENSHOT_PIXELS,
	MAX_SNAPSHOT_REFS,
	heliumOwnershipStatePath,
	heliumPiTabReservationsPath,
	ensurePiWindow,
	isReusableEmptyPageUrl,
	normalizeNavigationUrl,
	parseOwnershipState,
	openHeliumTab,
	openPiTab,
	resolvePage,
	waitForCausalPopup,
	parseLsofNames,
	parseLsofPids,
	HELIUM_EXECUTABLE_PATH,
	OWNERSHIP_STATE_VERSION,
} from "../extensions/helium-browser/index.ts";

type Tool = {
	name: string;
	executionMode?: string;
	parameters?: Record<string, any>;
	promptGuidelines?: string[];
	execute?: (...args: any[]) => Promise<unknown>;
};

type Runtime = {
	tools: Map<string, Tool>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	notifications: Array<{ message: string; type?: string }>;
};

function runtime(): Runtime & { pi: Record<string, unknown> } {
	const state: Runtime = {
		tools: new Map(),
		commands: new Map(),
		notifications: [],
	};
	const pi = {
		on: () => {},
		registerTool: (tool: Tool) => state.tools.set(tool.name, tool),
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			state.commands.set(name, definition),
	};
	return { ...state, pi };
}

type MockPage = {
	currentUrl: string;
	gotoCalls: string[];
	closeCalls: number;
	beforeNavigate?: (url: string) => Promise<void>;
	beforeEmptyCheck?: () => void;
	popupListener?: (page: MockPage) => void;
	onOpenPopup?: () => void;
	target(): Record<string, unknown>;
	isClosed(): boolean;
	url(): string;
	goto(url: string): Promise<void>;
	close(): Promise<void>;
	title(): Promise<string>;
	evaluate(pageFunction: unknown): Promise<unknown>;
	browserContext?: () => unknown;
	once(event: string, listener: (page: MockPage) => void): void;
	off(event: string, listener: (page: MockPage) => void): void;
	on(event: string, listener: () => void): void;
};

const defaultBrowserContext = {};

function mockPage(
	id: string,
	windowId: number,
	initialUrl: string,
	openerTarget?: unknown,
	options: { targetType?: string; context?: unknown; withoutContext?: boolean } = {},
): MockPage {
	let closed = false;
	let page!: MockPage;
	const target: Record<string, unknown> = {
		_targetId: id,
		createCDPSession: async () => ({
			send: async (method: string) => {
				if (method === "Browser.getWindowForTarget") return { windowId };
				throw new Error(`unexpected CDP method ${method}`);
			},
			detach: async () => {},
		}),
	};
	if (openerTarget) target.opener = () => openerTarget;
	target.type = () => options.targetType ?? "page";
	page = {
		currentUrl: initialUrl,
		gotoCalls: [],
		closeCalls: 0,
		target: () => target,
		isClosed: () => closed,
		url: () => page.currentUrl,
		goto: async (url) => {
			page.gotoCalls.push(url);
			await page.beforeNavigate?.(url);
			page.currentUrl = url;
		},
		close: async () => {
			closed = true;
			page.closeCalls++;
		},
		title: async () => "",
		browserContext: options.withoutContext ? undefined : () => options.context ?? defaultBrowserContext,
		evaluate: async (pageFunction) => {
			if (typeof pageFunction === "function" && String(pageFunction).includes("window.open")) {
				page.popupListener && page.onOpenPopup?.();
			} else page.beforeEmptyCheck?.();
			return true;
		},
		once: (_event, listener) => {
			page.popupListener = listener;
		},
		off: (_event, listener) => {
			if (page.popupListener === listener) page.popupListener = undefined;
		},
		on: () => {},
	};
	return page;
}

async function writeOwnershipFixture(root: string, windowId = 42): Promise<void> {
	await mkdir(join(root, "state", "helium-browser"), { recursive: true });
	await writeFile(
		heliumOwnershipStatePath(),
		JSON.stringify({ version: OWNERSHIP_STATE_VERSION, browserInstanceId: "browser-1", windowId }),
	);
}

function mockBrowser(pages: MockPage[], windowId = 42): { browser: Record<string, unknown>; popupCount: () => number } {
	let popups = 0;
	const opener = pages.find((page) => page.target().createCDPSession && page.currentUrl !== "")!;
	const openerTarget = opener.target();
	Object.defineProperty(opener, "onOpenPopup", {
		value: () => {
			const popup = mockPage(`popup-${++popups}`, windowId, "about:blank", openerTarget);
			pages.push(popup);
			opener.popupListener?.(popup);
		},
		configurable: true,
	});
	const browser = {
		pages: async () => pages.filter((page) => !page.isClosed()),
		targets: async () => pages.map((page) => ({ _targetId: page.target()._targetId, page: async () => page })),
		target: () => ({ createCDPSession: async () => ({ send: async () => ({}) }) }),
		defaultBrowserContext: () => defaultBrowserContext,
	};
	return { browser, popupCount: () => popups };
}

describe("helium browser extension setup", () => {
	test("validates navigation URLs without permitting executable schemes", () => {
		expect(normalizeNavigationUrl(" https://example.com/path ")).toBe("https://example.com/path");
		expect(normalizeNavigationUrl("about:blank")).toBe("about:blank");
		expect(() => normalizeNavigationUrl("javascript:alert(1)")).toThrow("Only http(s)");
		expect(() => normalizeNavigationUrl("file:///tmp/private.txt")).toThrow("Only http(s)");
	});

	test("builds a profile-preserving macOS launch argv", () => {
		const args = buildHeliumLaunchArgs("/Users/test/Library/Application Support/net.imput.helium");
		expect(args).toEqual([
			"-a",
			"/Applications/Helium.app",
			"--args",
			"--remote-debugging-port=9222",
			"--user-data-dir=/Users/test/Library/Application Support/net.imput.helium",
			"--profile-directory=Default",
		]);
	});

	test("explains manual setup and explicitly avoids automatic restart", () => {
		const instructions = heliumSetupInstructions();
		expect(instructions).toContain("quit Helium yourself");
		expect(instructions).toContain("--remote-debugging-port=9222");
		expect(instructions).toContain("--profile-directory=Default");
		expect(instructions).toContain("/helium window");
		expect(instructions).toContain("never kills or restarts Helium automatically");
		expect(instructions).toContain("every page is an empty new tab");
		expect(instructions).toContain("Status and tabs stay read-only");
		expect(instructions).not.toContain("open -na");
	});

	test("requires an unambiguous Helium executable for a CDP listener", () => {
		expect(parseLsofPids("p123\np123\n")).toEqual(["123"]);
		expect(parseLsofNames("p123\nn/Applications/Helium.app/Contents/MacOS/Helium\n")).toEqual([
			HELIUM_EXECUTABLE_PATH,
		]);
		expect(classifyCdpExecutables([HELIUM_EXECUTABLE_PATH])).toBe("helium");
		expect(classifyCdpExecutables(["/tmp/fake-browser"])).toBe("foreign");
		expect(classifyCdpExecutables([HELIUM_EXECUTABLE_PATH, "/mapped/framework"])).toBe("helium");
		expect(classifyCdpExecutables(["/tmp/fake-browser", HELIUM_EXECUTABLE_PATH])).toBe("foreign");
		expect(classifyCdpExecutables([])).toBe("unknown");
	});

	test("parses ownership state and derives a stable browser instance id", () => {
		expect(
			parseOwnershipState(
				JSON.stringify({ version: OWNERSHIP_STATE_VERSION, browserInstanceId: "browser-1", windowId: 42 }),
			),
		).toEqual({ version: OWNERSHIP_STATE_VERSION, browserInstanceId: "browser-1", windowId: 42 });
		expect(parseOwnershipState({ version: 99, browserInstanceId: "browser-1", windowId: 42 })).toBeUndefined();
		expect(
			parseOwnershipState({ version: OWNERSHIP_STATE_VERSION, browserInstanceId: "", windowId: 42 }),
		).toBeUndefined();
		expect(browserInstanceIdFromWebSocketUrl("ws://127.0.0.1:9222/devtools/browser/abc-123")).toBe("abc-123");
		expect(browserInstanceIdFromWebSocketUrl("http://127.0.0.1:9222/json/version")).toBeUndefined();
		expect(
			parseCdpPageTargetIds([
				{ id: "page-1", type: "page" },
				{ id: "frame-1", type: "iframe" },
				{ id: "page-1", type: "page" },
				{ id: "worker-1", type: "service_worker" },
				{ id: "", type: "page" },
				null,
			]),
		).toEqual(["page-1"]);
		expect(parseCdpPageTargetIds({ targets: [] })).toEqual([]);
		const state = { version: OWNERSHIP_STATE_VERSION, browserInstanceId: "browser-1", windowId: 42 } as const;
		expect(classifyOwnershipRecord(state, "other")).toEqual({ state: "stale" });
		expect(classifyOwnershipRecord(state, "browser-1")).toEqual({ state: "stale", windowId: 42 });
		expect(classifyOwnershipRecord(state, "browser-1", 42)).toEqual({ state: "owned", windowId: 42 });
	});

	test("accepts only a popup causally opened by the Pi page", async () => {
		let popupListener: ((page: unknown) => void) | undefined;
		const openerTarget = {};
		const popup = { target: () => ({ opener: () => openerTarget }), close: async () => {} };
		const opener = {
			target: () => openerTarget,
			once: (_event: string, listener: (page: unknown) => void) => {
				popupListener = listener;
			},
			off: () => {},
			evaluate: async () => {
				popupListener?.(popup);
			},
		};
		expect(await waitForCausalPopup(opener as never)).toBe(popup);
	});

	test("recognizes only known unused new-tab URLs", () => {
		expect(isReusableEmptyPageUrl("about:blank")).toBe(true);
		expect(isReusableEmptyPageUrl("chrome://new-tab-page/")).toBe(true);
		expect(isReusableEmptyPageUrl("chrome://newtab/")).toBe(true);
		expect(isReusableEmptyPageUrl("https://example.com")).toBe(false);
		expect(isReusableEmptyPageUrl("about:blank#meaningful")).toBe(false);
	});

	test("adopts an entirely blank existing default window", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-adopt-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("existing-blank", 12, "about:blank");
			const { browser } = mockBrowser([blank]);
			const ensured = await ensurePiWindow(browser as never, "browser-1");

			expect(ensured.action).toBe("adopted");
			expect(ensured.createdInitial).toBe(false);
			expect(ensured.windowId).toBe(12);
			expect(ensured.page).toBe(blank);
			expect(parseOwnershipState(await readFile(heliumOwnershipStatePath(), "utf8"))).toEqual({
				version: OWNERSHIP_STATE_VERSION,
				browserInstanceId: "browser-1",
				windowId: 12,
			});
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("adopts a new-tab window despite an extension background target without a window", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-adopt-background-target-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("existing-new-tab", 1046169135, "chrome://new-tab-page/");
			const { browser } = mockBrowser([blank]);
			let windowLookupAttempts = 0;
			const backgroundTarget = {
				_targetId: "ublock-background",
				type: () => "background_page",
				url: () => "chrome-extension://ublock0/background.html",
				createCDPSession: async () => ({
					send: async () => {
						windowLookupAttempts++;
						throw new Error("Browser window not found");
					},
					detach: async () => {},
				}),
			};
			browser.targets = async () => [backgroundTarget];

			const ensured = await ensurePiWindow(browser as never, "browser-1");

			expect(ensured.action).toBe("adopted");
			expect(ensured.windowId).toBe(1046169135);
			expect(ensured.page).toBe(blank);
			expect(windowLookupAttempts).toBe(0);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("fails closed when a window-attached target has no window id", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-adopt-uncertain-target-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("uncertain-window", 19, "chrome://new-tab-page/");
			const { browser } = mockBrowser([blank]);
			const uncertainTarget = {
				_targetId: "unknown-devtools",
				type: () => "devtools",
				url: () => "devtools://devtools/bundled/devtools_app.html",
				createCDPSession: async () => ({
					send: async () => {
						throw new Error("Browser window not found");
					},
					detach: async () => {},
				}),
			};
			browser.targets = async () => [uncertainTarget];

			await expect(ensurePiWindow(browser as never, "browser-1")).rejects.toThrow("no target id");
			expect(await readFile(heliumOwnershipStatePath(), "utf8").catch(() => undefined)).toBeUndefined();
			expect(blank.closeCalls).toBe(0);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("revalidates an adoption candidate immediately before committing ownership", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-adopt-revalidate-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("changing-blank", 12, "about:blank");
			blank.beforeEmptyCheck = () => {
				blank.currentUrl = "https://user.example/";
			};
			const { browser } = mockBrowser([blank]);

			await expect(ensurePiWindow(browser as never, "browser-1")).rejects.toThrow("no target id");
			expect(await readFile(heliumOwnershipStatePath(), "utf8").catch(() => undefined)).toBeUndefined();
			expect(blank.closeCalls).toBe(0);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("open_tab adopts a blank existing window before claiming its page", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-open-adopt-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("existing-blank", 18, "about:blank");
			const { browser } = mockBrowser([blank]);
			const opened = await openPiTab(browser as never, "browser-1", "https://adopt.example");

			expect(opened.page).toBe(blank);
			expect(opened.windowAction).toBe("adopted");
			expect(blank.gotoCalls).toEqual(["https://adopt.example/"]);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("rejects a mixed blank and meaningful existing window instead of adopting it", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-reject-adopt-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("mixed-blank", 13, "about:blank");
			const meaningful = mockPage("mixed-meaningful", 13, "https://user.example/");
			const { browser } = mockBrowser([blank, meaningful]);

			await expect(ensurePiWindow(browser as never, "browser-1")).rejects.toThrow("no target id");
			expect(await readFile(heliumOwnershipStatePath(), "utf8").catch(() => undefined)).toBeUndefined();
			expect(blank.closeCalls).toBe(0);
			expect(meaningful.closeCalls).toBe(0);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("fails closed when a page cannot prove its default browser context", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-adopt-context-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("unsupported-context", 15, "about:blank", undefined, { withoutContext: true });
			const { browser } = mockBrowser([blank]);

			await expect(ensurePiWindow(browser as never, "browser-1")).rejects.toThrow("no target id");
			expect(await readFile(heliumOwnershipStatePath(), "utf8").catch(() => undefined)).toBeUndefined();
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("excludes incognito and non-page windows from adoption", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-adopt-safety-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const incognito = mockPage("incognito", 15, "about:blank", undefined, {
				context: { isIncognito: () => true },
			});
			const devtools = mockPage("devtools", 16, "about:blank", undefined, { targetType: "devtools" });
			const { browser } = mockBrowser([incognito, devtools]);

			await expect(ensurePiWindow(browser as never, "browser-1")).rejects.toThrow("no target id");
			expect(await readFile(heliumOwnershipStatePath(), "utf8").catch(() => undefined)).toBeUndefined();
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("chooses the lowest eligible window and stable first page", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-adopt-order-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const high = mockPage("high", 20, "chrome://new-tab-page/");
			const lowB = mockPage("low-b", 10, "about:blank");
			const lowA = mockPage("low-a", 10, "about:blank");
			const { browser } = mockBrowser([high, lowB, lowA]);

			const ensured = await ensurePiWindow(browser as never, "browser-1");
			expect(ensured.action).toBe("adopted");
			expect(ensured.windowId).toBe(10);
			expect(ensured.page).toBe(lowA);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("concurrent ensure calls converge on one adopted window", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-adopt-concurrent-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("existing-blank", 14, "about:blank");
			const { browser } = mockBrowser([blank]);
			const [first, second] = await Promise.all([
				ensurePiWindow(browser as never, "browser-1"),
				ensurePiWindow(browser as never, "browser-1"),
			]);

			expect(first.action).toBe("adopted");
			expect(second.action).toBe("recovered");
			expect(first.windowId).toBe(14);
			expect(second.windowId).toBe(14);
			expect(first.page).toBe(second.page);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("read-only omitted resolution does not adopt an existing blank window", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-read-only-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("user-blank", 17, "about:blank");
			const { browser } = mockBrowser([blank]);
			await expect(resolvePage(browser as never, "browser-1", undefined, false)).rejects.toThrow(
				"No Pi-owned Helium window exists",
			);
			expect(await readFile(heliumOwnershipStatePath(), "utf8").catch(() => undefined)).toBeUndefined();
			expect(blank.closeCalls).toBe(0);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("reuses a deterministic blank Pi tab and never touches a user blank tab", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-reuse-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			await writeOwnershipFixture(stateRoot);
			const piZ = mockPage("pi-z", 42, "about:blank");
			const userBlank = mockPage("user-blank", 7, "about:blank");
			const piA = mockPage("pi-a", 42, "chrome://new-tab-page/");
			const { browser, popupCount } = mockBrowser([piZ, userBlank, piA]);

			const opened = await openPiTab(browser as never, "browser-1", "https://reuse.example");
			expect(opened.page).toBe(piA);
			expect(piA.gotoCalls).toEqual(["https://reuse.example/"]);
			expect(piZ.gotoCalls).toEqual([]);
			expect(userBlank.gotoCalls).toEqual([]);
			expect(userBlank.closeCalls).toBe(0);
			expect(popupCount()).toBe(0);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("does not reuse a blank tab reserved by another live Pi process", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-cross-process-reservation-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			await writeOwnershipFixture(stateRoot);
			const blank = mockPage("pi-blank", 42, "about:blank");
			const { browser, popupCount } = mockBrowser([blank]);
			await writeFile(
				heliumPiTabReservationsPath(),
				JSON.stringify({
					version: OWNERSHIP_STATE_VERSION,
					reservations: [{ browserInstanceId: "browser-1", targetId: "pi-blank", pid: process.ppid }],
				}),
			);

			const opened = await openPiTab(browser as never, "browser-1", "https://cross-process.example");
			expect(opened.page).not.toBe(blank);
			expect(blank.gotoCalls).toEqual([]);
			expect(popupCount()).toBe(1);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("opens a same-window popup when every Pi tab has meaningful content", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-popup-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			await writeOwnershipFixture(stateRoot);
			const existing = mockPage("pi-existing", 42, "https://existing.example/");
			const userBlank = mockPage("user-blank", 7, "about:blank");
			const { browser, popupCount } = mockBrowser([existing, userBlank]);

			const opened = await openPiTab(browser as never, "browser-1", "https://popup.example");
			expect(opened.page).not.toBe(existing);
			expect((opened.page as unknown as MockPage).gotoCalls).toEqual(["https://popup.example/"]);
			expect(existing.gotoCalls).toEqual([]);
			expect(userBlank.gotoCalls).toEqual([]);
			expect(popupCount()).toBe(1);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("serializes concurrent claims so a blank Pi tab is used only once", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-concurrent-open-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			await writeOwnershipFixture(stateRoot);
			const blank = mockPage("pi-blank", 42, "about:blank");
			let startedResolve!: () => void;
			const started = new Promise<void>((resolve) => {
				startedResolve = resolve;
			});
			let releaseResolve!: () => void;
			const released = new Promise<void>((resolve) => {
				releaseResolve = resolve;
			});
			blank.beforeNavigate = async () => {
				startedResolve();
				await released;
			};
			const { browser, popupCount } = mockBrowser([blank]);

			const firstPromise = openPiTab(browser as never, "browser-1", "https://first.example");
			const secondPromise = openPiTab(browser as never, "browser-1", "https://second.example");
			await started;
			releaseResolve();
			const [first, second] = await Promise.all([firstPromise, secondPromise]);

			expect(first.page).toBe(blank);
			expect(second.page).not.toBe(blank);
			expect(blank.gotoCalls).toEqual(["https://first.example/"]);
			expect((second.page as unknown as MockPage).gotoCalls).toEqual(["https://second.example/"]);
			expect(popupCount()).toBe(1);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("does not double-claim a blank page for concurrent blank opens", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-concurrent-blank-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			const blank = mockPage("pi-blank", 42, "about:blank");
			const { browser, popupCount } = mockBrowser([blank]);
			const [first, second] = await Promise.all([
				openPiTab(browser as never, "browser-1"),
				openPiTab(browser as never, "browser-1"),
			]);

			expect(first.page).toBe(blank);
			expect(second.page).not.toBe(blank);
			expect(popupCount()).toBe(1);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("closes only a reused Pi candidate when navigation fails", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-reuse-failure-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			await writeOwnershipFixture(stateRoot);
			const existing = mockPage("pi-existing", 42, "https://existing.example/");
			const candidate = mockPage("pi-blank", 42, "about:blank");
			candidate.beforeNavigate = async () => {
				throw new Error("reuse navigation failed");
			};
			const user = mockPage("user", 7, "https://user.example/");
			const { browser } = mockBrowser([existing, candidate, user]);

			await expect(openPiTab(browser as never, "browser-1", "https://target.example")).rejects.toThrow(
				"reuse navigation failed",
			);
			expect(candidate.closeCalls).toBe(1);
			expect(existing.closeCalls).toBe(0);
			expect(user.closeCalls).toBe(0);
			expect(parseOwnershipState(await readFile(heliumOwnershipStatePath(), "utf8"))).toEqual({
				version: OWNERSHIP_STATE_VERSION,
				browserInstanceId: "browser-1",
				windowId: 42,
			});
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("formats bounded ownership details and filters tab scope", () => {
		const tabs = [
			{ id: "pi-tab", title: "Pi", url: "about:blank", windowId: 42, ownership: "pi" as const },
			{ id: "user-tab", title: "User", url: "https://example.com", windowId: 7, ownership: "user" as const },
		];
		expect(filterTabScope(tabs, "pi").map((tab) => tab.id)).toEqual(["pi-tab"]);
		expect(filterTabScope(tabs, "user").map((tab) => tab.id)).toEqual(["user-tab"]);
		expect(formatTabList(tabs)).toContain("pi · window 42");
	});

	test("returns an initial-page claim only to the creator and keys it by browser instance", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-helium-browser-state-test-"));
		const previousRoot = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = stateRoot;
		try {
			let created = 0;
			const pages: Array<Record<string, unknown>> = [];
			const targets: Array<Record<string, unknown>> = [];
			const browser = {
				target: () => ({
					createCDPSession: async () => ({
						send: async (method: string) => {
							if (method === "Target.createTarget") {
								const id = `target-${++created}`;
								const windowId = 40 + created;
								const page = {
									target: () => ({
										_targetId: id,
										createCDPSession: async () => ({
											send: async () => ({ windowId }),
											detach: async () => {},
										}),
									}),
									isClosed: () => false,
									close: async () => {},
								};
								pages.push(page);
								targets.push({ _targetId: id, page: async () => page });
								return { targetId: id };
							}
							throw new Error(`unexpected CDP method ${method}`);
						},
						detach: async () => {},
					}),
				}),
				targets: async () => targets,
				pages: async () => pages,
			};

			const [first, concurrent] = await Promise.all([
				ensurePiWindow(browser as never, "browser-1"),
				ensurePiWindow(browser as never, "browser-1"),
			]);
			expect(first.createdInitial).toBe(true);
			expect(first.action).toBe("created");
			expect(concurrent.createdInitial).toBe(false);
			expect(concurrent.action).toBe("recovered");
			expect(created).toBe(1);

			const nextInstance = await ensurePiWindow(browser as never, "browser-2");
			expect(nextInstance.createdInitial).toBe(true);
			expect(created).toBe(2);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousRoot;
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	test("atomically excludes concurrent ownership creation and releases the lock", async () => {
		const lockDir = await mkdtemp(join(tmpdir(), "pi-helium-browser-ownership-lock-test-"));
		await rm(lockDir, { recursive: true, force: true });
		const first = await acquireHeliumOwnershipLock(lockDir);
		try {
			await expect(acquireHeliumOwnershipLock(lockDir)).rejects.toThrow("Another Helium start is in progress");
		} finally {
			await first.release();
		}
		const second = await acquireHeliumOwnershipLock(lockDir);
		await second.release();
		await rm(lockDir, { recursive: true, force: true });
	});

	test("atomically serializes launch attempts and releases the lock", async () => {
		const lockDir = await mkdtemp(join(tmpdir(), "pi-helium-browser-lock-test-"));
		await rm(lockDir, { recursive: true, force: true });
		const first = await acquireHeliumStartLock(lockDir);
		try {
			await expect(acquireHeliumStartLock(lockDir)).rejects.toThrow("Another Helium start is in progress");
		} finally {
			await first.release();
		}
		const second = await acquireHeliumStartLock(lockDir);
		await second.release();
		await rm(lockDir, { recursive: true, force: true });
	});

	test("normalizes before opening and closes a tab when navigation fails", async () => {
		let created = 0;
		let closed = 0;
		const page = {
			goto: async () => {
				throw new Error("navigation failed");
			},
			close: async () => {
				closed++;
			},
		};
		const browser = { newPage: async () => (created++, page) };

		await expect(openHeliumTab(browser as never, "javascript:alert(1)")).rejects.toThrow("Only http(s)");
		expect(created).toBe(0);
		await expect(openHeliumTab(browser as never, "https://example.com")).rejects.toThrow("navigation failed");
		expect(closed).toBe(1);
	});
});

describe("helium browser registrations", () => {
	test("registers practical tools, command, and sequential mutations", () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);

		expect([...state.tools.keys()]).toEqual([
			"helium_request_intervention",
			"helium_apw_alias",
			"helium_apw_fill",
			"helium_status",
			"helium_tabs",
			"helium_open_tab",
			"helium_navigate",
			"helium_snapshot",
			"helium_click",
			"helium_fill",
			"helium_type",
			"helium_key",
			"helium_screenshot",
		]);
		expect(state.commands.has("helium")).toBe(true);
		for (const name of [
			"helium_request_intervention",
			"helium_apw_alias",
			"helium_apw_fill",
			"helium_open_tab",
			"helium_navigate",
			"helium_snapshot",
			"helium_click",
			"helium_fill",
			"helium_type",
			"helium_key",
		]) {
			expect(state.tools.get(name)?.executionMode).toBe("sequential");
		}
	});

	test("registers bounded intervention and APW schemas with credential guidance", () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);
		const intervention = state.tools.get("helium_request_intervention")!;
		const kinds = (intervention.parameters as any).properties.kind.enum as string[];
		expect(kinds).toEqual(["login", "signup", "mfa", "passkey", "captcha", "payment", "consent", "other"]);
		expect(Object.keys((state.tools.get("helium_apw_fill")!.parameters as any).properties)).toEqual(["tabId"]);
		expect(intervention.parameters?.properties.focus).toBeDefined();
		expect(state.tools.get("helium_fill")!.promptGuidelines?.join(" ")).toContain("credentials");
		expect(state.tools.get("helium_type")!.promptGuidelines?.join(" ")).toContain("credentials");
	});

	test("rejects APW autofill before any browser or APW lookup when UI is unavailable", async () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);
		const execute = state.tools.get("helium_apw_fill")!.execute!;
		await expect(execute("call-1", {}, undefined, undefined, { hasUI: false })).rejects.toThrow("interactive UI");
	});

	test("declined APW accounts do not proceed and confirmation contains no password", async () => {
		const messages: string[] = [];
		const selected = await confirmApwLogin(
			"https://login.example.test",
			[{ username: "alice" }, { username: "bob" }],
			async (_title, message) => {
				messages.push(message);
				return false;
			},
		);
		expect(selected).toBeUndefined();
		expect(messages).toHaveLength(2);
		expect(messages[0]).toContain("Username: alice");
		expect(messages[1]).toContain("Username: bob");
		expect(messages.join(" ")).not.toContain("APW_CANARY_DO_NOT_LEAK");
	});

	test("requires positive current-login semantics and accepts a Gradescope-like Log In form", () => {
		const globals = globalThis as unknown as Record<string, any>;
		const previous = { document: globals.document, style: globals.getComputedStyle, location: globals.location };
		class FakeForm {
			controls: FakeField[] = [];
			parentElement: null = null;
			innerText = "";
			constructor(private readonly attrs: Record<string, string>) {}
			getAttribute(name: string): string | null {
				return this.attrs[name] ?? null;
			}
			querySelectorAll(): FakeField[] {
				return this.controls;
			}
		}
		class FakeField {
			form: FakeForm | null = null;
			parentElement: FakeForm | null = null;
			isConnected = true;
			textContent = "";
			onDispatch: (() => void) | undefined;
			constructor(
				public type: string,
				public name: string,
				public value = "",
				public autocomplete = "",
				private readonly attrs: Record<string, string> = {},
			) {}
			getAttribute(name: string): string | null {
				return this.attrs[name] ?? (name === "type" ? this.type : null);
			}
			closest(selector: string): FakeForm | null {
				return selector === "form" ? this.form : null;
			}
			getBoundingClientRect(): { width: number; height: number } {
				return { width: 100, height: 20 };
			}
			dispatchEvent(): boolean {
				this.onDispatch?.();
				return true;
			}
		}
		const makeForm = (action: string, buttonText: string, passwordAutocomplete = "") => {
			const form = new FakeForm({ action });
			const utf8 = new FakeField("hidden", "utf8");
			const authenticity = new FakeField("hidden", "authenticity_token");
			const username = new FakeField("email", "session[email]", "", "email");
			const password = new FakeField("password", "session[password]", "", passwordAutocomplete);
			const rememberEmail = new FakeField("checkbox", "session[remember_me]", "", "", {
				"aria-label": "Remember me, email login",
			});
			const button = new FakeField("submit", "commit", buttonText);
			const rememberSso = new FakeField("checkbox", "session[remember_me_sso]", "", "", {
				"aria-label": "Remember me, SSO login",
			});
			const fields = [utf8, authenticity, username, password, rememberEmail, button, rememberSso];
			for (const field of fields) {
				field.form = form;
				field.parentElement = form;
			}
			form.controls = [button];
			globals.document = {
				querySelectorAll: (selector: string) => (selector === "input" ? fields : [form]),
			};
			return { form, username, password };
		};
		try {
			globals.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
			const signup = makeForm("/users", "Sign Up");
			expect(discoverLoginFormEvaluator()).toBeUndefined();
			const reset = makeForm("/password", "Reset password");
			expect(discoverLoginFormEvaluator()).toBeUndefined();
			const gradescope = makeForm("/users/sign_in", "Log In", "current-password");
			const discovered = discoverLoginFormEvaluator();
			expect(discovered).toBeDefined();
			expect(discovered).not.toBe(signup);
			expect(reset.form.innerText).toBe("");
			globals.location = { protocol: "https:", origin: "https://gradescope.test" };
			const canary = "APW_PASSWORD_CANARY";
			let passwordWasAssignedBeforeEvent = false;
			gradescope.username.onDispatch = () => {
				passwordWasAssignedBeforeEvent = gradescope.password.value === canary;
			};
			const filled = loginFormEvaluator("fill", "https://gradescope.test", "alice", canary);
			expect(filled).toBe(true);
			expect(passwordWasAssignedBeforeEvent).toBe(true);
			expect(JSON.stringify(filled)).not.toContain(canary);
		} finally {
			if (previous.document === undefined) delete globals.document;
			else globals.document = previous.document;
			if (previous.style === undefined) delete globals.getComputedStyle;
			else globals.getComputedStyle = previous.style;
			if (previous.location === undefined) delete globals.location;
			else globals.location = previous.location;
		}
	});

	test("redacts current/new password fields from snapshots", () => {
		const globals = globalThis as unknown as Record<string, any>;
		const previous = {
			document: globals.document,
			input: globals.HTMLInputElement,
			style: globals.getComputedStyle,
		};
		class FakeInput {
			value = "APW_CANARY_DO_NOT_LEAK";
			private attributes = { type: "text", autocomplete: "current-password" } as Record<string, string>;
			getAttribute(name: string): string | null {
				return this.attributes[name] ?? null;
			}
			removeAttribute(name: string): void {
				delete this.attributes[name];
			}
			matches(): boolean {
				return true;
			}
			set textContent(value: string) {
				this.value = value;
			}
		}
		class FakeBody {
			constructor(private readonly input: FakeInput) {}
			cloneNode(): FakeBody {
				return new FakeBody(Object.assign(new FakeInput(), { value: this.input.value }));
			}
			querySelectorAll(): FakeInput[] {
				return [this.input];
			}
			get innerText(): string {
				return this.input.value;
			}
		}
		try {
			const input = new FakeInput();
			globals.HTMLInputElement = FakeInput;
			globals.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
			globals.document = { body: new FakeBody(input), querySelectorAll: () => [] };
			const snapshot = snapshotEvaluator(false);
			expect(snapshot.bodyText).not.toContain("APW_CANARY_DO_NOT_LEAK");
		} finally {
			if (previous.document === undefined) delete globals.document;
			else globals.document = previous.document;
			if (previous.input === undefined) delete globals.HTMLInputElement;
			else globals.HTMLInputElement = previous.input;
			if (previous.style === undefined) delete globals.getComputedStyle;
			else globals.getComputedStyle = previous.style;
		}
	});

	test("bounds body text inside the snapshot evaluator", () => {
		const globals = globalThis as unknown as Record<string, any>;
		const previousDocument = globals.document;
		const body = {
			cloneNode: () => body,
			querySelectorAll: () => [],
			innerText: "x".repeat(10_000),
		};
		try {
			globals.document = { body, querySelectorAll: () => [] };
			const snapshot = snapshotEvaluator(false, 128);
			expect(snapshot.bodyText).toHaveLength(128);
			expect(snapshot.bodyTruncated).toBe(true);
		} finally {
			if (previousDocument === undefined) delete globals.document;
			else globals.document = previousDocument;
		}
	});

	test("disposes every stored handle during central browser cleanup", async () => {
		await disposeAllRefs();
		const disposed: string[] = [];
		const page = {
			evaluate: async () => ({
				bodyText: "body",
				refs: [
					{ ref: "e1", label: "one", kind: "button" },
					{ ref: "e2", label: "two", kind: "button" },
				],
			}),
			$: async (selector: string) => ({
				dispose: async () => {
					const ref = selector.match(/e\d+/)?.[0] ?? "unknown";
					disposed.push(ref);
					if (ref === "e1") throw new Error("already detached");
				},
			}),
			isClosed: () => false,
			url: () => "https://example.test",
			title: async () => "Example",
		};

		await makeSnapshot(page as never, "cleanup-tab", 10_000, true);
		expect(getHeliumRefCacheStats()).toEqual({ tabCount: 1, handleCount: 2 });
		await disposeAllRefs();
		expect(disposed.sort()).toEqual(["e1", "e2"]);
		expect(getHeliumRefCacheStats()).toEqual({ tabCount: 0, handleCount: 0 });
	});

	test("caps snapshot refs and allocates handles with bounded concurrency", async () => {
		await disposeAllRefs();
		let active = 0;
		let peak = 0;
		let allocations = 0;
		const refs = Array.from({ length: MAX_SNAPSHOT_REFS + 50 }, (_, index) => ({
			ref: `e${index + 1}`,
			label: "button",
			kind: "button",
		}));
		const page = {
			evaluate: async () => ({ bodyText: "body", bodyTruncated: false, refs, omittedCandidateCount: 50 }),
			$: async () => {
				allocations++;
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active--;
				return { dispose: async () => {} };
			},
			isClosed: () => false,
			url: () => "https://example.test",
			title: async () => "Example",
		};

		const snapshot = await makeSnapshot(page as never, "bounded-tab", 30_000, true);
		expect(allocations).toBe(MAX_SNAPSHOT_REFS);
		expect(peak).toBeLessThanOrEqual(8);
		expect(snapshot).toContain("Interactive candidates truncated");
		expect(getHeliumRefCacheStats().handleCount).toBe(MAX_SNAPSHOT_REFS);
		await disposeAllRefs();
	});

	test("bounds disposal concurrency across a handle batch", async () => {
		let active = 0;
		let peak = 0;
		let disposed = 0;
		const handles = Array.from({ length: 40 }, () => ({
			dispose: async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active--;
				disposed++;
			},
		}));
		await disposeRefHandles(handles as never);
		expect(disposed).toBe(40);
		expect(peak).toBeLessThanOrEqual(8);
	});

	test("prunes and caps intervention cooldowns", () => {
		clearInterventionCooldowns();
		for (let index = 0; index < MAX_INTERVENTION_COOLDOWNS + 20; index++) {
			expect(recordInterventionCooldown(`key-${index}`, 1_000)).toBe(true);
		}
		expect(getInterventionCooldownCount()).toBe(MAX_INTERVENTION_COOLDOWNS);
		expect(recordInterventionCooldown("fresh", 62_000)).toBe(true);
		expect(getInterventionCooldownCount()).toBe(1);
		clearInterventionCooldowns();
	});

	test("rejects excessive full-page screenshot dimensions before capture", () => {
		expect(() => assertScreenshotDimensions({ width: 1_000, height: 1_000 })).not.toThrow();
		expect(() => assertScreenshotDimensions({ width: MAX_SCREENSHOT_DIMENSION + 1, height: 1 })).toThrow(
			"too large",
		);
		expect(() => assertScreenshotDimensions({ width: 10_000, height: MAX_SCREENSHOT_PIXELS / 10_000 + 1 })).toThrow(
			"too large",
		);
	});

	test("disposes fulfilled snapshot handles when a parallel allocation fails", async () => {
		await disposeAllRefs();
		const disposed: string[] = [];
		const page = {
			evaluate: async () => ({
				bodyText: "body",
				refs: [
					{ ref: "e1", label: "one", kind: "button" },
					{ ref: "e2", label: "two", kind: "button" },
					{ ref: "e3", label: "three", kind: "button" },
				],
			}),
			$: async (selector: string) => {
				if (selector.includes("e2")) throw new Error("partial allocation failed");
				return { dispose: async () => disposed.push(selector.match(/e\d+/)?.[0] ?? "unknown") };
			},
			isClosed: () => false,
			url: () => "https://example.test",
			title: async () => "Example",
		};

		await expect(makeSnapshot(page as never, "partial-tab", 10_000, true)).rejects.toThrow(
			"partial allocation failed",
		);
		expect(disposed.sort()).toEqual(["e1", "e3"]);
		expect(getHeliumRefCacheStats()).toEqual({ tabCount: 0, handleCount: 0 });
	});

	test("does not retain per-tab generation state after repeated empty snapshots", async () => {
		await disposeAllRefs();
		const page = {
			evaluate: async () => ({ bodyText: "body", refs: [] }),
			isClosed: () => false,
			url: () => "https://example.test",
			title: async () => "Example",
		};
		for (let index = 0; index < 40; index++) {
			await makeSnapshot(page as never, `empty-tab-${index}`, 10_000, true);
		}
		expect(getHeliumRefCacheStats()).toEqual({ tabCount: 0, handleCount: 0 });
	});

	test("reports stale and non-actionable clicks and retries only the exact handle", async () => {
		const globals = globalThis as unknown as Record<string, any>;
		const previous = {
			htmlElement: globals.HTMLElement,
			style: globals.getComputedStyle,
			document: globals.document,
		};
		class FakeElement {
			isConnected = true;
			parentElement: FakeElement | null = null;
			hidden = false;
			getAttribute(): string | null {
				return null;
			}
			getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
				return { left: 0, top: 0, width: 100, height: 20 };
			}
			contains(element: unknown): boolean {
				return element === this;
			}
			scrollIntoView(): void {}
		}
		const handleFor = (element: FakeElement, click: () => Promise<void>) => ({
			evaluate: async (fn: (value: FakeElement, ...args: any[]) => unknown, ...args: any[]) =>
				fn(element, ...args),
			click,
		});
		try {
			globals.HTMLElement = FakeElement;
			globals.getComputedStyle = (element: FakeElement) => ({
				display: element.hidden ? "none" : "block",
				visibility: "visible",
				opacity: "1",
				pointerEvents: "auto",
			});
			const element = new FakeElement();
			globals.document = { elementFromPoint: () => element };
			const stale = new FakeElement();
			stale.isConnected = false;
			await expect(
				clickElementHandle(handleFor(stale, async () => {}) as never, "ref e1") as never,
			).rejects.toThrow("Stale ref e1");

			element.hidden = true;
			await expect(
				clickElementHandle(handleFor(element, async () => {}) as never, "ref e2") as never,
			).rejects.toThrow("not visible/actionable");

			element.hidden = false;
			let clicks = 0;
			const exactHandle = handleFor(element, async () => {
				clicks++;
				if (clicks === 1) throw new Error("Node is either not clickable or not an Element");
			});
			await clickElementHandle(exactHandle as never, "ref e3");
			expect(clicks).toBe(2);
		} finally {
			if (previous.htmlElement === undefined) delete globals.HTMLElement;
			else globals.HTMLElement = previous.htmlElement;
			if (previous.style === undefined) delete globals.getComputedStyle;
			else globals.getComputedStyle = previous.style;
			if (previous.document === undefined) delete globals.document;
			else globals.document = previous.document;
		}
	});

	test("clicks a background tab without waiting for Puppeteer intersection", async () => {
		const globals = globalThis as unknown as Record<string, any>;
		const previous = {
			htmlElement: globals.HTMLElement,
			style: globals.getComputedStyle,
			document: globals.document,
		};
		class FakeElement {
			isConnected = true;
			parentElement: FakeElement | null = null;
			clicks = 0;
			getAttribute(): string | null {
				return null;
			}
			getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
				return { left: 0, top: 0, width: 100, height: 20 };
			}
			contains(element: unknown): boolean {
				return element === this;
			}
			scrollIntoView(): void {}
			click(): void {
				this.clicks++;
			}
		}
		try {
			globals.HTMLElement = FakeElement;
			globals.getComputedStyle = () => ({
				display: "block",
				visibility: "visible",
				opacity: "1",
				pointerEvents: "auto",
			});
			const element = new FakeElement();
			globals.document = { hidden: true, elementFromPoint: () => element };
			const page = {
				evaluate: async (fn: (value: FakeElement) => unknown) => fn(element),
				mouse: {
					click: async () => {
						throw new Error("mouse click should not be used for a background tab");
					},
				},
			};
			const handle = {
				evaluate: async (fn: (value: FakeElement, ...args: any[]) => unknown, ...args: any[]) =>
					fn(element, ...args),
				boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 20 }),
				frame: { page: () => page },
				click: async () => {
					throw new Error("intersection wait");
				},
			};
			await clickElementHandle(handle as never, "ref background");
			expect(element.clicks).toBe(1);
		} finally {
			if (previous.htmlElement === undefined) delete globals.HTMLElement;
			else globals.HTMLElement = previous.htmlElement;
			if (previous.style === undefined) delete globals.getComputedStyle;
			else globals.getComputedStyle = previous.style;
			if (previous.document === undefined) delete globals.document;
			else globals.document = previous.document;
		}
	});

	test("escapes notification content and keeps optional focus bounded to Helium", () => {
		const script = buildNativeNotificationScript("Helium", 'origin"; tell application "evil"\nreturn 1', true);
		expect(script).toContain(
			'display notification "origin\\"; tell application \\"evil\\" return 1" with title "Helium"',
		);
		expect(script).not.toContain("\nreturn 1");
		expect(script).not.toContain('tell application "evil"');
		expect(script).toContain('tell application id "net.imput.helium" to activate');
	});

	test("provides help without touching the browser", async () => {
		const state = runtime();
		heliumBrowserExtension(state.pi as never);
		const ctx = {
			signal: undefined,
			ui: { notify: (message: string, type?: string) => state.notifications.push({ message, type }) },
		};
		await state.commands.get("helium")!.handler("help", ctx);
		expect(state.notifications).toHaveLength(1);
		expect(state.notifications[0].message).toContain("Helium browser extension setup");
		expect(state.notifications[0].type).toBe("info");
	});
});
