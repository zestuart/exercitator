/**
 * Per-user response cache for the HTTP API.
 *
 * Two-level structure: a top-level `Map<userId, Map<key, Entry>>`. The
 * inner map is bounded so one userId's bursts cannot evict another
 * userId's entries (cross-user cache flooding). Insertion order in each
 * inner map doubles as LRU recency — `cacheGet` re-inserts on hit to
 * bump the entry to the tail.
 *
 * Bounds:
 *   - per-user cap: EXERCITATOR_API_CACHE_MAX_ENTRIES (default 64)
 *   - TTL:          EXERCITATOR_API_CACHE_TTL_S         (default 300)
 *
 * `?fresh=1` (handled in the router) bypasses on read.
 *
 * A periodic prune (`startCachePrune`, called from src/api/server.ts on
 * listen) sweeps already-expired entries every 60 s so a key that's
 * never read again can't keep its slot indefinitely.
 */

const DEFAULT_TTL_S = 300;
const DEFAULT_MAX_ENTRIES_PER_USER = 64;
const PRUNE_INTERVAL_MS = 60_000;

interface Entry<T> {
	value: T;
	expiresAt: number;
}

const userStores = new Map<string, Map<string, Entry<unknown>>>();

function ttlMs(): number {
	const s = Number.parseInt(process.env.EXERCITATOR_API_CACHE_TTL_S ?? "", 10);
	return (Number.isFinite(s) && s > 0 ? s : DEFAULT_TTL_S) * 1000;
}

function maxEntriesPerUser(): number {
	const n = Number.parseInt(process.env.EXERCITATOR_API_CACHE_MAX_ENTRIES ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ENTRIES_PER_USER;
}

function userStore(userId: string): Map<string, Entry<unknown>> {
	let store = userStores.get(userId);
	if (!store) {
		store = new Map();
		userStores.set(userId, store);
	}
	return store;
}

export function cacheGet<T>(userId: string, key: string): T | null {
	const store = userStores.get(userId);
	if (!store) return null;
	const hit = store.get(key);
	if (!hit) return null;
	if (hit.expiresAt < Date.now()) {
		store.delete(key);
		if (store.size === 0) userStores.delete(userId);
		return null;
	}
	// LRU bump: re-insert to move to the tail of insertion order.
	store.delete(key);
	store.set(key, hit);
	return hit.value as T;
}

export function cacheSet<T>(userId: string, key: string, value: T): void {
	const store = userStore(userId);
	// Refresh existing entry by deleting first so it goes to the tail.
	store.delete(key);
	store.set(key, { value, expiresAt: Date.now() + ttlMs() });

	// LRU eviction within this user's bucket only.
	const cap = maxEntriesPerUser();
	while (store.size > cap) {
		const oldest = store.keys().next().value;
		if (oldest === undefined) break;
		store.delete(oldest);
	}
}

export function cacheInvalidate(userId?: string): void {
	if (!userId) {
		userStores.clear();
		return;
	}
	userStores.delete(userId);
}

/** Drop entries that are already past their expiry. Cheap O(n) sweep. */
export function pruneExpired(now: number = Date.now()): number {
	let removed = 0;
	for (const [userId, store] of userStores) {
		for (const [k, entry] of store) {
			if (entry.expiresAt < now) {
				store.delete(k);
				removed++;
			}
		}
		if (store.size === 0) userStores.delete(userId);
	}
	return removed;
}

/**
 * Start a background prune timer that sweeps expired entries on a 60s
 * cadence. Idempotent: subsequent calls return the existing timer.
 *
 * The timer is `.unref()`d so it never blocks process shutdown.
 */
let pruneTimer: NodeJS.Timeout | null = null;

export function startCachePrune(): NodeJS.Timeout {
	if (pruneTimer) return pruneTimer;
	pruneTimer = setInterval(() => pruneExpired(), PRUNE_INTERVAL_MS);
	pruneTimer.unref();
	return pruneTimer;
}

export function stopCachePrune(): void {
	if (pruneTimer) {
		clearInterval(pruneTimer);
		pruneTimer = null;
	}
}

/** Test-only helper. */
export function _cacheSize(): number {
	let n = 0;
	for (const store of userStores.values()) n += store.size;
	return n;
}
