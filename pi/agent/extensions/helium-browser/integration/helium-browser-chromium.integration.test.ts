import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import {
	ActionCanceledError,
	assertScreenshotDimensions,
	disposeAllRefs,
	getHeliumRefCacheStats,
	loginFormEvaluator,
	makeSnapshot,
	withTabMutation,
} from "../index.ts";

/**
 * Opt-in real Chromium coverage. The normal package checks do not run this
 * file, and it also skips its describe block unless explicitly enabled, so CI
 * and development checks never start a browser accidentally.
 */
const integrationEnabled = process.env.HELIUM_BROWSER_INTEGRATION === "1";
const executablePath = findChromiumExecutable();
const integrationDescribe = integrationEnabled && executablePath ? describe : describe.skip;
const fixture = readFileSync(new URL("./fixtures/helium-browser-chromium.html", import.meta.url), "utf8");

let profileDirectory: string | undefined;
let fixtureServer: Server | undefined;
let browserProcess: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let fixtureUrl = "";

function findChromiumExecutable(): string | undefined {
	const configured = [
		process.env.HELIUM_CHROMIUM_PATH,
		process.env.CHROMIUM_PATH,
		process.env.PUPPETEER_EXECUTABLE_PATH,
	].filter((value): value is string => Boolean(value));
	const candidates = [
		...configured,
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe") : "",
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : "",
	];
	return candidates.find((candidate) => candidate.length > 0 && existsSync(candidate));
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => resolve());
	});
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port.");
	const port = address.port;
	await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
	return port;
}

async function startFixtureServer(): Promise<string> {
	const server = createServer((_request, response) => {
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		response.end(fixture);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	fixtureServer = server;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not start the loopback fixture server.");
	return `http://127.0.0.1:${address.port}/helium-browser-fixture.html`;
}

async function waitForCdp(port: number): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (browserProcess?.exitCode !== null && browserProcess?.exitCode !== undefined) {
			throw new Error(`Chromium exited before CDP became available (code ${browserProcess.exitCode}).`);
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 500);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
			if (response.ok) return;
		} catch {
			// Chromium needs a short startup window before its DevTools endpoint binds.
		} finally {
			clearTimeout(timer);
		}
		await wait(100);
	}
	throw new Error("Chromium CDP did not become available within 15 seconds.");
}

async function stopBrowserProcess(processHandle: ChildProcess | undefined): Promise<void> {
	if (!processHandle || processHandle.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => processHandle.once("exit", () => resolve()));
	processHandle.kill("SIGTERM");
	await Promise.race([exited, wait(3_000)]);
	if (processHandle.exitCode === null) {
		processHandle.kill("SIGKILL");
		await Promise.race([exited, wait(1_000)]);
	}
}

async function closeFixtureServer(server: Server | undefined): Promise<void> {
	if (!server || !server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

integrationDescribe("Helium browser real Chromium integration", () => {
	beforeAll(async () => {
		if (!executablePath) throw new Error("No Chromium executable was discovered.");
		profileDirectory = await mkdtemp(join(tmpdir(), "helium-browser-chromium-"));
		fixtureUrl = await startFixtureServer();
		const remotePort = await freePort();
		browserProcess = spawn(
			executablePath,
			[
				"--headless=new",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-background-networking",
				"--disable-component-update",
				"--disable-sync",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--remote-allow-origins=*",
				"--remote-debugging-address=127.0.0.1",
				`--remote-debugging-port=${remotePort}`,
				`--user-data-dir=${profileDirectory}`,
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		browserProcess.on("error", () => {});
		await waitForCdp(remotePort);
		browser = await connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null });
		page = await browser.newPage();
		await page.setViewport({ width: 960, height: 640, deviceScaleFactor: 1 });
		await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
	});

	afterEach(async () => {
		await disposeAllRefs();
		if (page && !page.isClosed()) await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
	});

	afterAll(async () => {
		await disposeAllRefs().catch(() => {});
		if (page && !page.isClosed()) await page.close().catch(() => {});
		page = undefined;
		await browser?.close().catch(() => {});
		browser = undefined;
		await stopBrowserProcess(browserProcess);
		browserProcess = undefined;
		await closeFixtureServer(fixtureServer);
		fixtureServer = undefined;
		if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
		profileDirectory = undefined;
	});

	test("uses real CDP remote handles and rejects refs from an older rerender generation", async () => {
		if (!page) throw new Error("Chromium page was not initialized.");
		const initial = await makeSnapshot(page, "real-chromium-tab", 12_000, true);
		const initialRef = initial.match(/s\d+-e\d+/)?.[0];
		expect(initialRef).toBeTruthy();
		expect(initial).toContain("Initial interactive content");
		expect(getHeliumRefCacheStats().handleCount).toBeGreaterThan(0);

		await page.evaluate(() => {
			(window as unknown as { rerenderFixture: () => void }).rerenderFixture();
		});
		const rerendered = await makeSnapshot(page, "real-chromium-tab", 12_000, true);
		const rerenderedRef = rerendered.match(/s\d+-e\d+/)?.[0];
		expect(rerenderedRef).toBeTruthy();
		expect(rerenderedRef).not.toBe(initialRef);
		expect(rerendered).toContain("Rerendered interactive content");
		expect(getHeliumRefCacheStats().handleCount).toBeGreaterThan(0);
		await disposeAllRefs();
		expect(getHeliumRefCacheStats()).toEqual({ tabCount: 0, handleCount: 0 });
	});

	test("captures bounded viewport/full-page PNGs and rejects oversized dimensions", async () => {
		if (!page) throw new Error("Chromium page was not initialized.");
		const dimensions = await page.evaluate(() => {
			const root = document.documentElement;
			const body = document.body;
			const scale = Math.max(1, window.devicePixelRatio || 1);
			return {
				width: Math.ceil(Math.max(root.scrollWidth, root.clientWidth, body?.scrollWidth ?? 0) * scale),
				height: Math.ceil(Math.max(root.scrollHeight, root.clientHeight, body?.scrollHeight ?? 0) * scale),
			};
		});
		assertScreenshotDimensions(dimensions);

		const viewportPng = await page.screenshot({ type: "png", encoding: "base64", fullPage: false });
		const fullPagePng = await page.screenshot({ type: "png", encoding: "base64", fullPage: true });
		expect(viewportPng.length).toBeGreaterThan(0);
		expect(fullPagePng.length).toBeGreaterThan(viewportPng.length);
		expect(fullPagePng.length).toBeLessThan(8_000_000);

		await page.evaluate(() => {
			const content = document.querySelector<HTMLElement>(".long-page");
			if (content) content.style.height = "500000px";
		});
		const oversized = await page.evaluate(() => ({ width: 960, height: document.documentElement.scrollHeight }));
		let rejected = false;
		try {
			assertScreenshotDimensions(oversized);
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
	});

	test("discovers a synthetic login while retaining recovery and signup links", async () => {
		if (!page) throw new Error("Chromium page was not initialized.");
		const discovered = (await page.evaluate(loginFormEvaluator, "discover")) as
			{ passwordIndex: number; usernameIndex?: number; signature: string } | undefined;
		expect(discovered).toBeTruthy();
		if (!discovered) throw new Error("The synthetic login form was not discovered.");
		expect(discovered.passwordIndex).toBe(4);
		expect(discovered.usernameIndex).toBe(3);
		expect(discovered.signature.length).toBeGreaterThan(0);

		const formDetails = await page.evaluate(() => {
			const form = document.querySelector("form[action='/login']");
			return {
				authenticityField: form?.querySelector("input[name='authenticity_token']")?.type,
				emailField: form?.querySelector("input[name='session[email]']")?.getAttribute("autocomplete"),
				passwordField: form?.querySelector("input[name='session[password]']")?.getAttribute("autocomplete"),
				rememberCheckboxes: form?.querySelectorAll("input[type='checkbox'][name^='session[remember_me']").length,
				forgotLink: form?.querySelector("a[href='/reset_password']")?.textContent?.trim(),
				ssoLinks: Array.from(form?.querySelectorAll("a.js-omniauthChoice") ?? []).map((link) => link.getAttribute("href")),
				submit: form?.querySelector("input[type='submit']")?.getAttribute("value"),
			};
		});
		expect(formDetails).toEqual({
			authenticityField: "hidden",
			emailField: "email",
			passwordField: "current-password",
			rememberCheckboxes: 2,
			forgotLink: "Forgot your password?",
			ssoLinks: ["/saml", "/auth/google_oauth2"],
			submit: "Log In",
		});

		const snapshot = await makeSnapshot(page, "login-discovery-tab", 12_000, true);
		expect(snapshot).toContain("Forgot your password?");
		expect(snapshot).toContain("School Credentials");
		expect(snapshot).toContain("Google");
		expect(await page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted)).toBe(false);
	});

	test("rejects primary reset, signup, and OTP forms", async () => {
		if (!page) throw new Error("Chromium page was not initialized.");
		const negativeForms = [
			`<form action="/reset_password" method="post"><input type="hidden" name="authenticity_token" value="fixture"><input type="email" name="email"><input type="submit" value="Reset password"></form>`,
			`<form action="/users" method="post"><input type="hidden" name="authenticity_token" value="fixture"><input type="email" name="user[email]"><input type="password" name="user[password]" autocomplete="new-password"><input type="password" name="user[password_confirmation]" autocomplete="new-password"><input type="submit" value="Create Account"></form>`,
			`<form action="/verify" method="post"><input type="hidden" name="authenticity_token" value="fixture"><input type="text" name="otp" autocomplete="one-time-code"><input type="submit" value="Verify"></form>`,
		];
		for (const markup of negativeForms) {
			await page.setContent(`<!doctype html><html><body>${markup}</body></html>`, { waitUntil: "domcontentloaded" });
			expect(await page.evaluate(loginFormEvaluator, "discover")).toBeUndefined();
		}
	});

	test("cancels queued work before it can dispatch a browser mutation", async () => {
		if (!page) throw new Error("Chromium page was not initialized.");
		const controller = new AbortController();
		controller.abort();
		let dispatched = false;
		const pending = withTabMutation("real-chromium-cancel-tab", controller.signal, async () => {
			dispatched = true;
			await page!.evaluate(() => document.body.setAttribute("data-unexpected-mutation", "true"));
			return undefined;
		});
		let cancellation: unknown;
		try {
			await pending;
		} catch (error) {
			cancellation = error;
		}
		expect(cancellation).toBeInstanceOf(ActionCanceledError);
		expect(dispatched).toBe(false);
		expect(await page.evaluate(() => document.body.hasAttribute("data-unexpected-mutation"))).toBe(false);
	});
});
