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
- **Promus health-telemetry client** (`src/promus/client.ts`): GET-only bearer client reading overnight WHOOP sleep + nightly HRV from the in-house Promus service for `healthSource: "promus-whoop"` users. Auth via `PROMUS_API` (reused from the DSW emitter); base URL `PROMUS_URL` (default tailnet host). Strap serial from `WHOOP_SERIAL`, `encodeURIComponent`-escaped into the path. Responses size-capped at 512 KiB before `JSON.parse`; request timeout 15 s. No secret is logged. Failures hard-fail the suggestion to `health_unavailable` rather than degrade silently (`src/engine/suggest.ts:fetchHealthTelemetry`).
- **Praescriptor access**: Tailnet-only via `tailscale serve` (no funnel). No app-level auth — Tailscale provides device-level access control.
- **Shared `tz` resolver**: All HTTP API handlers consume `?tz` via `src/api/tz.ts:resolveTz`, which validates against `Intl.DateTimeFormat` before any downstream use. A future handler that forgets to validate is impossible by construction (the helper is the only sanctioned path).
- **MCP path-traversal allowlist**: The `submit_cross_training_rpe` tool now applies the same `^[A-Za-z0-9_-]{1,64}$` allowlist to `activityId` as the HTTP API equivalent (via Zod regex). Belt-and-braces with `encodeURIComponent` against SSRF.

## Outstanding

### 2026-06-03 — Accepted risk: TOCTOU race in workout send paths (Medium)

**Finding** (SAST diff, Gemini 2.5 Pro): `sendToStryd` (`src/web/send-stryd.ts`) and `sendToIntervals` (`src/web/send.ts`) check `getSendEvent` for an existing same-day send, then make awaited external API calls (`createWorkout`/`scheduleWorkout` or the intervals `POST`), then call `persistSendEvent`. The check→persist window spans network I/O, so two concurrent requests for the same `(user, date, sport, target)` can both pass the check and create duplicate calendar entries, bypassing the one-per-day dedup. Pre-existing; surfaced when the 2026-06-03 timezone/status-guard fix touched both files.

**Status**: Accepted-risk, 2026-06-03. Rationale:
- Both surfaces are OAuth-gated (streamable-http) / bearer-scoped (HTTP API); the only callers are the two solo athletes (ze, pam) acting on their own data — no untrusted attacker.
- Praescriptor is tailnet-only; device-level Tailscale access control is the outer gate.
- The realistic trigger is the single authenticated user double-clicking; the impact is a user-deletable duplicate entry. The dedup is a UX convenience, not a security control.

**Follow-up**: add a `UNIQUE(user_id, date, sport, target)` constraint to `send_events` (`src/db.ts`) and refactor both paths to INSERT-first (claim the slot atomically before the external call; on constraint violation return the existing 409 duplicate response; update the row with `external_id`/meta after success). An in-process lock is insufficient — `send-stryd`/`send` run in two separate containers (`exercitator-mcp`, `praescriptor-web`) sharing one SQLite volume, so the DB constraint is the load-bearing fix. Tracked in [GitHub issue #36](https://github.com/zestuart/exercitator/issues/36).

### 2026-06-03 — Accepted risk: no range validation on `update_wellness` scaled fields (Medium)

**Finding** (SAST diff, Gemini 2.5 Pro): the `update_wellness` MCP tool (`src/tools/wellness.ts`) types its scaled subjective fields as `z.number().optional()` with no bounds — `sleepQuality`, `mood`, `soreness`, `fatigue`, `stress` (intervals.icu 1–4 dropdowns) and `readiness` (0–100). An out-of-range value (e.g. `soreness: 9000`) is accepted and forwarded verbatim to the upstream `intervals.icu` wellness PUT, where it could corrupt the daily record or drive unexpected behaviour in consumers that lack defensive clamping. Surfaced when the 2026-06-03 field-scale corrections made the intended ranges explicit in the descriptions.

**Status**: Accepted-risk, 2026-06-03. Rationale:
- The tool is OAuth-authenticated (streamable-http); the only callers are the two solo athletes (ze, pam) writing their own records — no untrusted input path.
- `computeReadiness` (`src/engine/readiness.ts`) clamps soreness/fatigue to `[0,100]` after the 1–4 inversion, so a junk value cannot distort the in-house readiness score; `stress`/`mood`/`sleepQuality`/`readiness` are not consumed by the engine at all.
- intervals.icu performs its own server-side validation on the wellness PUT.
- Exercitator's MCP surface, while funnel-public, gates writes behind the OAuth passphrase.

**Follow-up**: add `.int()` + range validation that preserves the documented `-1` clear-sentinel (allowed set `{-1} ∪ valid-range` per field, e.g. `.refine(v => v === -1 || (v >= 1 && v <= 4))`). A naive `.min(1).max(4)` must NOT be used — it would reject `-1` and silently break field-clearing (`wellness.ts:30`). Tracked for a future hardening pass.

### 2026-06-02 — Accepted risk: `prompt()` in compliance activity picker (Low)

**Finding** (SAST diff, Gemini 2.5 Pro): the multi-activity branch of the compliance confirm flow in `src/web/render.ts` (`clientJs`, `.confirm-btn` handler) seeds a `window.prompt()` with intervals.icu-sourced activity names and submits the typed value as `activityId`. A crafted activity name could social-engineer a user into typing sensitive data, which would then transit to `/api/compliance/confirm`.

**Status**: Accepted-risk, 2026-06-02. Rationale:
- Narrow threat model — requires write access to the athlete's intervals.icu calendar; both users (ze, pam) are solo athletes whose calendars are author-controlled.
- Backend allowlist `^[A-Za-z0-9_-]{1,64}$` (`src/api/validate.ts:isValidIntervalsId`) rejects any non-id value before path-interpolation; the typed payload never reaches the upstream.
- Existing `replace(/[\r\n]/g, " ")` strip already neutralises newline injection into the dialog.
- Praescriptor is tailnet-only (no funnel); device-level Tailscale access control is the outer gate.

**Follow-up**: replace the `prompt()` with a DOM picker (`<select>` / clickable list) — tracked in [GitHub issue #35](https://github.com/zestuart/exercitator/issues/35). When that lands, this entry moves to Remediated.

## Remediated

### 2026-06-03 — Promus WHOOP health-source arc (clean, 3 deploys)

Sleep + HRV readiness telemetry moved from intervals.icu wellness to the in-house Promus WHOOP strap feed for ze (`healthSource: "promus-whoop"`), with a `health_unavailable` hard-fail when today's WHOOP night is missing or Promus is unreachable; followed by two follow-ups (HTTP API readiness DTO + tz consistency, then making readiness whole-athlete on every surface). New external surface is a single GET-only bearer client (`src/promus/client.ts`) reading two WHOOP endpoints — serial `encodeURIComponent`-escaped, 512 KiB JSON cap, 15 s timeout, no secret logged. Three sequential diff-mode SAST scans each returned `NO_FINDINGS`. Tagged `sast-baseline-2026-06-03` (`ef4f038`), `-b` (`6219369`), `-c` (`2613600`). New env `WHOOP_SERIAL` forwarded to both Docker services (auth reuses `PROMUS_API`). See `lessons.md` 2026-06-03 (two entries) and `notes/excubitor/api-0.2.2.md`.

### 2026-06-02 — Inlined-script XSS hardening (Medium)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 22 | Medium | XSS via unescaped `userId` interpolated into the inlined Praescriptor client JS (`src/web/render.ts:clientJs`) — the slug was server-interpolated into single-quoted `fetch()` path strings (`'${prefix}/api/…'`). Non-exploitable in practice (`getUserProfile` whitelists the slug to `ze`/`pam`; anything else 404s before render), but a defence-in-depth gap. | Emit the slug as a JSON literal (`const __userId = ${JSON.stringify(userId)}`) and build `prefix` + all 8 API paths via client-side concatenation, so the value is data by construction regardless of what reaches the function. 4 new vitest cases (`tests/web/source-chip.test.ts`) lock the JSON-literal encoding and break-out resistance. Surfaced by the SAST diff scan during the 2026-06-02 fallback-chip deploy. |

### 2026-05-03 — SAST cleanup (round 3)

The 2026-05-03 v0.3 deploy (push-to-stryd + form-text endpoints for Excubitor/Nunc) initially blocked twice on `--mode diff` SAST scans. Both findings were pre-existing — neither was introduced by the v0.3 work — but the diff scan flagged them as the changed files brought them into scope. Closed in the same session.

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 20 | High | DoS via unvalidated `tz` query on `/dashboard` — `q?.includes("/")` let crafted IANA-shaped strings (e.g. `?tz=a/a`) reach `Intl.DateTimeFormat` → RangeError → process crash | Extracted shared `resolveTz` helper to `src/api/tz.ts` using strict `isValidTimezone`; replaced the weak check in `dashboard.ts` and the duplicate in `workouts.ts`; new `push-to-stryd.ts` and `form-text.ts` consume it from day one. Crafted-tz security test added to both new handler test files. |
| 21 | High | SSRF / path-traversal via crafted `activityId` in MCP `submit_cross_training_rpe` — `encodeURIComponent` already neutralised the immediate vector but the HTTP API equivalent had a regex allowlist as defence-in-depth that the MCP tool lacked | Added `z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)` to the Zod schema in `src/tools/suggest.ts`. Same pattern as `src/api/validate.ts:isValidIntervalsId`. |

Third SAST run after these fixes: `NO_FINDINGS`. Re-baseline pending on the next commit.

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

### 2026-05-12 — Engine readiness + RPE-write deploy (clean)

Diff-mode SAST against `sast-baseline-2026-05-09-b` over the four-fix bundle (TSB rebuild flag, sport-specific recency, subjective renormalisation, 6-min warm-up cap) + the `session_rpe` write completion across MCP tool and HTTP API handler + the doc redistribution (architecture.md, deployment.md). 13 files changed, 540/298 insertions/deletions. Returned `NO_FINDINGS`. Tagged `sast-baseline-2026-05-12` on commit `7abbb75`.

### 2026-05-12 — session_rpe units fix (clean)

Follow-up deploy correcting Foster's session-RPE units (seconds → minutes) in `src/tools/suggest.ts` and `src/api/handlers/cross-training.ts`. The previous baseline shipped a multiplicative-by-60 bug that would have misclassified every submitted RPE as `hard` against the strain cascade's absolute thresholds. Caught and fixed before any production RPE write landed. Diff-mode SAST against `sast-baseline-2026-05-12` returned `NO_FINDINGS`. Tagged `sast-baseline-2026-05-12-b` on commit `1cadc9e`.

### 2026-05-13 — Suunto + Stryd pod power-source detection (clean)

`src/engine/power-source.ts` extended to recognise Suunto-recorded runs paired with a Stryd pod as Stryd-native, closing a misclassification where the most recent Suunto-recorded activity fell into the "Garmin active + athlete has Stryd" branch and applied a bogus 0.87 correction factor to FTP. Per-device heuristic split: Apple Watch keeps the filename-based detection (so the Stryd FIT enricher's HealthFit-vs-Stryd-app distinction holds), Suunto falls back to Stryd-stream presence in `stream_types` since the watch writes opaque-UUID `external_id` values. Diff-mode SAST against `sast-baseline-2026-05-12-b` returned `NO_FINDINGS`. Tagged `sast-baseline-2026-05-13` on commit `a6aafb7`.

### 2026-05-25 — Stryd workout-recommendations arc

Multi-round deploy + SAST iteration spiral landing the Stryd-recommendations integration. Four sequential clean tags after defensive hardening of the new code path: `sast-baseline-2026-05-25`, `-b`, `-c`, `-d`. Gemini's diff bundle does not include upstream defences, so each defensive cap added to `src/web/stryd-swap.ts` triggered the next theoretical finding even though the 1 MB JSON cap in `src/stryd/client.ts` was the load-bearing structural defence. Stopping criterion documented in `lessons.md` 2026-05-25 entry + `phase2/external-coach-integration-playbook.md` §SAST iteration management.

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 20 | Medium | Unbounded `block.repeat` in Stryd recommendation payload would flatten any-N reps into memory | `MAX_BLOCK_REPEAT = 100` clamp in `strydWorkoutToSegments` (`src/engine/stryd-mapper.ts`) |
| 21 | Medium | Unbounded JSON response from `getRecommendedWorkouts` | `MAX_RECOMMENDATIONS_JSON_BYTES = 1 MB` cap; response read as text first then size-checked before `JSON.parse` |
| 22 | Medium | Same unbounded-JSON pattern across the rest of `StrydClient` | Generalised `parseBoundedJson<T>(res, label)` helper applied to login, listActivities, downloadFit metadata, getLatestCriticalPower, createWorkout, scheduleWorkout |
| 23 | Medium | `applyStrydRecommendation` accepted any-shape Stryd workout structure | Pre-flight rejection with distinct `fallbackReason` chips: `unsafe_block_count` (>200), `unsafe_repeat_count` (out of [1,100] or non-integer), `unsafe_segments_per_block` (>50), `unsafe_segment_duration` (hour >24, minute/second ≥60), `malformed_duration_time`, `unsafe_total_segment_count` (product >500) |
| 24 | Low | Recommendation-set id interpolated into PATCH URL without shape validation | `^\d+$` allowlist on `recommendationSetId` in `markRecommendationSelected` |
| 25 | Low | Log injection: Stryd error message embedded in `console.warn` could include CR/LF | Strip `\r\n\t\v\f` before logging in the swap-layer error path |
| 26 | Low | `generatePrescriptions` in-memory user cache had no bound | `MAX_CACHE_ENTRIES = 100` with FIFO eviction (real registry has 2 users; cap is defensive) |
| 27 | Low | `sast_scan.py` failed on cache-disabled accounts (free-tier Gemini) | Inline-content patch so the scan runs without explicit cache references |

**Accepted finding (documented in CLAUDE.md)**: pre-existing hardcoded `"0"` for Swim userId at `src/web/prescriptions.ts:118` flagged by `-d` diff. `"0"` is a Vigil-disable sentinel (Vigil is Run-only, not a user id); cross-user leak is structurally impossible because upstream `data` is fetched per-user before the call. Accepted, not fixed.

### 2026-05-26 — FORM Athletica swim-recommendations arc

Bridged FORM personalised-swim recommendations end-to-end (commit `89ff94b`). Tagged `sast-baseline-2026-05-26` on commit `ec2b6ff` after the single Gemini-found defensive gap closed.

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 28 | (Pre-emptive) | Unbounded FORM JSON response on either `/personalized` or `/workouts/{id}` | `parseBoundedJson` 1 MB cap reused in `src/form/client.ts` |
| 29 | (Pre-emptive) | OAuth cache file at `~/.cache/form-client/oauth.json` group/world readable | `chmodSync(cachePath, 0o600)` on every write; cache best-effort (failures don't break in-memory flow) |
| 30 | (Pre-emptive) | Workout id path-traversal via `getWorkoutById` | UUID-v7 shape allowlist `^[0-9a-f]{8}-...-...$` before path interpolation |
| 31 | (Pre-emptive) | Unsafe FORM workout structure flowing through `formWorkoutToSegments` | Defensive caps in `applyFormRecommendation`: setGroups ≤20, sets-per-group ≤20, roundsCount ≤20, intervalsCount ≤100, intervalDistance ≤5000m, expanded segments ≤500 — distinct `fallbackReason` chips per cap |
| 32 | Low | `rest.defined` was not bounded; an attacker-controlled value would flow into `total_duration_secs` and land in the SQLite compliance table | `rest.defined` clamp to `[0, 3600]` s — `unsafe_rest_duration` fallback. Single Gemini diff finding before the `-2026-05-26` tag; fix landed in commit `ec2b6ff`. |
| 33 | Low | Log injection: FORM error message embedded in `console.warn` could include CR/LF | Strip `\r\n\t\v\f` before logging in `fallback()` (`src/web/form-swap.ts`) |

**Process miss (documented in `lessons.md` 2026-05-26)**: `docker-compose.yml` did not forward `FORM_EMAIL`/`FORM_PASSWORD`/`FORM_CACHE_PATH`/`PROMUS_FORM_DSW_ENABLED` to the running containers even though they were declared in `.env`. The FormClient builder logged `"Ze: FORM credentials not set — swim swap disabled"` and the swap silently no-op'd. Pre-flight checklist updated in `deployment.md` §Pre-flight sequence step 6: every new `process.env.X` requires a paired entry in every consuming service's `docker-compose.yml environment:` block.

### 2026-05-26 — FORM picked_workout_body persistence + Promus error-body hardening (clean after 2 iterations)

Pre-Promus-#167 prep: persist the picked FORM workout body inside `exercitator_context.picked_workout_body` so replay-from-Promus is byte-equal-deterministic even if FORM mutates a workout for the same UUID later. Plus three follow-up defensive fixes from the iteration-2 Gemini scan.

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 34 | Low | `emitDsw` logged remote error excerpt without stripping CR/LF — same log-injection class as #25/#33 | Sanitise `excerpt` + `msg` via `replace(/[\r\n\t\v\f]/g, " ")` in both the non-2xx and network-error branches of `emitDsw` |
| 35 | Medium | `emitDsw` called `await res.text()` on the error path unbounded — a compromised Promus could exhaust the 256 MB praescriptor container | New `readBoundedText(res, maxBytes)` helper streams chunks until 4 KB and cancels the rest of the body; same posture as `parseBoundedJson` on Stryd/FORM clients |

**Accepted findings (iteration-3 Gemini pass) — both pre-existing, not regressions**:

- **Medium: Tailscale auth key reuse across the 3 sidecars** (`docker-compose.yml`). Deliberate per `praefectura/docs/tailscale.md`: the tag-scoped key + tailnet ACL gate is the load-bearing defence, not per-node key uniqueness. Long-standing pattern, not introduced by this commit (Gemini's diff bundle pulled `docker-compose.yml` in only because we appended FORM env-var rows).
- **Low: PROMUS_API exposed to the `exercitator` container** (`docker-compose.yml`). Gemini misread the runtime topology — `src/web/promus-dsw.ts` is imported by both `src/api/handlers/{workouts,dashboard}.ts` (which run in the `exercitator` container under the HTTP API path) AND `src/web/prescriptions.ts` (which runs in `praescriptor`). The exercitator container legitimately needs `PROMUS_API` for DSW emission from its HTTP API handlers.

Stopping iteration here per the documented spiral-management policy (`lessons.md` 2026-05-25, `phase2/external-coach-integration-playbook.md` §SAST iteration management). Tagged `sast-baseline-2026-05-26-b` on the deploy commit.

### 2026-05-27 — Phase 7 replay closed-loop via Promus #167 (clean)

`fetchDswRecord` helper added to read DSW rows over HTTP for the replay scaffold. `validateFormWorkoutBody` extracted from `applyFormRecommendation` into a shared exported helper so the live swap layer AND the replay scaffold both reject poisoned bodies before flattening. `swim_css_m_per_s` plumbed into `exercitator_context` so byte-equal replay survives future intervals.icu CSS recalibration.

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 36 | Medium | `scripts/replay-form-dsw.ts` called `formWorkoutToSegments` on `picked_workout_body` without the swap-layer's defensive caps. A poisoned DSW row could exhaust memory at replay time (dev workstation or CI runner). | Extract `validateFormWorkoutBody` from `applyFormRecommendation` into an exported helper at `src/web/form-swap.ts`. Both the production swap path and the replay scaffold now call it before flattening; rejection produces a clear error rather than runaway expansion. |

Tagged `sast-baseline-2026-05-27` on commit `c9dc2bd` (`feat(replay): closed-loop replay via Promus #167 + swim_css persistence`). Diff scan returned `NO_FINDINGS` after the iter-1 fix landed. Verified end-to-end: live FORM/Swim DSW row for ze/2026-05-26 replays to SHA-256 byte-equal to the determinism-guard inline snapshot in `tests/web/form-render-integration.test.ts`.
