/**
 * Per-user response cache for the HTTP API.
 *
 * Keyed by (userId, cacheKey). TTL comes from EXERCITATOR_API_CACHE_TTL_S
 * (default 300). Bypass with query ?fresh=1 (handled in the router).
 *
 * Bounded: capped at EXERCITATOR_API_CACHE_MAX_ENTRIES (default 1000) with
 * LRU eviction on insert. Map insertion order doubles as the LRU recency
 * order — `cacheGet` re-inserts on hit to bump the entry to the tail.
 *
 * A periodic prune (started from `startCachePrune` in src/api/server.ts)
 * sweeps already-expired entries every 60 s so a key that's never read
 * again can't keep its slot indefinitely.
 */

const DEFAULT_TTL_S = 300;
const DEFAULT_MAX_ENTRIES = 1000;
const PRUNE_INTERVAL_MS = 60_000;

interface Entry<T> {
	value: T;
	expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

function ttlMs(): number {
	const s = Number.parseInt(process.env.EXERCITATOR_API_CACHE_TTL_S ?? "", 10);
	return (Number.isFinite(s) && s > 0 ? s : DEFAULT_TTL_S) * 1000;
}

function maxEntries(): number {
	const n = Number.parseInt(process.env.EXERCITATOR_API_CACHE_MAX_ENTRIES ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ENTRIES;
}

function cacheKey(userId: string, key: string): string {
	return `${userId}::${key}`;
}

export function cacheGet<T>(userId: string, key: string): T | null {
	const k = cacheKey(userId, key);
	const hit = store.get(k);
	if (!hit) return null;
	if (hit.expiresAt < Date.now()) {
		store.delete(k);
		return null;
	}
	// LRU bump: re-insert to move to the tail of insertion order.
	store.delete(k);
	store.set(k, hit);
	return hit.value as T;
}

export function cacheSet<T>(userId: string, key: string, value: T): void {
	const k = cacheKey(userId, key);
	// Refresh existing entry by deleting first so it goes to the tail.
	store.delete(k);
	store.set(k, { value, expiresAt: Date.now() + ttlMs() });

	// LRU eviction: drop oldest entries until we're under the cap.
	const cap = maxEntries();
	while (store.size > cap) {
		const oldest = store.keys().next().value;
		if (oldest === undefined) break;
		store.delete(oldest);
	}
}

export function cacheInvalidate(userId?: string): void {
	if (!userId) {
		store.clear();
		return;
	}
	const prefix = `${userId}::`;
	for (const k of store.keys()) {
		if (k.startsWith(prefix)) store.delete(k);
	}
}

/** Drop entries that are already past their expiry. Cheap O(n) sweep. */
export function pruneExpired(now: number = Date.now()): number {
	let removed = 0;
	for (const [k, entry] of store) {
		if (entry.expiresAt < now) {
			store.delete(k);
			removed++;
		}
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
	return store.size;
}
