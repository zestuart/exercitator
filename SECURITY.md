# Security

## Known surfaces

- **intervals.icu API key**: Stored in `.env`, used server-side only. Leaking it grants read/write access to the user's training data.
- **Tailscale funnel exposure**: The MCP server is publicly reachable via the funnel. All endpoints must validate requests.
- **SQLite injection**: All user-supplied parameters must be parameterised in SQL queries.
- **MCP tool input validation**: All tool parameters from Claude must be validated before forwarding to intervals.icu. Date parameters enforce `YYYY-MM-DD` regex.
- **Docker secrets**: Container environment variables must not be logged or exposed via health/debug endpoints.
- **OAuth redirect URI**: Validated against explicit allowlist (`https://claude.ai/api/mcp/auth_callback`, `http://localhost`, `http://127.0.0.1`). Do not add arbitrary URIs.
- **Session exhaustion**: HTTP sessions capped at 100 with 5-minute idle timeout.
- **Request body size**: OAuth endpoints limit request bodies to 64 KiB.

## Outstanding

_No outstanding findings._

## Remediated

### 2026-03-23 — SAST scan (Gemini 2.5 Pro, full mode)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | Critical | Open redirect in OAuth `/oauth/authorize` — `redirect_uri` not validated | Validate against localhost allowlist (`src/auth.ts`) |
| 2 | High | Global auth lockout DoS — single counter locks all users after 5 failures | Per-IP failure tracking and lockout (`src/auth.ts`) |
| 3 | Medium | Unbounded request body on OAuth endpoints | 64 KiB limit in `readBody()` (`src/auth.ts`) |
| 4 | Medium | Path traversal via `date` parameter in `update_wellness` | YYYY-MM-DD regex + `encodeURIComponent` (`src/tools/wellness.ts`, `src/tools/events.ts`) |
| 5 | Medium | Unbounded in-memory session storage | Max 100 sessions + 5-min idle timeout with periodic pruning (`src/index.ts`) |

### 2026-03-23 — Production connector testing

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 6 | High | PKCE S256 used HMAC-SHA256 (empty key) instead of SHA-256 — every verification failed | Replaced `createHmac` with `createHash("sha256")` (`src/auth.ts`) |
| 7 | Medium | Redirect URI allowlist missing `https://claude.ai/api/mcp/auth_callback` | Added to allowlist (`src/auth.ts`) |
