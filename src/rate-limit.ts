/**
 * In-memory token-bucket rate limiter shared by Praescriptor and the HTTP API.
 *
 * Buckets are keyed by an opaque string supplied by the caller (typically
 * `userId` once authenticated, or `ip:remote-address` for the unauthenticated
 * surface). Each scope (`read` / `write`) has its own bucket per key — a
 * burst of read-only `/status` calls does not deplete the budget for
 * `POST /api/send/run`.
 *
 * Defaults:
 *   - read:  60 requests / minute (EXERCITATOR_RATE_LIMIT_READ)
 *   - write: 10 requests / minute (EXERCITATOR_RATE_LIMIT_WRITE)
 *
 * Disable a scope by setting the env var to `0`. Tests exploit this to
 * avoid quotas tripping inside long-running scenarios.
 *
 * Buckets idle for >5 minutes are evicted by a periodic prune (started
 * with `startRateLimitPrune`).
 */

export type RateScope = "read" | "write";

interface Bucket {
	tokens: number;
	lastRefillMs: number;
}

interface ScopeConfig {
	capacity: number;
	refillPerMs: number; // tokens per millisecond
}

const buckets = new Map<string, Bucket>();
const PRUNE_INTERVAL_MS = 60_000;
const IDLE_EVICT_MS = 5 * 60_000;

function readPerMinute(scope: RateScope): number {
	const raw =
		scope === "read"
			? process.env.EXERCITATOR_RATE_LIMIT_READ
			: process.env.EXERCITATOR_RATE_LIMIT_WRITE;
	if (raw === undefined) return scope === "read" ? 60 : 10;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : scope === "read" ? 60 : 10;
}

function scopeConfig(scope: RateScope): ScopeConfig | null {
	const perMinute = readPerMinute(scope);
	if (perMinute === 0) return null; // disabled
	return {
		capacity: perMinute,
		refillPerMs: perMinute / 60_000,
	};
}

export interface RateCheck {
	allowed: boolean;
	/** Whole seconds until the next token is available (≥1 when not allowed). */
	retryAfterS: number;
	/** Tokens remaining after this call (0 when refused). */
	remaining: number;
	/** Bucket capacity (per-minute limit). 0 means the scope is disabled. */
	limit: number;
}

function bucketKey(scope: RateScope, key: string): string {
	return `${scope}::${key}`;
}

/**
 * Check (and decrement) the bucket for (scope, key). When the scope is
 * configured with `0` requests/minute the limiter is disabled and every
 * call returns `allowed: true` with `limit: 0`.
 */
export function checkRate(scope: RateScope, key: string): RateCheck {
	const cfg = scopeConfig(scope);
	if (!cfg) return { allowed: true, retryAfterS: 0, remaining: 0, limit: 0 };

	const k = bucketKey(scope, key);
	const now = Date.now();
	let bucket = buckets.get(k);
	if (!bucket) {
		bucket = { tokens: cfg.capacity, lastRefillMs: now };
		buckets.set(k, bucket);
	}

	const elapsed = now - bucket.lastRefillMs;
	if (elapsed > 0) {
		bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsed * cfg.refillPerMs);
		bucket.lastRefillMs = now;
	}

	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return {
			allowed: true,
			retryAfterS: 0,
			remaining: Math.floor(bucket.tokens),
			limit: cfg.capacity,
		};
	}

	const tokensNeeded = 1 - bucket.tokens;
	const retryMs = tokensNeeded / cfg.refillPerMs;
	return {
		allowed: false,
		retryAfterS: Math.max(1, Math.ceil(retryMs / 1000)),
		remaining: 0,
		limit: cfg.capacity,
	};
}

export function pruneIdleBuckets(now: number = Date.now()): number {
	let removed = 0;
	for (const [k, b] of buckets) {
		if (now - b.lastRefillMs > IDLE_EVICT_MS) {
			buckets.delete(k);
			removed++;
		}
	}
	return removed;
}

let pruneTimer: NodeJS.Timeout | null = null;

export function startRateLimitPrune(): NodeJS.Timeout {
	if (pruneTimer) return pruneTimer;
	pruneTimer = setInterval(() => pruneIdleBuckets(), PRUNE_INTERVAL_MS);
	pruneTimer.unref();
	return pruneTimer;
}

export function stopRateLimitPrune(): void {
	if (pruneTimer) {
		clearInterval(pruneTimer);
		pruneTimer = null;
	}
}

/** Test-only helper. */
export function _resetRateLimits(): void {
	buckets.clear();
}
