import type { Page } from "puppeteer-core";
import {
	clickabilityEvaluator,
	inputActionEvaluator,
	loginFormEvaluator,
	type ClickabilityResult,
	type InputActionResult,
	type LoginFormDescriptor,
} from "./renderer-evaluators.ts";

export const ELEMENT_ACTION_TIMEOUT_MS = 2_000;

type RefHandle = import("puppeteer-core").ElementHandle<Element>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class ClickTargetError extends Error {}
export class ActionCanceledError extends Error {
	readonly code = "HELIUM_ACTION_CANCELED";
}
export class ActionUnknownOutcomeError extends Error {
	readonly code = "HELIUM_ACTION_UNKNOWN_OUTCOME";
}
class ElementActionTimeoutError extends ActionUnknownOutcomeError {}

type ActionOperationOptions = { timeoutMs?: number };
type ActionOperation<T> = () => Promise<T>;

export type HeliumActionContext = {
	signal?: AbortSignal;
	assertNotAborted(label: string): void;
	run<T>(operation: ActionOperation<T>, label: string, options?: ActionOperationOptions): Promise<T>;
	defer(operation: () => Promise<void> | void): void;
	drain(): Promise<void>;
};

function actionCanceled(label: string, dispatched: boolean): Error {
	return dispatched
		? new ActionUnknownOutcomeError(
			`${label} canceled after dispatch; browser outcome is unknown. Do not retry this action.`,
		)
		: new ActionCanceledError(`${label} canceled before dispatch.`);
}

export function throwIfActionNotAborted(signal: AbortSignal | undefined, label: string): void {
	if (signal?.aborted) throw new ActionCanceledError(`${label} canceled before dispatch.`);
}

function createActionContext(signal?: AbortSignal): HeliumActionContext {
	const pending = new Set<Promise<unknown>>();
	const deferred: Array<() => Promise<void> | void> = [];
	const context: HeliumActionContext = {
		signal,
		assertNotAborted(label) {
			throwIfActionNotAborted(signal, label);
		},
		run<T>(operation: ActionOperation<T>, label: string, options: ActionOperationOptions = {}) {
			context.assertNotAborted(label);
			const timeoutMs = options.timeoutMs ?? ELEMENT_ACTION_TIMEOUT_MS;
			let dispatched = false;
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let abortListener: (() => void) | undefined;
			const underlying = Promise.resolve().then(() => {
				throwIfActionNotAborted(signal, label);
				dispatched = true;
				return operation();
			});
			const completion = underlying.then(
				() => undefined,
				() => undefined,
			);
			pending.add(completion);
			const result = new Promise<T>((resolve, reject) => {
				const finish = (error?: unknown, value?: T) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					if (signal && abortListener) signal.removeEventListener("abort", abortListener);
					if (error !== undefined) reject(error);
					else resolve(value as T);
				};
				underlying.then(
					(value) => finish(undefined, value),
					(error) => finish(error),
				);
				if (signal) {
					abortListener = () => finish(actionCanceled(label, dispatched));
					if (signal.aborted) abortListener();
					else signal.addEventListener("abort", abortListener, { once: true });
				}
				timer = setTimeout(
					() =>
						finish(
							new ElementActionTimeoutError(
								`${label} timed out after ${timeoutMs}ms; browser outcome is unknown because dispatched work may still be running. Do not retry this action.`,
							),
						),
					timeoutMs,
				);
			});
			return result;
		},
		defer(operation) {
			deferred.push(operation);
		},
		async drain() {
			while (pending.size > 0) {
				await Promise.allSettled([...pending]);
				for (const operation of [...pending]) pending.delete(operation);
			}
			while (deferred.length > 0) {
				const operations = deferred.splice(0);
				await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
			}
		},
	};
	return context;
}

const tabMutationQueues = new Map<string, Promise<void>>();

/** Serialize consequential work per tab, while allowing cancellation to return
 * immediately for work that is still queued behind another action. */
export function withTabMutation<T>(
	tabId: string,
	signal: AbortSignal | undefined,
	operation: (actions: HeliumActionContext) => Promise<T>,
): Promise<T> {
	const previous = tabMutationQueues.get(tabId) ?? Promise.resolve();
	let started = false;
	let settled = false;
	let resolveResult!: (value: T | PromiseLike<T>) => void;
	let rejectResult!: (error: unknown) => void;
	const result = new Promise<T>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	const rejectQueued = () => {
		if (started || settled) return;
		settled = true;
		rejectResult(new ActionCanceledError(`Helium action on tab ${tabId} canceled before dispatch while queued.`));
	};
	if (signal?.aborted) {
		rejectQueued();
		return result;
	}
	const abortListener = () => rejectQueued();
	signal?.addEventListener("abort", abortListener, { once: true });
	const lane = previous
		.catch(() => {})
		.then(async () => {
			if (settled || signal?.aborted) {
				rejectQueued();
				return;
			}
			started = true;
			signal?.removeEventListener("abort", abortListener);
			const actions = createActionContext(signal);
			try {
				const value = await operation(actions);
				if (!settled) {
					settled = true;
					resolveResult(value);
				}
			} catch (error) {
				if (!settled) {
					settled = true;
					rejectResult(error);
				}
			} finally {
				await actions.drain();
			}
		})
		.catch((error) => {
			if (!settled) {
				settled = true;
				rejectResult(error);
			}
		});
	const tracked = lane.finally(() => {
		if (tabMutationQueues.get(tabId) === tracked) tabMutationQueues.delete(tabId);
	});
	tabMutationQueues.set(tabId, tracked);
	return result;
}

export async function withElementActionTimeout<T>(
	operation: ActionOperation<T> | Promise<T>,
	label: string,
	actions?: HeliumActionContext,
): Promise<T> {
	if (actions) return actions.run(typeof operation === "function" ? operation : () => operation, label);
	const context = createActionContext();
	return context.run(typeof operation === "function" ? operation : () => operation, label);
}

function clickabilityError(label: string, result: Exclude<ClickabilityResult, { status: "ready" }>): ClickTargetError {
	const prefix =
		result.status === "stale"
			? `Stale ${label}`
			: result.status === "not-element"
				? `Cannot click ${label}; target is not an HTMLElement`
				: result.status === "covered"
					? `Cannot click ${label}; target is covered`
					: `Cannot click ${label}; target is not visible/actionable`;
	return new ClickTargetError(`${prefix} (${result.reason}). Take a fresh helium_snapshot first.`);
}

async function assertClickableHandle(
	handle: RefHandle,
	label: string,
	checkCoverage: boolean,
	actions?: HeliumActionContext,
): Promise<void> {
	let result: ClickabilityResult;
	try {
		result = await withElementActionTimeout(
			() => handle.evaluate(clickabilityEvaluator, checkCoverage),
			`Checking ${label}`,
			actions,
		);
	} catch (error) {
		if (error instanceof ElementActionTimeoutError) throw error;
		throw new ClickTargetError(`Stale ${label}; its element is detached. Take a fresh helium_snapshot first.`);
	}
	if (result.status !== "ready") throw clickabilityError(label, result);
}

async function clickHandleAtPoint(handle: RefHandle, label: string, actions?: HeliumActionContext): Promise<void> {
	const candidate = handle as unknown as {
		boundingBox?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
		frame?: { page?: () => Page } | (() => { page?: () => Page });
	};
	const frame =
		typeof candidate.frame === "function"
			? candidate.frame()
			: candidate.frame && typeof candidate.frame === "object"
				? candidate.frame
				: undefined;
	if (typeof candidate.boundingBox !== "function" || !frame || typeof frame.page !== "function") {
		// Keep lightweight test doubles and older Puppeteer-compatible handles
		// working; real Puppeteer handles take the coordinate path below.
		await withElementActionTimeout(() => handle.click(), `Clicking ${label}`, actions);
		return;
	}
	const page = frame.page();
	const hidden = await withElementActionTimeout(
		() => handle.evaluate(() => document.hidden),
		`Checking ${label} visibility`,
		actions,
	);
	if (hidden) {
		// Helium may keep a Pi window backgrounded while the agent is running.
		// Native Puppeteer mouse input then waits forever for an intersection
		// observer, but the page's normal click default action remains reliable.
		await withElementActionTimeout(
			() => page.evaluate((element) => (element as HTMLElement).click(), handle),
			`Clicking ${label}`,
			actions,
		);
		return;
	}
	const box = await withElementActionTimeout(() => candidate.boundingBox!(), `Measuring ${label}`, actions);
	if (!box || box.width <= 0 || box.height <= 0) {
		throw new ClickTargetError(
			`Cannot click ${label}; target has no visible box. Take a fresh helium_snapshot first.`,
		);
	}
	await withElementActionTimeout(
		() => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
		`Clicking ${label}`,
		actions,
	);
}

export async function clickElementHandle(
	handle: RefHandle,
	label: string,
	actions?: HeliumActionContext,
): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			// First reject detached/non-actionable handles, then scroll this exact
			// node before checking coverage at its final click point. Puppeteer's
			// ElementHandle.click waits for an intersection observer that can never
			// resolve for a background Helium tab, so use its final coordinates.
			await assertClickableHandle(handle, label, false, actions);
			await withElementActionTimeout(
				() =>
					handle.evaluate((element) => {
						element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
					}),
				`Scrolling ${label}`,
				actions,
			);
			await assertClickableHandle(handle, label, true, actions);
			await clickHandleAtPoint(handle, label, actions);
			return;
		} catch (error) {
			if (error instanceof ClickTargetError || error instanceof ElementActionTimeoutError || attempt === 1) {
				if (error instanceof ClickTargetError || error instanceof ElementActionTimeoutError) throw error;
				throw new Error(`Could not click ${label}: ${errorText(error)}. Take a fresh helium_snapshot first.`);
			}
			// A coordinate click can race a DOM rerender. Retry only this exact
			// handle; never resolve a selector or ref again here.
		}
	}
}

function inputActionError(action: "fill" | "type", result: InputActionResult): Error {
	if (result.status === "sensitive")
		return new Error(`Cannot ${action} credential-like fields with generic browser input tools.`);
	if (result.status === "stale") return new Error(`Cannot ${action} a detached element; take a fresh helium_snapshot first.`);
	if (result.status === "unsupported") return new Error(`Cannot ${action} this element; ${result.reason}.`);
	if (result.status === "not-actionable") return new Error(`Cannot ${action} this element; ${result.reason}.`);
	return new Error(`Could not ${action} this element safely; take a fresh helium_snapshot first.`);
}

export async function checkInputHandle(
	handle: RefHandle,
	action: "fill" | "type",
	actions?: HeliumActionContext,
): Promise<void> {
	let result: InputActionResult;
	try {
		result = await withElementActionTimeout(
			() =>
				handle.evaluate(
					inputActionEvaluator as unknown as (element: Element, mode: string, nextValue?: string) => InputActionResult,
					"check",
				),
			`Checking ${action} target`,
			actions,
		);
	} catch (error) {
		if (error instanceof ElementActionTimeoutError) throw error;
		throw new Error(`Could not check the ${action} target safely; take a fresh helium_snapshot first.`);
	}
	if (result.status !== "ready") throw inputActionError(action, result);
}

export async function fillHandle(handle: RefHandle, value: string, actions?: HeliumActionContext): Promise<void> {
	let result: InputActionResult;
	try {
		result = await withElementActionTimeout(
			() =>
				handle.evaluate(
					inputActionEvaluator as unknown as (element: Element, mode: string, nextValue?: string) => InputActionResult,
					"fill",
					value,
				),
			"Filling element",
			actions,
		);
	} catch (error) {
		if (error instanceof ElementActionTimeoutError) throw error;
		throw new Error("Could not fill this element safely; take a fresh helium_snapshot first.");
	}
	if (result.status !== "ready") throw inputActionError("fill", result);
}

export async function typeInBackgroundHandle(handle: RefHandle, value: string, actions?: HeliumActionContext): Promise<void> {
	let result: InputActionResult;
	try {
		result = await withElementActionTimeout(
			() =>
				handle.evaluate(
					inputActionEvaluator as unknown as (element: Element, mode: string, nextValue?: string) => InputActionResult,
					"type",
					value,
				),
			"Typing into background element",
			actions,
		);
	} catch (error) {
		if (error instanceof ElementActionTimeoutError) throw error;
		throw new Error("Could not type into this element safely; take a fresh helium_snapshot first.");
	}
	if (result.status !== "ready") throw inputActionError("type", result);
}

export async function pageIsHidden(page: Page, actions?: HeliumActionContext): Promise<boolean> {
	return withElementActionTimeout(
		() => page.evaluate(() => document.hidden),
		"Checking page visibility",
		actions,
	);
}

export function currentHttpsOrigin(page: Page): string {
	let parsed: URL;
	try {
		parsed = new URL(page.url());
	} catch {
		throw new Error("APW autofill requires an HTTPS login page.");
	}
	if (parsed.protocol !== "https:") throw new Error("APW autofill requires an HTTPS login page.");
	return parsed.origin;
}

export async function discoverCurrentLoginForm(page: Page): Promise<LoginFormDescriptor> {
	try {
		const form: unknown = await page.evaluate(loginFormEvaluator, "discover");
		if (!form || typeof form !== "object") throw new Error("not eligible");
		return form as LoginFormDescriptor;
	} catch {
		throw new Error("No safe visible top-frame login form was found.");
	}
}

export async function fillApwOnPage(
	page: Page,
	origin: string,
	discovered: LoginFormDescriptor,
	username: string,
	password: string,
	signal?: AbortSignal,
): Promise<void> {
	throwIfActionNotAborted(signal, "APW fill");
	try {
		const filled: unknown = await page.evaluate(
			loginFormEvaluator,
			"fill",
			origin,
			username,
			password,
			discovered.signature,
		);
		if (filled !== true) throw new Error("form changed");
		throwIfActionNotAborted(signal, "APW fill");
	} catch {
		// Never let page-defined setters, event handlers, or renderer errors enter
		// the model-facing APW error. Credential cleanup remains best effort.
		throw new Error("APW autofill was canceled because the login page or form changed.");
	}
}

