/**
 * Evaluators passed to Puppeteer's page.evaluate/evaluateHandle.
 *
 * Keep this module closure-free: serialized functions must not capture module
 * bindings because Puppeteer reconstructs them in the renderer context.
 */

/** Serialized by Puppeteer to protect deletion keys from focused credentials. */
export function focusedSensitiveFieldEvaluator(): boolean {
	let current = document.activeElement as Element | null;
	let depth = 0;
	while (current && depth++ < 64) {
		const tag = (current.tagName ?? "").toLowerCase();
		const contentEditableAttribute = current.getAttribute?.("contenteditable");
		const contentEditable = contentEditableAttribute !== null && contentEditableAttribute.toLowerCase() !== "false";
		if (tag === "input" || tag === "textarea" || tag === "select" || contentEditable) {
			const metadata = [
				current.getAttribute?.("type") ?? "",
				current.getAttribute?.("name") ?? "",
				current.getAttribute?.("id") ?? "",
				current.getAttribute?.("autocomplete") ?? "",
				current.getAttribute?.("placeholder") ?? "",
				current.getAttribute?.("aria-label") ?? "",
				current.getAttribute?.("title") ?? "",
				current.getAttribute?.("class") ?? "",
			].join(" ");
			const autocomplete = (current.getAttribute?.("autocomplete") ?? "").toLowerCase().split(/\s+/);
			if (
				(current.getAttribute?.("type") ?? "").toLowerCase() === "password" ||
				autocomplete.some((token) =>
					["current-password", "new-password", "one-time-code", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc"].includes(token),
				) ||
				/(?:password|passcode|one[-_ ]?time|otp|mfa|multi[-_ ]?factor|verification|security[-_ ]?code|auth[-_ ]?code|(?:access|refresh|id|session|bearer|security)[-_ ]?token|token|api[-_ ]?key|secret|private[-_ ]?key|credential|payment|billing|card[-_ ]?(?:number|name)|credit[-_ ]?card|debit[-_ ]?card|cvv|cvc|expir(?:y|ation)|billing[-_ ]?(?:address|name|zip|postal)|routing[-_ ]?number|account[-_ ]?number|iban|swift)/i.test(
					metadata,
				)
			)
				return true;
		}
		current = current.parentElement;
	}
	return false;
}



export type ClickabilityResult =
	| { status: "ready" }
	| { status: "stale"; reason: string }
	| { status: "not-element"; reason: string }
	| { status: "not-actionable"; reason: string }
	| { status: "covered"; reason: string };

export function clickabilityEvaluator(element: Element, checkCoverage = true): ClickabilityResult {
	if (!(element instanceof HTMLElement)) return { status: "not-element", reason: "the target is not an HTMLElement" };
	if (!element.isConnected) return { status: "stale", reason: "the element is detached" };
	for (let current: HTMLElement | null = element; current; current = current.parentElement) {
		const style = getComputedStyle(current);
		if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
			return { status: "not-actionable", reason: "the element is hidden" };
		}
	}
	if (getComputedStyle(element).pointerEvents === "none") {
		return { status: "not-actionable", reason: "the element has pointer-events: none" };
	}
	if ("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) {
		return { status: "not-actionable", reason: "the element is disabled" };
	}
	if (element.getAttribute("aria-disabled") === "true") {
		return { status: "not-actionable", reason: "the element is aria-disabled" };
	}
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0)
		return { status: "not-actionable", reason: "the element has no visible size" };
	if (checkCoverage) {
		const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		if (!top || (top !== element && !element.contains(top))) {
			return { status: "covered", reason: "another element covers its click point" };
		}
	}
	return { status: "ready" };
}



export type InputActionMode = "check" | "fill" | "type";
export type InputActionResult =
	| { status: "ready" }
	| { status: "sensitive" }
	| { status: "stale"; reason: string }
	| { status: "unsupported"; reason: string }
	| { status: "not-actionable"; reason: string }
	| { status: "mutation-failed" };

/**
 * Serialized guard and mutation for generic input tools. Keep all policy in this
 * function: Puppeteer serializes the callback and cannot capture module helpers.
 * Values and field metadata never enter a failure result.
 */
export function inputActionEvaluator(
	element: Element,
	mode: InputActionMode = "check",
	nextValue = "",
): InputActionResult {
	const candidate = element as HTMLElement & {
		value?: string;
		readOnly?: boolean;
		disabled?: boolean;
		inert?: boolean;
		selectionStart?: number | null;
		selectionEnd?: number | null;
		setRangeText?: (value: string, start?: number, end?: number, selectionMode?: string) => void;
		focus?: () => void;
	};
	const fail = (status: InputActionResult["status"], reason?: string): InputActionResult =>
		status === "sensitive"
			? { status }
			: status === "mutation-failed"
				? { status }
				: { status, reason: reason ?? "the element is not eligible" };
	const metadata = [
		element.getAttribute?.("type") ?? "",
		element.getAttribute?.("name") ?? "",
		element.getAttribute?.("id") ?? "",
		element.getAttribute?.("autocomplete") ?? "",
		element.getAttribute?.("placeholder") ?? "",
		element.getAttribute?.("aria-label") ?? "",
		element.getAttribute?.("title") ?? "",
	].join(" ");
	const sensitive =
		(element.getAttribute?.("type") ?? "").toLowerCase() === "password" ||
		(element.getAttribute?.("autocomplete") ?? "")
			.toLowerCase()
			.split(/\s+/)
			.some((token) =>
				[
					"current-password",
					"new-password",
					"one-time-code",
					"cc-number",
					"cc-exp",
					"cc-exp-month",
					"cc-exp-year",
					"cc-csc",
				].includes(token),
			) ||
		/(?:password|passcode|one[-_ ]?time|otp|mfa|multi[-_ ]?factor|verification|security[-_ ]?code|auth[-_ ]?code|access[-_ ]?token|refresh[-_ ]?token|token|api[-_ ]?key|secret|private[-_ ]?key|credential|payment|billing|card[-_ ]?number|credit[-_ ]?card|debit[-_ ]?card|cvv|cvc|expir(?:y|ation)|billing[-_ ]?(?:address|name|zip|postal)|routing[-_ ]?number|account[-_ ]?number)/i.test(
				metadata,
			);
	if (sensitive) return fail("sensitive");
	if (!candidate.isConnected) return fail("stale", "the element is detached");

	const tag = (element.tagName ?? "").toLowerCase();
	const inputType = (element.getAttribute?.("type") ?? "text").toLowerCase();
	const supportedInputTypes = new Set(["text", "email", "search", "tel", "url", "number"]);
	const contentEditableAttribute = element.getAttribute?.("contenteditable");
	const contentEditable =
		candidate.isContentEditable === true ||
		(contentEditableAttribute !== null && contentEditableAttribute.toLowerCase() !== "false");
	if (!(tag === "textarea" || (tag === "input" && supportedInputTypes.has(inputType)) || contentEditable)) {
		return fail("unsupported", "the target is not a supported text field");
	}
	if (candidate.readOnly === true || element.hasAttribute?.("readonly"))
		return fail("not-actionable", "the element is read-only");
	if (candidate.disabled === true || element.hasAttribute?.("disabled"))
		return fail("not-actionable", "the element is disabled");
	for (let current: HTMLElement | null = candidate; current; current = current.parentElement) {
		const style = getComputedStyle(current);
		if (
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.opacity === "0" ||
			style.pointerEvents === "none" ||
			current.hidden ||
			current.getAttribute("aria-hidden") === "true" ||
			current.inert === true ||
			current.hasAttribute?.("inert") ||
			current.matches?.("fieldset[disabled]")
		)
			return fail("not-actionable", "the element is hidden, disabled, or inert");
	}
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return fail("not-actionable", "the element has no visible size");
	if (mode === "check") return { status: "ready" };

	try {
		candidate.focus?.();
		if (contentEditable) {
			const selection = globalThis.getSelection?.();
			const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
			if (mode === "fill") {
				const replacement = document.createTextNode(nextValue);
				if (range && candidate.contains(range.commonAncestorContainer)) {
					range.selectNodeContents(candidate);
					range.deleteContents();
					range.insertNode(replacement);
					range.setStartAfter(replacement);
					range.collapse(true);
				} else {
					candidate.replaceChildren(replacement);
				}
			} else if (range && candidate.contains(range.commonAncestorContainer)) {
				range.deleteContents();
				range.insertNode(document.createTextNode(nextValue));
				range.collapse(false);
			} else {
				candidate.appendChild(document.createTextNode(nextValue));
			}
			if (mode === "fill" && candidate.textContent !== nextValue) return fail("mutation-failed");
			if (mode === "type" && nextValue.length > 0 && !(candidate.textContent ?? "").includes(nextValue))
				return fail("mutation-failed");
		} else {
			const current = typeof candidate.value === "string" ? candidate.value : "";
			const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(candidate), "value")?.set;
			let expectedValue = nextValue;
			if (mode === "fill") {
				if (setter) setter.call(candidate, nextValue);
				else candidate.value = nextValue;
			} else {
				const start = typeof candidate.selectionStart === "number" ? candidate.selectionStart : current.length;
				const end = typeof candidate.selectionEnd === "number" ? candidate.selectionEnd : start;
				expectedValue = `${current.slice(0, start)}${nextValue}${current.slice(end)}`;
				if (typeof candidate.setRangeText === "function") {
					try {
						candidate.setRangeText(nextValue, start, end, "end");
					} catch {
						if (setter) setter.call(candidate, expectedValue);
						else candidate.value = expectedValue;
					}
				} else if (setter) setter.call(candidate, expectedValue);
				else candidate.value = expectedValue;
			}
			if (candidate.value !== expectedValue) return fail("mutation-failed");
		}
		candidate.dispatchEvent(new Event("input", { bubbles: true }));
		if (mode === "fill") candidate.dispatchEvent(new Event("change", { bubbles: true }));
		return { status: "ready" };
	} catch {
		return fail("mutation-failed");
	}
}



export type LoginFormDescriptor = {
	passwordIndex: number;
	usernameIndex?: number;
	signature: string;
};
export type LoginFormEvaluationResult = LoginFormDescriptor | boolean | undefined;

/** Fixed serialized evaluator used both for discovery and final atomic filling. */
export function loginFormEvaluator(
	mode: string = "discover",
	expectedOrigin?: string,
	usernameValue?: string,
	passwordValue?: string,
	expectedSignature?: string,
): LoginFormEvaluationResult {
	const visible = (element: HTMLElement): boolean => {
		if (!element.isConnected) return false;
		for (let current: HTMLElement | null = element; current; current = current.parentElement) {
			const style = getComputedStyle(current);
			if (
				style.display === "none" ||
				style.visibility === "hidden" ||
				style.opacity === "0" ||
				style.pointerEvents === "none" ||
				current.hidden ||
				current.getAttribute("aria-hidden") === "true"
			)
				return false;
		}
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	};
	const eligible = (element: HTMLInputElement): boolean => {
		const type = element.type.toLowerCase();
		if (!(["text", "email", "search", "tel", "url", "password"] as string[]).includes(type)) return false;
		if (!visible(element) || element.disabled || element.readOnly) return false;
		for (let current: HTMLElement | null = element; current; current = current.parentElement) {
			if (current.inert === true || current.hasAttribute?.("inert") || current.matches?.("fieldset[disabled]")) return false;
		}
		return true;
	};
	const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
	const forms = Array.from(document.querySelectorAll<HTMLFormElement>("form"));
	const forbidden =
		/sign[\s_-]*up|register|create[\s_-]*account|new[\s_-]*password|confirm[\s_-]*password|reset|forgot|recover|change[\s_-]*password|one[-\s_]?time|otp|multi[-\s_]?factor|mfa|verification[\s_-]*code|security[\s_-]*code|passcode|captcha|payment|billing|card[\s_-]*number|credit[\s_-]*card|cvv|cvc|expiry|expiration/i;
	const loginEvidence = /log[\s_-]*in|sign[\s_-]*in|authenticate|session|login/i;
	const metadata = (element: HTMLInputElement): string =>
		[
			element.type,
			element.name,
			element.id,
			element.autocomplete,
			element.placeholder,
			element.getAttribute("aria-label") ?? "",
		].join(" ");
	const autocompleteTokens = (element: HTMLInputElement): string[] => element.autocomplete.toLowerCase().split(/\s+/);
	const passwordFields = inputs.filter((element) => element.type.toLowerCase() === "password");
	if (passwordFields.length !== 1 || !eligible(passwordFields[0])) return mode === "fill" ? false : undefined;
	if (inputs.some((element) => autocompleteTokens(element).includes("new-password")))
		return mode === "fill" ? false : undefined;

	const password = passwordFields[0];
	const owner = password.form ?? password.closest("form");
	const ownerInputs = inputs.filter((element) => (owner ? element.form === owner : !element.form));
	const ownerText = owner?.innerText ?? "";
	const formMetadata = owner
		? ["action", "name", "id", "class", "aria-label"].map((name) => owner.getAttribute(name) ?? "").join(" ")
		: "";
	const controlText = owner
		? Array.from(owner.querySelectorAll("button,input[type='submit'],input[type='button'],input[type='reset']"))
				.map((element) => {
					const input = element as HTMLInputElement;
					return [element.textContent ?? "", input.value ?? "", metadata(input)].join(" ");
				})
				.join(" ")
		: "";
	const formText = `${ownerText} ${formMetadata} ${controlText}`;
	// Recovery/signup links are incidental navigation. Only form semantics and
	// actual primary controls determine whether this is a forbidden form.
	const semanticFormText = `${formMetadata} ${controlText}`;
	if (forbidden.test(semanticFormText) || ownerInputs.some((element) => forbidden.test(metadata(element))))
		return mode === "fill" ? false : undefined;

	const hasCurrentPassword = autocompleteTokens(password).includes("current-password");
	if (!hasCurrentPassword && (!owner || !loginEvidence.test(formText))) return mode === "fill" ? false : undefined;

	const usernameLike = (element: HTMLInputElement): boolean => {
		if (element === password) return false;
		// Login-adjacent controls may contain words such as "email login" in
		// their accessible label (for example Gradescope's remember checkboxes).
		// Only editable text controls can be username candidates.
		const usernameInputTypes = ["text", "email", "search", "tel", "url"];
		if (!usernameInputTypes.includes(element.type.toLowerCase())) return false;
		const autocomplete = autocompleteTokens(element);
		return (
			element.type.toLowerCase() === "email" ||
			autocomplete.includes("username") ||
			autocomplete.includes("email") ||
			/username|e[-_ ]?mail|account|identifier|user[\s_-]*id|\blogin\b/i.test(metadata(element))
		);
	};
	const usernameCandidates = ownerInputs.filter(usernameLike);
	if (usernameCandidates.length > 1 || usernameCandidates.some((element) => !eligible(element)))
		return mode === "fill" ? false : undefined;
	const username = usernameCandidates[0];

	const identity = (value: object, key: string): string => {
		const target = value as Record<string, unknown>;
		const existing = target[key];
		if (typeof existing === "string") return existing;
		const token = `pi-apw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		try {
			Object.defineProperty(target, key, { configurable: false, enumerable: false, value: token });
			return token;
		} catch {
			return "unavailable";
		}
	};
	const documentIdentity = identity(document, "__pi_apw_document_identity");
	const formIdentity = owner ? identity(owner, "__pi_apw_form_identity") : "no-form";
	const passwordIdentity = identity(password, "__pi_apw_password_identity");
	const usernameIdentity = username ? identity(username, "__pi_apw_username_identity") : undefined;
	const formIndex = owner ? forms.indexOf(owner) : -1;
	const passwordIndex = inputs.indexOf(password);
	const usernameIndex = username ? inputs.indexOf(username) : undefined;
	const signature = JSON.stringify({
		documentIdentity,
		formIdentity,
		passwordIdentity,
		usernameIdentity,
		formIndex,
		passwordIndex,
		usernameIndex,
		inputs: ownerInputs.map(metadata),
	});

	if (mode === "fill") {
		if (
			location.protocol !== "https:" ||
			location.origin !== expectedOrigin ||
			typeof passwordValue !== "string" ||
			passwordValue.length === 0 ||
			(username && typeof usernameValue !== "string") ||
			(expectedSignature !== undefined && signature !== expectedSignature)
		)
			return false;
		const setValue = (element: HTMLInputElement, value: string): void => {
			const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
			if (setter) setter.call(element, value);
			else element.value = value;
		};
		try {
			if (username) setValue(username, usernameValue!);
			setValue(password, passwordValue);
			if (username) {
				username.dispatchEvent(new Event("input", { bubbles: true }));
				username.dispatchEvent(new Event("change", { bubbles: true }));
			}
			password.dispatchEvent(new Event("input", { bubbles: true }));
			password.dispatchEvent(new Event("change", { bubbles: true }));
		} catch {
			return false;
		}
		return true;
	}

	return { passwordIndex, usernameIndex, signature };
}



export type SnapshotDescriptor = {
	ref: string;
	label: string;
	kind: string;
};
/**
 * This function is serialized by Puppeteer. When captureElements is enabled,
 * each descriptor carries the exact node captured in this operation. Refs are
 * never resolved through page-controlled markup.
 */
export function snapshotEvaluator(
	includeRefs: boolean,
	maxBodyChars = 30_000,
	maxRefs = 256,
	maxCandidates = 1_024,
	snapshotPrefix = "",
	captureElements = false,
	bodyStartOffset = 0,
	candidateStartOffset = 0,
	scopeSelector = "",
	refStartOffset = 0,
	bodyNodeStartOffset = 0,
	bodyStreamStartOffset?: number,
	bodyStartPath?: number[],
	bodyBlockStartPath?: number[],
	candidateStartPath?: number[],
): {
	bodyText: string;
	bodyTruncated: boolean;
	bodyNextOffset: number;
	bodyDone: boolean;
	bodyNodeNextOffset: number;
	bodyStreamNextOffset: number;
	bodyNextPath?: number[];
	bodyBlockPath?: number[];
	candidateNextOffset: number;
	candidateDone: boolean;
	candidateNextPath?: number[];
	refNextOrdinal: number;
	refs: Array<SnapshotDescriptor & { element?: Element }>;
	omittedCandidateCount: number;
} {
	const isSensitiveField = (element: Element): boolean => {
		const tag = (element.tagName ?? "").toLowerCase();
		// HTML treats an empty contenteditable value as editable; only the
		// explicit false value opts out. This also keeps editable token/OTP text
		// out of body text and ref labels.
		const contentEditableAttribute = element.getAttribute?.("contenteditable");
		const contentEditable = contentEditableAttribute !== null && contentEditableAttribute.toLowerCase() !== "false";
		if (!(tag === "input" || tag === "textarea" || tag === "select" || contentEditable)) return false;
		const type = element.getAttribute?.("type")?.toLowerCase() ?? "";
		const autocompleteValue = element.getAttribute?.("autocomplete") ?? "";
		const autocomplete = autocompleteValue.toLowerCase().split(/\s+/);
		const metadata = [
			type,
			element.getAttribute?.("name") ?? "",
			element.getAttribute?.("id") ?? "",
			autocompleteValue,
			element.getAttribute?.("placeholder") ?? "",
			element.getAttribute?.("aria-label") ?? "",
			element.getAttribute?.("title") ?? "",
			element.getAttribute?.("class") ?? "",
		].join(" ");
		return (
			type === "password" ||
			autocomplete.some((token) =>
				["current-password", "new-password", "one-time-code", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc"].includes(token),
			) ||
			/(?:password|passcode|one[-_ ]?time|otp|mfa|multi[-_ ]?factor|verification|security[-_ ]?code|auth[-_ ]?code|(?:access|refresh|id|session|bearer|security)[-_ ]?token|token|api[-_ ]?key|secret|private[-_ ]?key|credential|payment|billing|card[-_ ]?(?:number|name)|credit[-_ ]?card|debit[-_ ]?card|cvv|cvc|expir(?:y|ation)|billing[-_ ]?(?:address|name|zip|postal)|routing[-_ ]?number|account[-_ ]?number|iban|swift)/i.test(
				metadata,
			)
		);
	};
	const isHiddenOrInert = (element: Element): boolean => {
		let current: Element | null = element;
		let depth = 0;
		while (current && depth++ < 64) {
			const style = getComputedStyle(current);
			if (
				style.display === "none" ||
				style.visibility === "hidden" ||
				style.visibility === "collapse" ||
				style.opacity === "0" ||
				style.contentVisibility === "hidden" ||
				(current as HTMLElement).hidden === true ||
				current.getAttribute?.("aria-hidden") === "true" ||
				(current as HTMLElement).inert === true ||
				current.hasAttribute?.("inert") ||
				current.matches?.("fieldset[disabled]")
			)
				return true;
			current = current.parentElement;
		}
		return false;
	};
	const body = document.body;
	const scopeRoot = scopeSelector ? (document.querySelector(scopeSelector) as Element | null) : body;
	if (scopeSelector && !scopeRoot) throw new Error("Snapshot scope selector did not match an element.");
	// A numeric offset is useful for compatibility, but replaying a TreeWalker
	// from its root on every continuation makes work grow with the page prefix.
	// Child paths are compact renderer-local checkpoints: resolving one costs at
	// most the DOM depth, after which traversal is bounded by this call's batch.
	const nodePath = (node: Node | null, root: Node): number[] | undefined => {
		if (!node) return undefined;
		const path: number[] = [];
		let current: any = node;
		while (current && current !== root) {
			const parent = current.parentNode ?? current.parentElement;
			const children = parent?.childNodes;
			if (!parent || !children || children.length > 100_000) return undefined;
			let index = -1;
			for (let childIndex = 0; childIndex < children.length; childIndex++) {
				if (children[childIndex] === current) {
					index = childIndex;
					break;
				}
			}
			if (index < 0 || path.length >= 256) return undefined;
			path.unshift(index);
			current = parent;
		}
		return current === root ? path : undefined;
	};
	const nodeAtPath = (root: Node, path: number[] | undefined): Node | null => {
		if (!path) return null;
		let current: any = root;
		for (const index of path) {
			const children = current?.childNodes;
			if (!children || !Number.isInteger(index) || index < 0 || index >= children.length) return null;
			current = children[index];
		}
		return current ?? null;
	};
	let bodyText = "";
	let bodyTruncated = false;
	let bodyNextOffset = Math.max(0, bodyStartOffset);
	let bodyDone = true;
	let bodyNodeNextOffset = Math.max(0, bodyNodeStartOffset);
	let bodyStreamNextOffset = Math.max(0, bodyStreamStartOffset ?? bodyStartOffset);
	let bodyNextPath: number[] | undefined;
	let bodyBlockPath: number[] | undefined;
	if (scopeRoot) {
		const createTreeWalker = document.createTreeWalker?.bind(document);
		if (createTreeWalker) {
			const walker = createTreeWalker(scopeRoot, 4 /* NodeFilter.SHOW_TEXT */);
			const blockTags = new Set([
				"address",
				"article",
				"aside",
				"blockquote",
				"dd",
				"div",
				"dl",
				"dt",
				"fieldset",
				"figcaption",
				"figure",
				"footer",
				"form",
				"h1",
				"h2",
				"h3",
				"h4",
				"h5",
				"h6",
				"header",
				"hr",
				"li",
				"main",
				"nav",
				"ol",
				"p",
				"pre",
				"section",
				"table",
				"td",
				"th",
				"tr",
				"ul",
			]);
			const blockAncestor = (element: Element | null): Element => {
				let current = element;
				let depth = 0;
				while (current && depth++ < 64) {
					if (blockTags.has((current.tagName ?? "").toLowerCase())) return current;
					current = current.parentElement;
				}
				return body;
			};
			const inspectNode = (node: Node): { excluded: boolean; block: Element | null } => {
				let ancestor = node.parentElement;
				let excluded = false;
				let reachedBody = false;
				let ancestorCount = 0;
				while (ancestor && ancestorCount++ < 64) {
					const tag = (ancestor.tagName ?? "").toLowerCase();
					if (
						isSensitiveField(ancestor) ||
						isHiddenOrInert(ancestor) ||
						tag === "script" ||
						tag === "style" ||
						tag === "noscript" ||
						tag === "template"
					) {
						excluded = true;
						break;
					}
					if (ancestor === scopeRoot) {
						reachedBody = true;
						break;
					}
					ancestor = ancestor.parentElement;
				}
				if (!reachedBody) excluded = true;
				return { excluded, block: excluded ? null : blockAncestor(node.parentElement) };
			};
			let previousBlock: Element | null = null;
			let work = 0;
			let nodeIndex = Math.max(0, bodyNodeStartOffset);
			let streamOffset = bodyStreamStartOffset === undefined ? 0 : Math.max(0, bodyStreamStartOffset);
			let node: Node | null = null;
			let resumedFromPath = false;
			if (bodyStartPath) {
				const checkpoint = nodeAtPath(scopeRoot, bodyStartPath);
				if (checkpoint) {
					node = checkpoint;
					resumedFromPath = true;
					const checkpointBlock = nodeAtPath(scopeRoot, bodyBlockStartPath);
					previousBlock = checkpointBlock && checkpointBlock.nodeType === 1 ? checkpointBlock as Element : null;
				}
			}
			if (!resumedFromPath) {
				node = walker.nextNode();
				// Old callers and lightweight test DOMs do not provide a child path.
				// Retain their numeric checkpoint behavior while production calls use
				// the bounded path above.
				const hasSeekCheckpoint = bodyStreamStartOffset !== undefined && bodyNodeStartOffset > 0;
				if (hasSeekCheckpoint) {
					nodeIndex = 0;
					while (node && nodeIndex < Math.max(0, bodyNodeStartOffset)) {
						const inspectedNode = inspectNode(node);
						if (!inspectedNode.excluded) previousBlock = inspectedNode.block;
						nodeIndex++;
						node = walker.nextNode();
					}
				}
			}
			const reachedStartInitially = streamOffset >= bodyStartOffset;
			let reachedStart = reachedStartInitially;
			while (node && bodyText.length < maxBodyChars && work < 10_000) {
				const inspectedNode = inspectNode(node);
				if (reachedStart || !inspectedNode.excluded && streamOffset >= bodyStartOffset) work++;
				if (!inspectedNode.excluded) {
					const text = node.textContent ?? "";
					const block = inspectedNode.block ?? body;
					const separator = streamOffset > 0 && block !== previousBlock ? "\n" : "";
					const contribution = `${separator}${text}`;
					const contributionStart = streamOffset;
					streamOffset += contribution.length;
					if (streamOffset > bodyStartOffset) {
						const from = Math.max(0, bodyStartOffset - contributionStart);
						const remaining = maxBodyChars - bodyText.length;
						bodyText += contribution.slice(from, from + remaining);
						if (from + remaining < contribution.length) bodyTruncated = true;
						reachedStart = true;
					}
					previousBlock = block;
				}
				nodeIndex++;
				node = walker.nextNode();
			}
			bodyNodeNextOffset = nodeIndex;
			bodyStreamNextOffset = streamOffset;
			if (node) {
				bodyNextPath = nodePath(node, scopeRoot);
				bodyBlockPath = nodePath(previousBlock, scopeRoot);
				bodyTruncated = true;
				bodyDone = false;
				// bodyNextOffset remains monotonic even when a batch only filtered
				// nodes. The stream checkpoint is used for the actual text coordinate.
				bodyNextOffset = Math.max(bodyStartOffset + 1, streamOffset);
			} else {
				bodyDone = true;
				bodyNextOffset = Math.max(bodyStartOffset, streamOffset);
			}
		} else {
			const clone = body.cloneNode(true) as HTMLElement;
			for (const element of clone.querySelectorAll<HTMLElement>(
				"input,textarea,select,[contenteditable],[hidden],script,style,noscript,template",
			)) {
				if (isSensitiveField(element) || isHiddenOrInert(element) || ["script", "style", "noscript", "template"].includes(element.tagName.toLowerCase())) {
					element.removeAttribute("value");
					if ("value" in element) {
						try {
							(element as HTMLElement & { value?: string }).value = "";
						} catch {}
					}
					element.textContent = "";
				}
			}
			const readable = clone.innerText ?? "";
			bodyText = readable.slice(Math.max(0, bodyStartOffset), Math.max(0, bodyStartOffset) + maxBodyChars);
			bodyTruncated = readable.length > Math.max(0, bodyStartOffset) + maxBodyChars;
			bodyNextOffset = Math.min(readable.length, Math.max(0, bodyStartOffset) + bodyText.length);
			bodyDone = bodyNextOffset >= readable.length;
		}
	}
	const refs: Array<SnapshotDescriptor & { element?: Element }> = [];
	if (!includeRefs)
		return {
			bodyText,
			bodyTruncated,
			bodyNextOffset,
			bodyDone,
			bodyNodeNextOffset,
			bodyStreamNextOffset,
			bodyNextPath,
			bodyBlockPath,
			candidateNextOffset: candidateStartOffset,
			candidateDone: true,
			refNextOrdinal: refStartOffset,
			refs,
			omittedCandidateCount: 0,
		};
	const isCandidate = (element: Element): boolean => {
		const tag = (element.tagName ?? "").toLowerCase();
		return ["a", "button", "input", "textarea", "select"].includes(tag) ||
			element.hasAttribute?.("contenteditable") === true ||
			element.hasAttribute?.("role") === true ||
			element.hasAttribute?.("tabindex") === true;
	};
	const addCandidate = (element: HTMLElement, ordinal: number): void => {
		const sensitiveInput = isSensitiveField(element);
		const metadata =
			element.getAttribute("aria-label") ||
			element.getAttribute("name") ||
			element.getAttribute("placeholder") ||
			"";
		const rawValue = "value" in element && typeof (element as HTMLElement & { value?: unknown }).value === "string"
			? ((element as HTMLElement & { value: string }).value ?? "")
			: element.innerText || element.textContent || "";
		const value = sensitiveInput ? "" : metadata || rawValue;
		const ref = snapshotPrefix ? `${snapshotPrefix}-e${ordinal + 1}` : `e${ordinal + 1}`;
		refs.push({
			ref,
			label: value.replace(/\s+/g, " ").trim().slice(0, 160),
			kind: element.tagName.toLowerCase(),
			...(captureElements ? { element } : {}),
		});
	};
	let inspectedCandidates = 0;
	let candidateTraversalOffset = 0;
	let candidateOrdinal = Math.max(0, refStartOffset);
	let candidateDone = true;
	let candidateNextPath: number[] | undefined;
	const walker = document.createTreeWalker?.bind(document);
	if (walker) {
		const candidateWalker = walker(scopeRoot ?? body, 1 /* NodeFilter.SHOW_ELEMENT */);
		let node: Node | null = null;
		let pendingRoot: Element | null = null;
		let resumedFromPath = false;
		if (candidateStartPath) {
			const checkpoint = nodeAtPath(scopeRoot ?? body, candidateStartPath);
			if (checkpoint) {
				resumedFromPath = true;
				candidateTraversalOffset = Math.max(0, candidateStartOffset);
				if (checkpoint === scopeRoot && checkpoint.nodeType === 1 && isCandidate(checkpoint as Element)) {
					pendingRoot = checkpoint as Element;
					node = candidateWalker.nextNode?.() ?? null;
				} else {
					node = checkpoint;
				}
			}
		}
		if (!resumedFromPath) {
			node = candidateWalker.nextNode?.() ?? null;
			// TreeWalker does not include its root; include it when a scope selector
			// points directly at a control.
			pendingRoot = scopeRoot && scopeRoot.nodeType === 1 && isCandidate(scopeRoot) ? scopeRoot : null;
		}
		while (
			(pendingRoot || node) &&
			(candidateTraversalOffset < Math.max(0, candidateStartOffset) || inspectedCandidates < maxCandidates) &&
			refs.length < maxRefs
		) {
			const element = (pendingRoot ?? node) as HTMLElement;
			pendingRoot = null;
			if (element && element.nodeType === 1) {
				const traversalIndex = candidateTraversalOffset++;
				if (traversalIndex >= candidateStartOffset) inspectedCandidates++;
				if (
					traversalIndex >= candidateStartOffset &&
					isCandidate(element) &&
					!isHiddenOrInert(element) &&
					element.getAttribute("contenteditable") !== "false"
				) {
					addCandidate(element, candidateOrdinal);
					candidateOrdinal++;
				}
			}
			node = candidateWalker.nextNode?.() ?? null;
		}
		candidateDone = !node && !pendingRoot;
		if (refs.length >= maxRefs && node) candidateDone = false;
		if (!candidateDone) {
			candidateNextPath = pendingRoot
				? nodePath(pendingRoot, scopeRoot ?? body)
				: nodePath(node, scopeRoot ?? body);
		}
	}
	return {
		bodyText,
		bodyTruncated,
		bodyNextOffset,
		bodyDone,
		bodyNodeNextOffset,
		bodyStreamNextOffset,
		bodyNextPath,
		bodyBlockPath,
		candidateNextOffset: Math.max(candidateStartOffset, candidateTraversalOffset),
		candidateDone,
		candidateNextPath,
		refNextOrdinal: candidateOrdinal,
		refs,
		omittedCandidateCount: candidateDone ? 0 : 1,
	};
}

