/**
 * Per-user response cache for the HTTP API.
 *
 * Keyed by (userId, cacheKey). TTL comes from EXERCITATOR_API_CACHE_TTL_S
 * (default 300). Bypass with query ?fresh=1 (handled in the router).
 */

const DEFAULT_TTL_S = 300;

interface Entry<T> {
	value: T;
	expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

function ttlMs(): number {
	const s = Number.parseInt(process.env.EXERCITATOR_API_CACHE_TTL_S ?? "", 10);
	return (Number.isFinite(s) && s > 0 ? s : DEFAULT_TTL_S) * 1000;
}

function cacheKey(userId: string, key: string): string {
	return `${userId}::${key}`;
}

export function cacheGet<T>(userId: string, key: string): T | null {
	const hit = store.get(cacheKey(userId, key));
	if (!hit) return null;
	if (hit.expiresAt < Date.now()) {
		store.delete(cacheKey(userId, key));
		return null;
	}
	return hit.value as T;
}

export function cacheSet<T>(userId: string, key: string, value: T): void {
	store.set(cacheKey(userId, key), { value, expiresAt: Date.now() + ttlMs() });
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
