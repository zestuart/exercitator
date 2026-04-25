/**
 * Bearer-token auth for the HTTP API.
 *
 * Keys are configured via EXERCITATOR_API_KEYS (comma-separated) or
 * EXERCITATOR_API_KEYS_FILE (Docker secret). Each key has the format
 * `<client>:<userId>:<token>` so bearer keys are scoped to a specific
 * user — middleware asserts the userId in the path matches the bearer's.
 *
 * See phase2/exercitator-http-api-spec.md §2.
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { apiError } from "./errors.js";

export interface ApiKey {
	client: string;
	userId: string;
	token: string;
	tokenBuf: Buffer;
}

/**
 * Parse a comma-separated `<client>:<userId>:<token>` list.
 * Whitespace around entries is tolerated.
 */
export function parseApiKeys(raw: string | undefined): ApiKey[] {
	if (!raw) return [];
	const keys: ApiKey[] = [];
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(":");
		if (parts.length < 3) continue;
		const client = parts[0];
		const userId = parts[1];
		const token = parts.slice(2).join(":");
		if (!client || !userId || !token) continue;
		keys.push({ client, userId, token, tokenBuf: Buffer.from(token) });
	}
	return keys;
}

/** Load keys from env. EXERCITATOR_API_KEYS_FILE takes precedence. */
export function loadApiKeys(): ApiKey[] {
	const filePath = process.env.EXERCITATOR_API_KEYS_FILE;
	if (filePath) {
		try {
			const raw = readFileSync(filePath, "utf-8");
			return parseApiKeys(raw);
		} catch (err) {
			console.error(`EXERCITATOR_API_KEYS_FILE read failed (${filePath}):`, err);
			return [];
		}
	}
	return parseApiKeys(process.env.EXERCITATOR_API_KEYS);
}

function extractBearer(req: IncomingMessage): string | null {
	const h = req.headers.authorization;
	if (!h) return null;
	const m = h.match(/^Bearer\s+(.+)$/i);
	return m ? m[1].trim() : null;
}

/**
 * Match a presented bearer against the configured key list in constant time.
 * Returns the matching ApiKey or null.
 *
 * We compare each entry individually with timingSafeEqual on equal-length
 * buffers; length mismatches don't leak because we still do a fake compare.
 */
function matchBearer(presented: string, keys: ApiKey[]): ApiKey | null {
	const presentedBuf = Buffer.from(presented);
	// Presented format must be `<client>:<userId>:<token>`
	const parts = presented.split(":");
	if (parts.length < 3) {
		for (const k of keys) {
			const equalLen = Buffer.alloc(k.tokenBuf.length);
			timingSafeEqual(equalLen, k.tokenBuf.length > 0 ? k.tokenBuf : equalLen);
		}
		return null;
	}
	const pClient = parts[0];
	const pUserId = parts[1];
	const pToken = parts.slice(2).join(":");
	const pTokenBuf = Buffer.from(pToken);

	let matched: ApiKey | null = null;
	for (const k of keys) {
		const sameLen = k.tokenBuf.length === pTokenBuf.length;
		const compareBuf = sameLen ? pTokenBuf : Buffer.alloc(k.tokenBuf.length);
		const tokenEq = timingSafeEqual(k.tokenBuf, compareBuf);
		// client + userId are not secret; direct equality is fine.
		if (sameLen && tokenEq && k.client === pClient && k.userId === pUserId) {
			matched = k;
		}
	}
	// Consume presentedBuf so the variable is used even when unmatched
	void presentedBuf;
	return matched;
}

export interface AuthContext {
	keys: ApiKey[];
}

/**
 * Validate the bearer and assert the bound userId matches the path userId.
 * Returns the matched key on success, or null after writing the appropriate
 * error response (401 / 403).
 */
export function requireBearer(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthContext,
	pathUserId: string | null,
): ApiKey | null {
	const presented = extractBearer(req);
	if (!presented) {
		apiError(res, 401, "missing bearer token");
		return null;
	}
	const matched = matchBearer(presented, auth.keys);
	if (!matched) {
		apiError(res, 401, "invalid bearer token");
		return null;
	}
	if (pathUserId !== null && matched.userId !== pathUserId) {
		apiError(res, 403, "bearer not authorised for this user");
		return null;
	}
	return matched;
}
