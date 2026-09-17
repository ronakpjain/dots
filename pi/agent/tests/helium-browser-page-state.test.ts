import { afterEach, describe, expect, test } from "bun:test";
import {
	MAX_SNAPSHOT_CURSORS,
	MAX_SNAPSHOT_CURSORS_PER_TAB,
	SNAPSHOT_CURSOR_TTL_MS,
	clearSnapshotCursorsForPage,
	detachAllRefMaps,
	getSnapshotCursor,
	getSnapshotCursorCount,
	setSnapshotCursor,
	type RefState,
} from "../extensions/helium-browser/page-state.ts";

const page = {} as never;
const state = (generation: number): RefState => ({ generation, page, handles: new Map() });
const cursor = (token: string, id: string, generation: number, createdAt = Date.now()) => ({
	token,
	id,
	page,
	state: state(generation),
	includeRefs: true,
	bodyOffset: 0,
	candidateOffset: 0,
	refOrdinal: 0,
	createdAt,
});

afterEach(() => {
	detachAllRefMaps();
});

describe("snapshot cursor bounds", () => {
	test("prunes abandoned cursors per tab deterministically", () => {
		const now = Date.now();
		for (let index = 0; index < MAX_SNAPSHOT_CURSORS_PER_TAB + 5; index++) {
			setSnapshotCursor(cursor(`same-${index}`, "same-tab", index, now + index));
		}
		expect(getSnapshotCursorCount()).toBe(MAX_SNAPSHOT_CURSORS_PER_TAB);
		expect(getSnapshotCursor("same-0")).toBeUndefined();
		expect(getSnapshotCursor(`same-${MAX_SNAPSHOT_CURSORS_PER_TAB + 4}`)).toBeDefined();
	});

	test("keeps the global cursor store bounded across tabs", () => {
		const now = Date.now();
		for (let index = 0; index < MAX_SNAPSHOT_CURSORS + 40; index++) {
			setSnapshotCursor(cursor(`global-${index}`, `tab-${index}`, index, now + index));
		}
		expect(getSnapshotCursorCount()).toBe(MAX_SNAPSHOT_CURSORS);
		expect(getSnapshotCursor("global-0")).toBeUndefined();
		expect(getSnapshotCursor(`global-${MAX_SNAPSHOT_CURSORS + 39}`)).toBeDefined();
	});

	test("expires stale cursors before lookup and safely clears a page", () => {
		const stalePage = {} as never;
		setSnapshotCursor({ ...cursor("expired", "expired-tab", 1, Date.now() - SNAPSHOT_CURSOR_TTL_MS - 1), page: stalePage });
		expect(getSnapshotCursor("expired")).toBeUndefined();
		expect(getSnapshotCursorCount()).toBe(0);

		setSnapshotCursor({ ...cursor("page-a", "page-tab", 2), page: stalePage });
		setSnapshotCursor({ ...cursor("page-b", "page-tab", 3), page: stalePage });
		clearSnapshotCursorsForPage(stalePage);
		expect(getSnapshotCursorCount()).toBe(0);
	});
});
