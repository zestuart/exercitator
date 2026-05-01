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
- **HTTP API bearer tokens**: `EXERCITATOR_API_KEYS` holds `<client>:<userId>:<token>` triples. **All three components** compared in constant time — every configured key receives the same comparison work regardless of bearer shape, so timing can't reveal whether a `(client, userId)` pair is configured. Each key is scoped to one userId; cross-user reads return 403 before user existence is disclosed. Listener auto-disables when the env var is unset.
- **HTTP API exposure**: Tailnet-only via the `exercitator-api` Tailscale sidecar (no funnel). Tailscale membership is the outer access gate; bearer scoping is the inner one. The MCP funnel and HTTP API are independent — a leak of one bearer doesn't grant the other.
- **HTTP API body size**: 1 KiB per POST (cross-training RPE), 1 MiB global cap on the listener.
- **HTTP API response cache**: Per-user buckets (`Map<userId, Map<key, Entry>>`) capped at `EXERCITATOR_API_CACHE_MAX_ENTRIES` (default 64) with LRU eviction; 60s background prune sweeps expired entries. One user can't evict another's entries.
- **Rate limiting (Praescriptor + HTTP API)**: Per-user token-bucket — 60 reads/min, 10 writes/min by default; configurable via `EXERCITATOR_RATE_LIMIT_READ` / `_WRITE` (`0` disables). Returns 429 with `Retry-After` envelope. Read and write buckets independent.
- **Activity-ID allowlist**: User-supplied activity IDs (`POST /api/compliance/confirm`, `POST /api/users/:userId/cross-training/:activityId/rpe`, `GET /api/users/:userId/workouts/iv-:id`) match `^[A-Za-z0-9_-]{1,64}$` before path-interpolation. Defence-in-depth alongside `encodeURIComponent`.
- **Timezone validation**: `tz` cookies and query params validated via `Intl.DateTimeFormat` before reaching `localDateStr` or any cache key. Closes both cache-flooding (crafted unique IANA names) and DoS-via-RangeError (malformed cookie reaching `localDateStr`).
- **Cache-key allowlist**: `/workouts/suggested` cache key allowlists `sport` to `{auto, Run, Swim}` and includes the validated `tz` so two clients on different sides of the date line don't share stale "today" suggestions.
- **Compliance lookback clamp**: `?days=` on `POST /api/compliance/backfill` and `GET /api/compliance/trending` clamped to `[1, 730]`. Prevents quota exhaustion against the intervals.icu upstream.
- **Praescriptor security headers**: Every response carries HSTS (`max-age=63072000; includeSubDomains`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`. HTML responses additionally carry CSP allowing inline styles/scripts and Google Fonts only, with `frame-ancestors 'none'`.
- **Stryd credentials**: Optional `STRYD_*` (and `STRYD_*_PAM`) in `.env`, used server-side only for FIT enrichment, Vigil baselines, and direct CP fetch. Tokens are short-lived, held only in memory during enrichment. Never exposed via HTTP API, MCP, or web UI.
- **Praescriptor access**: Tailnet-only via `tailscale serve` (no funnel). No app-level auth — Tailscale provides device-level access control.

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

### 2026-04-29 — SAST cleanup (round 1)

Tagged baseline `sast-baseline-2026-04-29` on the deploy commit; remediated previously deferred findings plus one new High flagged by the diff scan.

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 8 | Medium | Path traversal via user-supplied `activityId` in `/api/compliance/confirm` and `submit_cross_training_rpe` | `encodeURIComponent` on path interpolation (`src/web/routes.ts`, `src/tools/suggest.ts`) |
| 9 | High | HTTP API response cache unbounded — authenticated tailnet user could exhaust container memory | LRU cap (`EXERCITATOR_API_CACHE_MAX_ENTRIES` default 1000 → later refined to per-user 64) + 60s prune of expired entries (`src/api/cache.ts`, `src/api/server.ts`) |
| 10 | Medium | `matchBearer` short-circuits on `(client, userId)` mismatch — leaks via timing whether a `(client, userId)` pair is configured | All three byte comparisons (client/userId/token) run unconditionally per key, aggregated with bitwise AND; malformed bearers go through a dummy compare so total work is flat (`src/api/auth.ts`) |
| 11 | Medium | No rate limiting on Praescriptor or HTTP API beyond OAuth + 30s `/api/refresh` cooldown | New shared in-memory token-bucket module (`src/rate-limit.ts`); 60 reads/min + 10 writes/min per user; 429 + `Retry-After` envelope; configurable env vars |
| 12 | Low | Truncated Tailscale auth-key prefix in `CLAUDE.md` violated "no secrets in docs" rule | Replaced with pointer to `praefectura/docs/tailscale.md` |
| 13 | Low | Praescriptor HTML responses missing CSP / HSTS / `X-Content-Type-Options` / `X-Frame-Options` | `src/web/security-headers.ts` (`applyBaseSecurityHeaders` + `applyHtmlSecurityHeaders`); applied to every Praescriptor response |
| 14 | Medium | `?sport=` query parameter on `/workouts/suggested` flowed unvalidated into the response cache key — could pollute cache with crafted long values | Allowlist to `{auto, Run, Swim}` (`src/api/handlers/workouts.ts`) |

### 2026-04-29 — SAST cleanup (round 2)

A post-deploy SAST diff surfaced two more findings rooted in pre-existing weak validation. Tagged `sast-baseline-2026-04-29-b`.

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 15 | Medium | Cache flooding via crafted `tz` query — after `tz` joined the cache key, hundreds of valid IANA timezones could fill the cache | Strict IANA validation via `Intl.DateTimeFormat` (`src/engine/date-utils.ts` `isValidTimezone`) consumed by both surfaces |
| 16 | Low | DoS via crafted `tz` cookie reaching `localDateStr` and throwing `RangeError` 500 | Same validator applied to the Praescriptor cookie path |
| 17 | High | Three SSRF false-positives flagged by SAST (encodeURIComponent already neutralised them, but defence-in-depth was warranted) | Activity-ID allowlist `^[A-Za-z0-9_-]{1,64}$` at the request boundary (`src/api/validate.ts`) — applied to compliance-confirm, cross-training/rpe, workout-detail handlers |
| 18 | Medium | Per-user cache cap was global — one user could evict another's entries by cycling unique cache keys | Refactored to two-level `Map<userId, Map<key, Entry>>` with per-user 64-entry cap (`src/api/cache.ts`) |
| 19 | Medium | `?days=` on compliance backfill / trending unbounded — backfill issues one upstream call per day with a send event | Clamp to `[1, 730]` (`src/web/routes.ts`) |

Tagged final clean state at `sast-baseline-2026-04-29-c` on commit `25db117`.
