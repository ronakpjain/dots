import { describe, expect, test } from "bun:test";
import { disposeAllRefs, makeSnapshot, snapshotEvaluator } from "../extensions/helium-browser/index.ts";

type Remote = {
	getProperties(): Promise<Map<string, Remote>>;
	jsonValue(): Promise<unknown>;
	dispose(): Promise<void>;
};

function scalar(value: unknown): Remote {
	return { getProperties: async () => new Map(), jsonValue: async () => value, dispose: async () => {} };
}

function element(name: string, disposed: string[]): Remote {
	return {
		getProperties: async () => new Map(),
		jsonValue: async () => ({}),
		dispose: async () => disposed.push(name),
	};
}

function capture(
	refs: Array<{ ref: string; label: string; kind: string; element: Remote }>,
	body = "body",
): Remote {
	const entries = refs.map((ref) => ({
		getProperties: async () =>
			new Map([
				["ref", scalar(ref.ref)],
				["label", scalar(ref.label)],
				["kind", scalar(ref.kind)],
				["element", ref.element],
			]),
		jsonValue: async () => ({}),
			dispose: async () => {},
	}));
	return {
		getProperties: async () =>
			new Map([
				["bodyText", scalar(body)],
				["bodyTruncated", scalar(false)],
				[
					"refs",
					{
						getProperties: async () => new Map(entries.map((entry, index) => [String(index), entry])),
						jsonValue: async () => ({}),
						dispose: async () => {},
					},
				],
				["omittedCandidateCount", scalar(0)],
			]),
		jsonValue: async () => ({}),
		dispose: async () => {},
	};
}

describe("Helium snapshot exact refs", () => {
	test("filters hidden/inert ancestors, preserves block boundaries, includes contenteditable='', and redacts OTP/payment/token values", () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		const previousDocument = globals.document;
		const previousStyle = globals.getComputedStyle;
		class FixtureElement {
			nodeType = 1;
			parentElement: FixtureElement | null = null;
			textContent = "";
			innerText = "";
			value = "";
			hidden = false;
			constructor(
				public readonly tagName: string,
				private readonly attributes: Record<string, string> = {},
			) {
				this.hidden = "hidden" in attributes;
			}
			getAttribute(name: string): string | null {
				return this.attributes[name] ?? null;
			}
			hasAttribute(name: string): boolean {
				return name in this.attributes;
			}
			matches(): boolean {
				return false;
			}
		}
		const body = new FixtureElement("BODY");
		const first = new FixtureElement("DIV");
		const second = new FixtureElement("DIV");
		const hiddenParent = new FixtureElement("DIV", { hidden: "" });
		const hiddenButton = new FixtureElement("BUTTON");
		const inertParent = new FixtureElement("DIV", { inert: "" });
		const inertButton = new FixtureElement("BUTTON");
		// An empty contenteditable attribute is an editable element in HTML.
		const editable = new FixtureElement("DIV", { contenteditable: "", "aria-label": "Notes" });
		const otp = new FixtureElement("INPUT", { name: "otp", autocomplete: "one-time-code" });
		const payment = new FixtureElement("INPUT", { name: "card_number" });
		const token = new FixtureElement("INPUT", { name: "token" });
		const tokenEditable = new FixtureElement("DIV", { contenteditable: "", name: "token" });
		otp.value = "OTP_CANARY_DO_NOT_LEAK";
		payment.value = "PAYMENT_CANARY_DO_NOT_LEAK";
		token.value = "TOKEN_CANARY_DO_NOT_LEAK";
		tokenEditable.textContent = "EDITABLE_TOKEN_CANARY_DO_NOT_LEAK";
		for (const child of [first, second, hiddenParent, inertParent, editable, otp, payment, token, tokenEditable]) child.parentElement = body;
		hiddenButton.parentElement = hiddenParent;
		inertButton.parentElement = inertParent;
		const text = (parentElement: FixtureElement, textContent: string) => ({ parentElement, textContent });
		const textNodes = [
			text(first, "Alpha"),
			text(second, "Beta"),
			text(hiddenButton, "HIDDEN_ANCESTOR_CANARY"),
			text(inertButton, "INERT_ANCESTOR_CANARY"),
			text(tokenEditable, "EDITABLE_TOKEN_CANARY_DO_NOT_LEAK"),
		];
		try {
			globals.getComputedStyle = () => ({
				display: "block",
				visibility: "visible",
				opacity: "1",
				contentVisibility: "visible",
			});
			globals.document = {
				body,
				createTreeWalker: (_root: unknown, whatToShow: number) => {
					const nodes = whatToShow === 4
						? textNodes
						: [hiddenButton, inertButton, editable, otp, payment, token, tokenEditable];
					let cursor = 0;
					return { nextNode: () => nodes[cursor++] ?? null };
				},
			};
			const snapshot = snapshotEvaluator(true, 2_000);
			expect(snapshot.bodyText).toContain("Alpha\nBeta");
			for (const canary of ["HIDDEN_ANCESTOR_CANARY", "INERT_ANCESTOR_CANARY", "EDITABLE_TOKEN_CANARY_DO_NOT_LEAK", "OTP_CANARY_DO_NOT_LEAK"])
				expect(snapshot.bodyText).not.toContain(canary);
			expect(snapshot.refs.some((entry) => entry.kind === "div" && entry.label === "Notes")).toBe(true);
			expect(snapshot.refs.filter((entry) => entry.kind === "input").every((entry) => entry.label === "")).toBe(true);
			expect(snapshot.refs.some((entry) => entry.label.includes("PAYMENT_CANARY_DO_NOT_LEAK"))).toBe(false);
			expect(snapshot.refs.some((entry) => entry.label.includes("TOKEN_CANARY_DO_NOT_LEAK"))).toBe(false);
			expect(snapshot.refs.some((entry) => entry.label.includes("HIDDEN_ANCESTOR_CANARY"))).toBe(false);
			expect(snapshot.refs.some((entry) => entry.label.includes("INERT_ANCESTOR_CANARY"))).toBe(false);
		} finally {
			if (previousDocument === undefined) delete globals.document;
			else globals.document = previousDocument;
			if (previousStyle === undefined) delete globals.getComputedStyle;
			else globals.getComputedStyle = previousStyle;
		}
	});

	test("duplicate page attributes cannot redirect a ref to a decoy node", async () => {
		await disposeAllRefs();
		const disposed: string[] = [];
		let selectorLookups = 0;
		const page = {
			evaluateHandle: async () =>
				capture([{ ref: "e1", label: "Expected", kind: "button", element: element("expected", disposed) }]),
			$: async () => {
				selectorLookups++;
				throw new Error("snapshot refs must not use selectors");
			},
			isClosed: () => false,
			url: () => "https://example.test",
			title: async () => "Example",
		};
		const snapshot = await makeSnapshot(page as never, "duplicate-tab", 4_000, true);
		expect(snapshot).toContain("Expected");
		expect(snapshot).toMatch(/s\d+-e1/);
		expect(selectorLookups).toBe(0);
		await disposeAllRefs();
		expect(disposed).toContain("expected");
	});

	test("rerendering invalidates the old generation instead of rebinding it", async () => {
		await disposeAllRefs();
		let captureCount = 0;
		const disposed: string[] = [];
		const page = {
			evaluateHandle: async () => {
				captureCount++;
				return capture([{ ref: "e1", label: captureCount === 1 ? "old" : "new", kind: "button", element: element(String(captureCount), disposed) }]);
			},
			isClosed: () => false,
			url: () => "https://example.test",
			title: async () => "Example",
		};
		const oldSnapshot = await makeSnapshot(page as never, "rerender-tab", 4_000, true);
		const newSnapshot = await makeSnapshot(page as never, "rerender-tab", 4_000, true);
		expect(oldSnapshot).toMatch(/s\d+-e1/);
		expect(newSnapshot).toMatch(/s\d+-e1/);
		expect(oldSnapshot.match(/s\d+-e1/)?.[0]).not.toBe(newSnapshot.match(/s\d+-e1/)?.[0]);
		expect(newSnapshot).toContain("new");
		await disposeAllRefs();
		expect(disposed).toContain("1");
		expect(disposed).toContain("2");
	});

	test("continues body and refs with an opaque single-use cursor", async () => {
		await disposeAllRefs();
		const calls: unknown[][] = [];
		const page = {
			evaluate: async (_fn: unknown, ...args: unknown[]) => {
				calls.push(args);
				const bodyStart = Number(args[6] ?? 0);
				const candidateStart = Number(args[7] ?? 0);
				const batchSize = candidateStart === 0 ? 256 : 44;
				return {
					bodyText: bodyStart === 0 ? "top content" : "bottom content",
					bodyTruncated: bodyStart === 0,
					bodyNextOffset: bodyStart === 0 ? 1 : 2,
					bodyDone: bodyStart !== 0,
					candidateNextOffset: candidateStart === 0 ? 256 : 300,
					candidateDone: candidateStart !== 0,
					refs: Array.from({ length: batchSize }, (_, index) => ({
						ref: `e${index + 1}`,
						label: candidateStart === 0 ? "first" : "later",
						kind: "button",
					})),
				};
			},
			$: async () => ({ dispose: async () => {} }),
			isClosed: () => false,
			url: () => "https://example.test",
			title: async () => "Example",
		};
		const first = await makeSnapshot(page as never, "continuation-tab", 30_000, true, { scope: "#main" });
		const token = first.match(/Continuation cursor: ([A-Za-z0-9-]+)/)?.[1];
		expect(token).toBeTruthy();
		expect(first).toContain("top content");
		expect(first).toMatch(/s\d+-e256/);
		const second = await makeSnapshot(page as never, "continuation-tab", 30_000, true, {
			cursor: token,
			scope: "#main",
		});
		expect(second).toContain("bottom content");
		expect(second).toMatch(/s\d+-e300/);
		expect(calls[1]?.[8]).toBe("#main");
		await expect(
			makeSnapshot(page as never, "continuation-tab", 30_000, true, { cursor: token, scope: "#main" }),
		).rejects.toThrow("Stale snapshot cursor");
		await disposeAllRefs();
	});

	test("keeps body text visible under a dense ref budget", async () => {
		await disposeAllRefs();
		const refs = Array.from({ length: 256 }, (_, index) => ({
			ref: `e${index + 1}`,
			label: `control-${index}-with-a-long-label-${"x".repeat(120)}`,
			kind: "button",
		}));
		const page = {
			evaluate: async () => ({ bodyText: "BOTTOM_CONTENT_CANARY", bodyTruncated: false, refs }),
			$: async () => ({ dispose: async () => {} }),
			isClosed: () => false,
			url: () => "https://example.test",
			title: async () => "Example",
		};
		const snapshot = await makeSnapshot(page as never, "budget-tab", 1_000, true);
		expect(snapshot.length).toBeLessThanOrEqual(1_000);
		expect(snapshot).toContain("BOTTOM_CONTENT_CANARY");
		await disposeAllRefs();
	});

	test("continues past the body inspection boundary with monotonic progress", () => {
		const globals = globalThis as unknown as Record<string, any>;
		const previous = { document: globals.document, style: globals.getComputedStyle };
		const body: any = {
			nodeType: 1,
			tagName: "BODY",
			parentElement: null,
			getAttribute: () => null,
			hasAttribute: () => false,
			matches: () => false,
		};
		const textNodes = Array.from({ length: 12_500 }, () => ({ textContent: "x", parentElement: body }));
		try {
			globals.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible" });
			globals.document = {
				body,
				createTreeWalker: (_root: unknown, whatToShow: number) => {
					const nodes = whatToShow === 4 ? textNodes : [];
					let index = 0;
					return { nextNode: () => nodes[index++] ?? null };
				},
			};
			let snapshot = snapshotEvaluator(false, 100, 1, 1, "", false, 10_000);
			expect(snapshot.bodyNextOffset).toBeGreaterThan(10_000);
			expect(snapshot.bodyDone).toBe(false);
			let iterations = 0;
			while (!snapshot.bodyDone && iterations++ < 40) {
				const previousOffset = snapshot.bodyNextOffset;
				snapshot = snapshotEvaluator(
					false,
					100,
					1,
					1,
					"",
					false,
					snapshot.bodyNextOffset,
					0,
					"",
					0,
					snapshot.bodyNodeNextOffset,
					snapshot.bodyStreamNextOffset,
				);
				expect(snapshot.bodyNextOffset).toBeGreaterThan(previousOffset);
			}
			expect(snapshot.bodyDone).toBe(true);
			expect(iterations).toBeLessThan(40);
		} finally {
			if (previous.document === undefined) delete globals.document;
			else globals.document = previous.document;
			if (previous.style === undefined) delete globals.getComputedStyle;
			else globals.getComputedStyle = previous.style;
		}
	});

	test("continues past the candidate inspection boundary with monotonic progress", () => {
		const globals = globalThis as unknown as Record<string, any>;
		const previous = { document: globals.document, style: globals.getComputedStyle };
		const body: any = {
			nodeType: 1,
			tagName: "BODY",
			parentElement: null,
			getAttribute: () => null,
			hasAttribute: () => false,
			matches: () => false,
		};
		const textNode = { textContent: "body", parentElement: body };
		const controls = Array.from({ length: 2_100 }, (_, index) => ({
			nodeType: 1,
			tagName: "BUTTON",
			parentElement: body,
			innerText: `control-${index}`,
			textContent: `control-${index}`,
			getAttribute: (name: string) => (name === "aria-label" ? `control-${index}` : null),
			hasAttribute: () => false,
		}));
		try {
			globals.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible" });
			globals.document = {
				body,
				createTreeWalker: (_root: unknown, whatToShow: number) => {
					const nodes = whatToShow === 4 ? [textNode] : controls;
					let index = 0;
					return { nextNode: () => nodes[index++] ?? null };
				},
			};
			let snapshot = snapshotEvaluator(true, 100, 4, 4, "", false, 0, 1_024);
			expect(snapshot.candidateNextOffset).toBeGreaterThan(1_024);
			expect(snapshot.candidateDone).toBe(false);
			let iterations = 0;
			while (!snapshot.candidateDone && iterations++ < 400) {
				const previousOffset = snapshot.candidateNextOffset;
				snapshot = snapshotEvaluator(true, 100, 4, 4, "", false, 0, previousOffset, "", snapshot.refNextOrdinal);
				expect(snapshot.candidateNextOffset).toBeGreaterThan(previousOffset);
			}
			expect(snapshot.candidateDone).toBe(true);
			expect(iterations).toBeLessThan(400);
		} finally {
			if (previous.document === undefined) delete globals.document;
			else globals.document = previous.document;
			if (previous.style === undefined) delete globals.getComputedStyle;
			else globals.getComputedStyle = previous.style;
		}
	});

	test("walks interactive controls without allocating a document-wide NodeList", () => {
		const globals = globalThis as unknown as Record<string, any>;
		const previous = { document: globals.document, style: globals.getComputedStyle };
		const body: any = { nodeType: 1, tagName: "BODY", parentElement: null, hasAttribute: () => false, getAttribute: () => null };
		const textNode = { textContent: "bottom body text", parentElement: body };
		const controls = Array.from({ length: 4 }, (_, index) => ({
			nodeType: 1,
			tagName: "BUTTON",
			parentElement: body,
			innerText: `Control ${index}`,
			textContent: `Control ${index}`,
			getAttribute: (name: string) => (name === "aria-label" ? `Control ${index}` : null),
			hasAttribute: () => false,
		}));
		let walkerCalls = 0;
		try {
			globals.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible" });
			globals.document = {
				body,
				createTreeWalker: (_root: unknown, whatToShow: number) => {
					walkerCalls++;
					const nodes = whatToShow === 4 ? [textNode] : controls;
					let index = 0;
					return { nextNode: () => nodes[index++] ?? null };
				},
				querySelectorAll: () => {
					throw new Error("snapshot must not allocate document-wide candidates");
				},
			};
			const snapshot = snapshotEvaluator(true, 1_000, 2, 100);
			expect(walkerCalls).toBe(2);
			expect(snapshot.refs).toHaveLength(2);
			expect(snapshot.candidateDone).toBe(false);
			expect(snapshot.bodyText).toContain("bottom body text");
			const continued = snapshotEvaluator(
				true,
				1_000,
				2,
				100,
				"",
				false,
				snapshot.bodyNextOffset,
				snapshot.candidateNextOffset,
			);
			expect(continued.refs.map((entry) => entry.label)).toEqual(["Control 2", "Control 3"]);
			expect(continued.candidateDone).toBe(true);
		} finally {
			if (previous.document === undefined) delete globals.document;
			else globals.document = previous.document;
			if (previous.style === undefined) delete globals.getComputedStyle;
			else globals.getComputedStyle = previous.style;
		}
	});
});
