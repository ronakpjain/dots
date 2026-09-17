import type { Page } from "puppeteer-core";

/** Remote element handles retained by a snapshot generation. */
export type RefHandle = import("puppeteer-core").ElementHandle<Element>;
export type RefMap = Map<string, RefHandle>;
export type RefState = {
	generation: number;
	page: Page;
	handles: RefMap;
};

export type SnapshotCursor = {
	token: string;
	id: string;
	page: Page;
	state: RefState;
	includeRefs: boolean;
	scope?: string;
	bodyOffset: number;
	candidateOffset: number;
	refOrdinal: number;
	/** Renderer-only checkpoint for filtered text nodes; optional for compatibility. */
	bodyNodeOffset?: number;
	bodyStreamOffset?: number;
	/** Renderer checkpoints let continuations resume without replaying the prefix. */
	bodyNextPath?: number[];
	bodyBlockPath?: number[];
	candidateNextPath?: number[];
	/** Optional creation time retained for deterministic tests and old callers. */
	createdAt?: number;
};

/** Cursor state is bounded even when callers abandon continuation chains. */
export const SNAPSHOT_CURSOR_TTL_MS = 5 * 60_000;
export const MAX_SNAPSHOT_CURSORS = 256;
export const MAX_SNAPSHOT_CURSORS_PER_TAB = 32;

const REF_DISPOSAL_CONCURRENCY = 8;
const REF_DISPOSAL_SHUTDOWN_TIMEOUT_MS = 2_000;

let nextRefGeneration = 1;
// State identity, rather than an ever-increasing counter, rejects a snapshot
// that finishes after its tab was cleared or replaced. Cleared state is
// removed, so tab ids cannot accumulate generation entries forever.
const refStates = new Map<string, RefState>();
/** Cursor tokens are deliberately kept outside page-controlled markup. */
const snapshotCursors = new Map<string, SnapshotCursor>();
const pendingRefDisposals = new Set<Promise<void>>();

function cursorCreatedAt(cursor: SnapshotCursor, fallback: number): number {
	return Number.isFinite(cursor.createdAt) ? (cursor.createdAt as number) : fallback;
}

function oldestCursor(predicate: (cursor: SnapshotCursor) => boolean): [string, SnapshotCursor] | undefined {
	return [...snapshotCursors.entries()]
		.filter(([, cursor]) => predicate(cursor))
		.sort(([leftToken, left], [rightToken, right]) => {
			const createdAtDifference = cursorCreatedAt(left, 0) - cursorCreatedAt(right, 0);
			return createdAtDifference || leftToken.localeCompare(rightToken);
		})[0];
}

function pruneExpiredSnapshotCursors(now = Date.now()): void {
	for (const [token, cursor] of snapshotCursors) {
		if (now - cursorCreatedAt(cursor, now) >= SNAPSHOT_CURSOR_TTL_MS) snapshotCursors.delete(token);
	}
}

function pruneSnapshotCursorCaps(): void {
	const tabCounts = new Map<string, number>();
	for (const cursor of snapshotCursors.values()) tabCounts.set(cursor.id, (tabCounts.get(cursor.id) ?? 0) + 1);
	for (const [id, count] of tabCounts) {
		let excess = count - MAX_SNAPSHOT_CURSORS_PER_TAB;
		while (excess-- > 0) {
			const oldest = oldestCursor((cursor) => cursor.id === id);
			if (!oldest) break;
			snapshotCursors.delete(oldest[0]);
		}
	}
	while (snapshotCursors.size > MAX_SNAPSHOT_CURSORS) {
		const oldest = oldestCursor(() => true);
		if (!oldest) break;
		snapshotCursors.delete(oldest[0]);
	}
}
let activeRefDisposals = 0;
const refDisposalWaiters: Array<() => void> = [];

/** Return a handle only when it belongs to the current page generation. */
export function getCachedRefHandle(id: string, page: Page, ref: string): RefHandle | undefined {
	const state = refStates.get(id);
	return state?.page === page ? state.handles.get(ref) : undefined;
}

export function getRefStateIds(): string[] {
	return [...refStates.keys()];
}

export function isCurrentRefState(id: string, state: RefState): boolean {
	return refStates.get(id) === state;
}

export function getRefStateHandleCount(state: RefState): number {
	return state.handles.size;
}

/** Store handles only when the snapshot generation is still current. */
export function cacheRefHandles(id: string, state: RefState, handles: RefMap): boolean {
	if (!isCurrentRefState(id, state)) return false;
	for (const [ref, handle] of handles) state.handles.set(ref, handle);
	return true;
}

export function removeEmptyRefState(id: string, state: RefState): void {
	if (isCurrentRefState(id, state) && state.handles.size === 0) refStates.delete(id);
}

export function getSnapshotCursor(token: string): SnapshotCursor | undefined {
	pruneExpiredSnapshotCursors();
	return snapshotCursors.get(token);
}

export function deleteSnapshotCursor(token: string): void {
	snapshotCursors.delete(token);
}

export function setSnapshotCursor(cursor: SnapshotCursor): void {
	const now = Date.now();
	pruneExpiredSnapshotCursors(now);
	snapshotCursors.set(cursor.token, { ...cursor, createdAt: cursorCreatedAt(cursor, now) });
	pruneSnapshotCursorCaps();
}

/** Test/diagnostic visibility for the bounded continuation store. */
export function getSnapshotCursorCount(): number {
	pruneExpiredSnapshotCursors();
	return snapshotCursors.size;
}

async function withRefDisposalPermit(operation: () => Promise<void>): Promise<void> {
	if (activeRefDisposals < REF_DISPOSAL_CONCURRENCY) activeRefDisposals++;
	else await new Promise<void>((resolve) => refDisposalWaiters.push(resolve));
	try {
		await operation();
	} finally {
		const waiter = refDisposalWaiters.shift();
		if (waiter) waiter();
		else activeRefDisposals--;
	}
}

/** Dispose handles with a small shared concurrency cap across cache replacements. */
export async function disposeRefHandles(handles: Iterable<Pick<RefHandle, "dispose">>): Promise<void> {
	const iterator = handles[Symbol.iterator]();
	const worker = async (): Promise<void> => {
		for (;;) {
			const next = iterator.next();
			if (next.done) return;
			await withRefDisposalPermit(async () => {
				await next.value.dispose();
			}).catch(() => {});
		}
	};
	await Promise.allSettled(Array.from({ length: REF_DISPOSAL_CONCURRENCY }, () => worker()));
}

async function disposeRefMap(refs: RefMap | undefined): Promise<void> {
	if (!refs) return;
	await disposeRefHandles(refs.values());
}

export function trackRefDisposal(refs: RefMap | undefined): Promise<void> {
	if (!refs || refs.size === 0) return Promise.resolve();
	const disposal = disposeRefMap(refs);
	pendingRefDisposals.add(disposal);
	void disposal.then(
		() => pendingRefDisposals.delete(disposal),
		() => pendingRefDisposals.delete(disposal),
	);
	return disposal;
}

function invalidateSnapshotCursors(id: string): void {
	for (const [token, cursor] of snapshotCursors) if (cursor.id === id) snapshotCursors.delete(token);
}

export function clearSnapshotCursorsForPage(page: Page): void {
	for (const [token, cursor] of snapshotCursors) if (cursor.page === page) snapshotCursors.delete(token);
}

export function detachAllRefMaps(): RefMap[] {
	const maps = [...refStates.values()].map((state) => state.handles);
	refStates.clear();
	snapshotCursors.clear();
	return maps;
}

export async function disposeDetachedRefMaps(maps: RefMap[]): Promise<void> {
	const current = maps.map((refs) => trackRefDisposal(refs));
	await Promise.allSettled([...current, ...pendingRefDisposals]);
}

export async function awaitRefDisposalDuringShutdown(disposal: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		disposal,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, REF_DISPOSAL_SHUTDOWN_TIMEOUT_MS);
		}),
	]);
	if (timer) clearTimeout(timer);
	// If the timeout won, the shared all-settled cleanup remains explicitly handled.
	void disposal.catch(() => {});
}

/** Atomically detach every stored handle, then dispose with bounded concurrency. */
export async function disposeAllRefs(): Promise<void> {
	await disposeDetachedRefMaps(detachAllRefMaps());
}

export function invalidateRefs(id: string, page: Page): RefState {
	const previous = refStates.get(id);
	invalidateSnapshotCursors(id);
	const state: RefState = { generation: nextRefGeneration++, page, handles: new Map() };
	refStates.set(id, state);
	// This is deliberately fire-and-forget: disposal is all-settled, and the
	// state is already detached so a later snapshot cannot reuse it.
	void trackRefDisposal(previous?.handles);
	return state;
}

/** Remove one tab's cache and invalidate all cursors that refer to it. */
export async function pruneRefCache(id: string): Promise<void> {
	const previous = refStates.get(id);
	invalidateSnapshotCursors(id);
	if (!previous) return;
	refStates.delete(id);
	await trackRefDisposal(previous.handles);
}

export function getHeliumRefCacheStats(): { tabCount: number; handleCount: number } {
	return {
		tabCount: refStates.size,
		handleCount: [...refStates.values()].reduce((total, state) => total + state.handles.size, 0),
	};
}
