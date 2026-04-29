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
	clientBuf: Buffer;
	userIdBuf: Buffer;
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
		keys.push({
			client,
			userId,
			token,
			tokenBuf: Buffer.from(token),
			clientBuf: Buffer.from(client),
			userIdBuf: Buffer.from(userId),
		});
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
 * Constant-time comparison of two byte buffers of arbitrary length.
 *
 * Returns 1 if equal, 0 otherwise. Always traverses the longer buffer so
 * timing does not leak which buffer was shorter or where the first
 * differing byte sat. We do not short-circuit on a length mismatch.
 */
function constantTimeBytesEqual(a: Buffer, b: Buffer): 0 | 1 {
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		const av = i < a.length ? a[i] : 0;
		const bv = i < b.length ? b[i] : 0;
		diff |= av ^ bv;
	}
	return diff === 0 ? 1 : 0;
}

/**
 * Match a presented bearer against the configured key list in constant time.
 * Returns the matching ApiKey or null.
 *
 * Every configured key receives the same comparison work — three
 * `constantTimeBytesEqual` calls (client, userId, token) aggregated with a
 * bitwise AND. We do not short-circuit on a malformed bearer either: a
 * dummy compare against every key keeps total work flat regardless of
 * input shape, so a remote caller can't time the difference between
 * "(client, userId) matches but token is wrong" vs. "no key with this
 * (client, userId) is configured".
 *
 * The token compare itself uses `timingSafeEqual` on a same-length buffer
 * for a defence-in-depth against compiler optimisation of the manual loop.
 */
function matchBearer(presented: string, keys: ApiKey[]): ApiKey | null {
	const parts = presented.split(":");
	const malformed = parts.length < 3;
	const pClient = malformed ? "" : parts[0];
	const pUserId = malformed ? "" : parts[1];
	const pToken = malformed ? "" : parts.slice(2).join(":");
	const pClientBuf = Buffer.from(pClient);
	const pUserIdBuf = Buffer.from(pUserId);
	const pTokenBuf = Buffer.from(pToken);

	let matched: ApiKey | null = null;

	for (const k of keys) {
		const clientEq = constantTimeBytesEqual(k.clientBuf, pClientBuf);
		const userIdEq = constantTimeBytesEqual(k.userIdBuf, pUserIdBuf);

		// Use timingSafeEqual on a same-length buffer for the token compare.
		// We pad the presented token to the configured token length when they
		// differ so timingSafeEqual doesn't throw, and we still factor the
		// real-vs-padded comparison through `tokenEq`.
		const tokenSameLen = k.tokenBuf.length === pTokenBuf.length ? 1 : 0;
		const tokenCompareBuf = tokenSameLen === 1 ? pTokenBuf : Buffer.alloc(k.tokenBuf.length);
		const tokenSafeEq = timingSafeEqual(k.tokenBuf, tokenCompareBuf) ? 1 : 0;
		const tokenEq = tokenSameLen & tokenSafeEq;

		const allEq = clientEq & userIdEq & tokenEq;

		// Conditionally assign without short-circuiting the rest of the loop.
		// `matched` flips only when the bitwise AND is 1 AND the bearer was
		// well-formed. Malformed bearers never produce a match because every
		// `constantTimeBytesEqual` call against an empty buffer returns 0.
		if (allEq === 1 && !malformed) {
			matched = k;
		}
	}

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
