/**
 * OAuth middleware for MCP server — TypeScript port of internuntius shared/mcp_oauth.py.
 *
 * Implements:
 * - RFC 9728 (protected resource metadata)
 * - RFC 8414 (authorization server metadata)
 * - RFC 7591 (dynamic client registration)
 * - PKCE S256 + client_credentials grant types
 * - Passphrase-gated authorisation
 * - Signed tokens with version-based revocation
 *
 * All tokens are self-validating (HMAC-SHA256 signature + embedded expiry).
 * No server-side token storage required.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID ?? "exercitator";
const CLIENT_SECRET = process.env.MCP_OAUTH_CLIENT_SECRET ?? "";
const PASSPHRASE = process.env.MCP_OAUTH_AUTHORIZE_PASSPHRASE ?? "";
const TOKEN_VERSION = Number.parseInt(process.env.MCP_TOKEN_VERSION ?? "1", 10);
const TOKEN_TTL_SECS = 72 * 3600; // 72 hours

// Redirect URIs that are permitted during the authorisation code flow.
// claude.ai callback is required for Claude Desktop / claude.ai connectors.
// localhost is allowed for local development / Claude Code.
const ALLOWED_REDIRECT_URIS = new Set([
	"https://claude.ai/api/mcp/auth_callback",
	"http://localhost",
	"http://127.0.0.1",
]);

function isRedirectAllowed(uri: string): boolean {
	// Exact match first (claude.ai callback)
	if (ALLOWED_REDIRECT_URIS.has(uri)) return true;
	// Prefix match for localhost with any port/path
	try {
		const parsed = new URL(uri);
		const origin = `${parsed.protocol}//${parsed.hostname}`;
		return origin === "http://localhost" || origin === "http://127.0.0.1";
	} catch {
		return false;
	}
}

export function authEnabled(): boolean {
	return CLIENT_SECRET !== "" && PASSPHRASE !== "";
}

// ---------------------------------------------------------------------------
// Token signing
// ---------------------------------------------------------------------------

function signingKey(): Buffer {
	return Buffer.from(CLIENT_SECRET, "utf-8");
}

function signToken(payload: Record<string, unknown>): string {
	const data = JSON.stringify(payload);
	const b64 = Buffer.from(data).toString("base64url");
	const sig = createHmac("sha256", signingKey()).update(b64).digest("base64url");
	return `${b64}.${sig}`;
}

function verifyToken(token: string): Record<string, unknown> | null {
	const [b64, sig] = token.split(".");
	if (!b64 || !sig) return null;

	const expected = createHmac("sha256", signingKey()).update(b64).digest("base64url");
	if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

	try {
		const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf-8"));
		if (payload.ver !== TOKEN_VERSION) return null;
		if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) return null;
		return payload;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function sha256Base64Url(value: string): string {
	return createHmac("sha256", Buffer.alloc(0)).update(value).digest("base64url");
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

const lockoutBuckets = new Map<string, { count: number; lockoutUntil: number }>();
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	const bucket = rateBuckets.get(ip);
	if (!bucket || now > bucket.resetAt) {
		rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
		return false;
	}
	bucket.count++;
	return bucket.count > RATE_LIMIT;
}

function isLockedOut(ip: string): boolean {
	const bucket = lockoutBuckets.get(ip);
	return bucket ? Date.now() < bucket.lockoutUntil : false;
}

function recordFailure(ip: string): void {
	const bucket = lockoutBuckets.get(ip) ?? { count: 0, lockoutUntil: 0 };
	bucket.count++;
	if (bucket.count >= MAX_FAILURES) {
		bucket.lockoutUntil = Date.now() + LOCKOUT_MS;
		bucket.count = 0;
	}
	lockoutBuckets.set(ip, bucket);
}

function clearFailures(ip: string): void {
	lockoutBuckets.delete(ip);
}

// ---------------------------------------------------------------------------
// Pending authorisation codes
// ---------------------------------------------------------------------------

interface PendingCode {
	code: string;
	codeChallenge: string;
	redirectUri: string;
	expiresAt: number;
}

const pendingCodes = new Map<string, PendingCode>();

function pruneExpiredCodes(): void {
	const now = Date.now();
	for (const [k, v] of pendingCodes) {
		if (now > v.expiresAt) pendingCodes.delete(k);
	}
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(payload);
}

function html(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	res.end(body);
}

const MAX_BODY_SIZE = 64 * 1024; // 64 KiB

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		size += buffer.length;
		if (size > MAX_BODY_SIZE) {
			req.socket.destroy();
			throw new Error("Request body too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function clientIp(req: IncomingMessage): string {
	return (
		(req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
		req.socket.remoteAddress ??
		"unknown"
	);
}

// ---------------------------------------------------------------------------
// Authorise form HTML
// ---------------------------------------------------------------------------

function authoriseFormHtml(params: URLSearchParams, error?: string): string {
	const qs = params.toString();
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Exercitator — Authorise</title>
<style>body{font-family:system-ui;max-width:400px;margin:4rem auto;padding:1rem}
input[type=password]{width:100%;padding:.5rem;margin:.5rem 0}button{padding:.5rem 1rem}
.error{color:#c00;font-weight:bold}</style></head>
<body><h1>Exercitator</h1><p>Enter your passphrase to authorise this client.</p>
${error ? `<p class="error">${error}</p>` : ""}
<form method="POST" action="/oauth/authorize?${qs}">
<input type="password" name="passphrase" required autofocus>
<button type="submit">Authorise</button></form></body></html>`;
}

// ---------------------------------------------------------------------------
// OAuth handler
// ---------------------------------------------------------------------------

export function createOAuthHandler(serverUrl: string) {
	return function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
		const path = url.pathname;
		const ip = clientIp(req);

		// ---- Well-known metadata ----

		if (path === "/.well-known/oauth-protected-resource" && req.method === "GET") {
			json(res, 200, {
				resource: serverUrl,
				authorization_servers: [serverUrl],
				bearer_methods_supported: ["header"],
			});
			return true;
		}

		if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
			json(res, 200, {
				issuer: serverUrl,
				authorization_endpoint: `${serverUrl}/oauth/authorize`,
				token_endpoint: `${serverUrl}/oauth/token`,
				registration_endpoint: `${serverUrl}/oauth/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["client_secret_post"],
			});
			return true;
		}

		// ---- Dynamic registration ----
		// Claude Desktop may hit /register or /oauth/register

		if ((path === "/oauth/register" || path === "/register") && req.method === "POST") {
			json(res, 200, {
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				redirect_uris: [...ALLOWED_REDIRECT_URIS],
				grant_types: ["authorization_code", "client_credentials", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "client_secret_post",
			});
			return true;
		}

		// ---- Authorisation endpoint ----
		// Claude Desktop may hit /authorize or /oauth/authorize

		if (path === "/oauth/authorize" || path === "/authorize") {
			if (isRateLimited(ip)) {
				json(res, 429, { error: "rate_limited" });
				return true;
			}

			if (req.method === "GET") {
				html(res, 200, authoriseFormHtml(url.searchParams));
				return true;
			}

			if (req.method === "POST") {
				if (isLockedOut(ip)) {
					html(
						res,
						403,
						authoriseFormHtml(url.searchParams, "Too many failed attempts. Try again later."),
					);
					return true;
				}

				readBody(req).then((body) => {
					const form = new URLSearchParams(body);
					const entered = form.get("passphrase") ?? "";

					if (entered !== PASSPHRASE) {
						recordFailure(ip);
						html(res, 403, authoriseFormHtml(url.searchParams, "Incorrect passphrase."));
						return;
					}

					clearFailures(ip);
					pruneExpiredCodes();

					const redirectUri = url.searchParams.get("redirect_uri") ?? "";
					if (!isRedirectAllowed(redirectUri)) {
						json(res, 400, {
							error: "invalid_request",
							error_description: "Invalid redirect_uri",
						});
						return;
					}

					const code = randomBytes(32).toString("hex");
					const codeChallenge = url.searchParams.get("code_challenge") ?? "";
					const state = url.searchParams.get("state") ?? "";

					pendingCodes.set(code, {
						code,
						codeChallenge,
						redirectUri,
						expiresAt: Date.now() + 5 * 60_000,
					});

					const redirect = new URL(redirectUri);
					redirect.searchParams.set("code", code);
					if (state) redirect.searchParams.set("state", state);

					res.writeHead(302, { Location: redirect.toString() });
					res.end();
				});
				return true;
			}
		}

		// ---- Token endpoint ----
		// Claude Desktop may hit /token or /oauth/token

		if ((path === "/oauth/token" || path === "/token") && req.method === "POST") {
			if (isRateLimited(ip)) {
				json(res, 429, { error: "rate_limited" });
				return true;
			}

			readBody(req).then((body) => {
				const form = new URLSearchParams(body);
				const grantType = form.get("grant_type");

				if (grantType === "client_credentials") {
					if (form.get("client_secret") !== CLIENT_SECRET) {
						json(res, 401, { error: "invalid_client" });
						return;
					}
					const token = signToken({
						sub: CLIENT_ID,
						ver: TOKEN_VERSION,
						exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECS,
					});
					json(res, 200, {
						access_token: token,
						token_type: "Bearer",
						expires_in: TOKEN_TTL_SECS,
					});
					return;
				}

				if (grantType === "authorization_code") {
					const code = form.get("code") ?? "";
					const pending = pendingCodes.get(code);
					if (!pending || Date.now() > pending.expiresAt) {
						json(res, 400, { error: "invalid_grant" });
						return;
					}
					pendingCodes.delete(code);

					const verifier = form.get("code_verifier") ?? "";
					if (pending.codeChallenge && sha256Base64Url(verifier) !== pending.codeChallenge) {
						json(res, 400, {
							error: "invalid_grant",
							error_description: "PKCE verification failed",
						});
						return;
					}

					const accessToken = signToken({
						sub: CLIENT_ID,
						ver: TOKEN_VERSION,
						exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECS,
					});
					const refreshToken = signToken({
						sub: CLIENT_ID,
						ver: TOKEN_VERSION,
						type: "refresh",
						exp: Math.floor(Date.now() / 1000) + 30 * 86400,
					});

					json(res, 200, {
						access_token: accessToken,
						token_type: "Bearer",
						expires_in: TOKEN_TTL_SECS,
						refresh_token: refreshToken,
					});
					return;
				}

				if (grantType === "refresh_token") {
					const rt = form.get("refresh_token") ?? "";
					const payload = verifyToken(rt);
					if (!payload || payload.type !== "refresh") {
						json(res, 400, { error: "invalid_grant" });
						return;
					}

					const accessToken = signToken({
						sub: CLIENT_ID,
						ver: TOKEN_VERSION,
						exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECS,
					});
					json(res, 200, {
						access_token: accessToken,
						token_type: "Bearer",
						expires_in: TOKEN_TTL_SECS,
					});
					return;
				}

				json(res, 400, { error: "unsupported_grant_type" });
			});
			return true;
		}

		return false;
	};
}

// ---------------------------------------------------------------------------
// Bearer token validation middleware
// ---------------------------------------------------------------------------

export function validateBearer(req: IncomingMessage): boolean {
	const auth = req.headers.authorization ?? "";
	if (!auth.startsWith("Bearer ")) return false;
	const token = auth.slice(7);
	return verifyToken(token) !== null;
}
