import { describe, expect, test } from "bun:test";
import {
	fillApwOnPage,
	focusedSensitiveFieldEvaluator,
	inputActionEvaluator,
	loginFormEvaluator,
	validateHeliumKey,
} from "../extensions/helium-browser/index.ts";

type FakeElement = {
	tagName: string;
	isConnected: boolean;
	value: string;
	type: string;
	name: string;
	autocomplete: string;
	parentElement: FakeElement | null;
	textContent: string;
	isContentEditable?: boolean;
	readOnly?: boolean;
	disabled?: boolean;
	inert?: boolean;
	selectionStart?: number | null;
	selectionEnd?: number | null;
	focus(): void;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	matches(selector: string): boolean;
	getBoundingClientRect(): { width: number; height: number };
	dispatchEvent(event: Event): boolean;
};

function field(attributes: Record<string, string> = {}): FakeElement {
	let events = 0;
	const element: FakeElement = {
		tagName: attributes.tagName ?? "INPUT",
		isConnected: true,
		value: attributes.value ?? "before",
		type: attributes.type ?? "text",
		name: attributes.name ?? "display_name",
		autocomplete: attributes.autocomplete ?? "",
		parentElement: null,
		textContent: "",
		readOnly: attributes.readOnly === "true",
		disabled: attributes.disabled === "true",
		inert: attributes.inert === "true",
		selectionStart: 0,
		selectionEnd: 0,
		focus: () => {},
		getAttribute(name) {
			if (name === "type") return element.type;
			if (name === "name") return element.name;
			if (name === "autocomplete") return element.autocomplete;
			return attributes[name] ?? null;
		},
		hasAttribute(name) {
			return name in attributes && attributes[name] !== "false";
		},
		matches: () => false,
		getBoundingClientRect: () => ({ width: attributes.hidden === "true" ? 0 : 100, height: 20 }),
		dispatchEvent: () => {
			events++;
			return true;
		},
	};
	Object.defineProperty(element, "eventCount", { get: () => events });
	return element;
}

function withDomGlobals<T>(operation: () => T): T {
	const globals = globalThis as unknown as Record<string, unknown>;
	const previous = globals.getComputedStyle;
	globals.getComputedStyle = () => ({
		display: "block",
		visibility: "visible",
		opacity: "1",
		pointerEvents: "auto",
	});
	try {
		return operation();
	} finally {
		if (previous === undefined) delete globals.getComputedStyle;
		else globals.getComputedStyle = previous;
	}
}

describe("Helium generic input security", () => {
	test("allows only named control keys and rejects printable or paste shortcuts", () => {
		for (const key of ["Enter", "Escape", "ArrowDown", "Shift+Tab", "Backspace", "Delete", "Insert", "Control+A", "Meta+Shift+A"])
			expect(validateHeliumKey(key)).toBe(key);
		for (const key of [
			"a",
			"1",
			"Shift+A",
			"Alt+A",
			"Control+V",
			"Meta+V",
			"Control+C",
			"Control+X",
			"Shift+Insert",
			"Control+Shift+Insert",
			"Paste",
		])
			expect(() => validateHeliumKey(key)).toThrow(/key|shortcut/i);
	});

	test("recognizes a focused sensitive field before deletion keys can mutate it", () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		const previousDocument = globals.document;
		try {
			globals.document = { activeElement: field({ type: "password", name: "password" }) };
			expect(focusedSensitiveFieldEvaluator()).toBe(true);
			globals.document = { activeElement: field({ name: "display_name" }) };
			expect(focusedSensitiveFieldEvaluator()).toBe(false);
		} finally {
			if (previousDocument === undefined) delete globals.document;
			else globals.document = previousDocument;
		}
	});

	test("rejects recognized credential and payment fields before mutation or events", () => {
		withDomGlobals(() => {
			for (const attributes of [
				{ type: "password" },
				{ autocomplete: "one-time-code" },
				{ name: "api_key" },
				{ name: "card_number" },
			]) {
				const target = field(attributes);
				const before = target.value;
				const result = inputActionEvaluator(target as never, "fill", "synthetic-secret");
				expect(result).toEqual({ status: "sensitive" });
				expect(target.value).toBe(before);
				expect((target as FakeElement & { eventCount: number }).eventCount).toBe(0);
			}
		});
	});

	test("keeps ordinary text fields editable and preserves selection for typing", () => {
		withDomGlobals(() => {
			const target = field({ value: "abcd" });
			Object.assign(target, {
				selectionStart: 1,
				selectionEnd: 3,
				setRangeText(value: string, start: number, end: number) {
					target.value = `${target.value.slice(0, start)}${value}${target.value.slice(end)}`;
					target.selectionStart = start + value.length;
					target.selectionEnd = start + value.length;
				},
			});
			expect(inputActionEvaluator(target as never, "fill", "replacement")).toEqual({ status: "ready" });
			expect(target.value).toBe("replacement");
			expect(inputActionEvaluator(target as never, "type", "!")).toEqual({ status: "ready" });
			expect(target.value).toBe("r!lacement");
			expect((target as FakeElement & { eventCount: number }).eventCount).toBe(3);
		});
	});

	test("rejects read-only, disabled, hidden, inert, detached, and unsupported targets", () => {
		withDomGlobals(() => {
			for (const attributes of [
				{ readOnly: "true" },
				{ disabled: "true" },
				{ hidden: "true" },
				{ inert: "true" },
			]) {
				const result = inputActionEvaluator(field(attributes) as never, "fill", "new-value");
				expect(result.status).toBe("not-actionable");
			}
			const detached = field();
			detached.isConnected = false;
			expect(inputActionEvaluator(detached as never, "fill", "new-value").status).toBe("stale");
			expect(inputActionEvaluator(field({ type: "submit" }) as never, "fill", "new-value").status).toBe(
				"unsupported",
			);
		});
	});
});

type LoginFixture = {
	document: Record<string, unknown>;
	username: FakeElement & { form: unknown };
	password: FakeElement & { form: unknown };
};

function loginFixture(
	action = "/login",
	buttonText = "Log In",
	extraText = "Forgot password? Sign up",
	extraInputs: FakeElement[] = [],
): LoginFixture {
	const form: Record<string, unknown> & {
		isConnected: boolean;
		innerText: string;
		parentElement: null;
		getAttribute(name: string): string | null;
		querySelectorAll(): unknown[];
	} = {
		isConnected: true,
		innerText: extraText,
		parentElement: null,
		getAttribute(name) {
			return ({ action, id: "login-form", class: "login" } as Record<string, string>)[name] ?? null;
		},
		querySelectorAll: () => [
			{
				tagName: "BUTTON",
				textContent: buttonText,
				value: "",
				type: "submit",
				getAttribute: (name: string) => (name === "type" ? "submit" : ""),
			},
		],
	};
	const username = field({ name: "username", autocomplete: "username" }) as FakeElement & { form: unknown };
	const password = field({ type: "password", name: "password", autocomplete: "current-password" }) as FakeElement & {
		form: unknown;
	};
	username.form = form;
	password.form = form;
	username.parentElement = form as never;
	password.parentElement = form as never;
	for (const extraInput of extraInputs) {
		extraInput.form = form;
		extraInput.parentElement = form;
	}
	const document = {
		querySelectorAll(selector: string) {
			return selector === "input" ? [username, password, ...extraInputs] : [form];
		},
	};
	return { document, username, password };
}

describe("Helium APW login identity and semantics", () => {
	test("accepts recovery/signup navigation links but rejects actual recovery and signup forms", () => {
		withDomGlobals(() => {
			const globals = globalThis as unknown as Record<string, unknown>;
			const previousDocument = globals.document;
			const previousLocation = globals.location;
			try {
				const login = loginFixture();
				globals.document = login.document;
				globals.location = { protocol: "https:", origin: "https://login.example.test" };
				expect(loginFormEvaluator("discover")).toBeDefined();
				globals.document = loginFixture("/password/reset", "Reset password", "").document;
				expect(loginFormEvaluator("discover")).toBeUndefined();
				globals.document = loginFixture("/signup", "Create account", "").document;
				expect(loginFormEvaluator("discover")).toBeUndefined();
				globals.document = loginFixture("/verify", "Verify", "", [field({ name: "otp", autocomplete: "one-time-code" })]).document;
				expect(loginFormEvaluator("discover")).toBeUndefined();
			} finally {
				if (previousDocument === undefined) delete globals.document;
				else globals.document = previousDocument;
				if (previousLocation === undefined) delete globals.location;
				else globals.location = previousLocation;
			}
		});
	});

	test("sanitizes browser-side evaluator errors after credential retrieval", async () => {
		const canary = "synthetic-page-error-canary";
		const page = {
			evaluate: async () => {
				throw new Error(canary);
			},
		};
		const descriptor = { passwordIndex: 0, signature: "fixture" };
		try {
			await fillApwOnPage(page as never, "https://login.example.test", descriptor, "alice", canary);
			throw new Error("expected safe APW failure");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("APW autofill was canceled");
			expect(message).not.toContain(canary);
		}
	});

	test("revalidates the exact discovered document/form before filling", () => {
		withDomGlobals(() => {
			const globals = globalThis as unknown as Record<string, unknown>;
			const previousDocument = globals.document;
			const previousLocation = globals.location;
			try {
				const first = loginFixture();
				globals.document = first.document;
				globals.location = { protocol: "https:", origin: "https://login.example.test" };
				const descriptor = loginFormEvaluator("discover");
				expect(descriptor && typeof descriptor === "object").toBe(true);
				const unchanged = loginFormEvaluator(
					"fill",
					"https://login.example.test",
					"alice",
					"synthetic-secret",
					(descriptor as { signature: string }).signature,
				);
				expect(unchanged).toBe(true);

				const replacement = loginFixture();
				globals.document = replacement.document;
				const changed = loginFormEvaluator(
					"fill",
					"https://login.example.test",
					"alice",
					"synthetic-secret",
					(descriptor as { signature: string }).signature,
				);
				expect(changed).toBe(false);
				expect(replacement.username.value).toBe("before");
				expect(replacement.password.value).toBe("before");
			} finally {
				if (previousDocument === undefined) delete globals.document;
				else globals.document = previousDocument;
				if (previousLocation === undefined) delete globals.location;
				else globals.location = previousLocation;
			}
		});
	});
});
