# Lessons Learned

Chronological log of bugs, failures, surprises, and insights. Claude maintains this
proactively. Entries are append-only — never edit or remove past entries.

## 2026-04-29 — SAST cleanup: cache bound, constant-time bearer, rate limit, security headers

**What happened**: The five accepted findings from the 2026-04-29 deploy (one High, two Medium, two Low) were closed in a dedicated cleanup pass. While re-running SAST after the fixes a new Medium finding surfaced — `handleWorkoutsSuggested` was using the user-supplied `sport` query parameter directly in the cache key, which became reachable now that the cache is bounded but still LRU-evicted on insert. Closed in the same pass.
**Root cause**: Each finding had its own root cause. (1) `src/api/cache.ts` was an unbounded `Map` written to from authenticated read paths. (2) `matchBearer` in `src/api/auth.ts` short-circuited the per-key loop the moment `(client, userId, tokenLen)` failed, leaving a measurable timing channel for "is this (client, userId) configured?" even though the token compare itself was `timingSafeEqual`. (3) Praescriptor and the HTTP API had no rate limit beyond OAuth and the 30 s `/api/refresh` cooldown, so an authenticated tailnet client could amplify intervals.icu and Stryd polls. (4) `CLAUDE.md` echoed a truncated Tailscale auth-key prefix in source-controlled docs. (5) Praescriptor HTML responses were served without CSP/HSTS/`X-Content-Type-Options`/`X-Frame-Options`. (6) The `sport` query parameter flowed unvalidated into the cache key, so an attacker could fill the LRU with crafted long-key entries.
**Fix**: (1) `src/api/cache.ts` now caps at `EXERCITATOR_API_CACHE_MAX_ENTRIES` (default 1000) with LRU eviction on insert and a 60 s `setInterval(...).unref()` prune started from `startApiServer`. (2) `matchBearer` runs all three comparisons (`clientBuf`, `userIdBuf`, `tokenBuf`) for every configured key and aggregates them with bitwise AND; malformed bearers go through a dummy compare so total work is flat. (3) New `src/rate-limit.ts` token-bucket module is shared by both surfaces — separate read/write buckets per `userId`, configurable via `EXERCITATOR_RATE_LIMIT_READ` / `_WRITE` (0 disables for tests), 429 + `Retry-After` envelope. (4) `CLAUDE.md` now points to `praefectura/docs/tailscale.md` instead of echoing the prefix. (5) `src/web/security-headers.ts` exports `applyBaseSecurityHeaders` (every response) and `applyHtmlSecurityHeaders` (HTML pages); the CSP allows inline styles/scripts and Google Fonts because the renderer ships both, locks down `frame-ancestors`/`base-uri`/`form-action`. (6) `handleWorkoutsSuggested` allowlists `sport` to `{Run, Swim, auto}` before composing the cache key.
**Prevention**: Each fix grew a regression test (`tests/api/cache.test.ts`, `tests/rate-limit.test.ts`, `tests/web/security-headers.test.ts`, plus new auth and router cases). The deeper preventative is the workflow note from the previous lessons entry: re-baseline immediately after each accepted-risk deploy and open the cleanup work-item the same day. This time the deploy → SAST diff → cleanup loop completed inside one working session because the baseline `sast-baseline-2026-04-29` was tagged on the deploy commit, so the cleanup-pass diff could prove the fixes were complete with no historical noise.

A second SAST pass after the cleanup deploy surfaced two more findings — a Medium cache-flooding vector via the `tz` query (introduced when `tz` was added to the cache key on the same SAST scanner's earlier recommendation) and a Low DoS where a crafted `tz` cookie reached `localDateStr` and threw a RangeError 500. Both rooted in the pre-existing weak `tz.includes("/")` validation. Closed by lifting strict IANA validation into `src/engine/date-utils.ts` (`isValidTimezone`, backed by `Intl.DateTimeFormat`) and consuming it from both Praescriptor's cookie path and the HTTP API's `tz` query.

Lesson worth keeping: when a remediation extends a cache key with a previously unkeyed user-controlled value, the validator on that value moves from "decorative" (worst case = wrong "today" string) to "load-bearing" (worst case = unbounded cache flood). Tighten the validator at the same time — don't ship the cache change first and harden later.

## 2026-04-29 — Accepted SAST findings deferred to a dedicated cleanup PR

**What happened**: Pre-deploy SAST (`scripts/sast_scan.py --mode diff`) surfaced one new Medium-severity finding (path traversal in the `/api/compliance/confirm` endpoint via the user-supplied `activityId`) and re-surfaced five pre-existing issues in HTTP API / Praescriptor infrastructure that the baseline `sast-baseline-2026-03-29-b` predates.
**Root cause**: SAST diff mode compares against the most recent clean baseline; the HTTP API and Praescriptor compliance routes were rolled out after that baseline was tagged, so all of their unflagged tech debt surfaces on every diff run until a fresh clean baseline is pinned.
**Fix**: Patched the path traversal (`src/web/routes.ts` + `src/tools/suggest.ts` — wrap caller-supplied activity IDs in `encodeURIComponent` before path interpolation) and re-ran SAST. The remaining findings are accepted with the user's explicit consent and tracked for a dedicated cleanup pass:
  1. **High** — Unbounded in-memory cache in `src/api/cache.ts`. Tailnet-only and requires a valid bearer; needs LRU eviction + periodic prune of expired entries.
  2. **Medium** — Short-circuit logic inside `matchBearer` (`src/api/auth.ts`). The token compare itself is `timingSafeEqual` over fixed-length buffers, but the surrounding `&&` chain leaks whether `(client, userId)` matches a configured key. Real but very low impact (userIds are 2 known short strings, `ze` and `pam`, already implicit in the URL space). Refactor to evaluate all three comparisons unconditionally and aggregate with bitwise AND.
  3. **Medium** — No rate limiting on Praescriptor / HTTP API endpoints beyond the OAuth surface and `/api/refresh`'s 30 s cooldown. Tailnet-only mitigates impact, but `force=true` calendar sends and Stryd round-trips warrant per-user buckets.
  4. **Low** — `CLAUDE.md` line 342 prints a truncated Tailscale auth-key prefix (`tskey-auth-kqDKwGVavf...`). Not a usable key, but violates the "no secrets in docs" rule. Replace with a placeholder pointing at `praefectura/docs/tailscale.md`.
  5. **Low** — Praescriptor HTML responses ship without CSP / HSTS / `X-Content-Type-Options` / `X-Frame-Options`. Tailnet-only, but defence-in-depth; add the headers in `handleMainPage`.
A new `sast-baseline-2026-04-29` tag was placed on the deploy commit so future diff scans surface only post-2026-04-29 changes; the cleanup PR will clear these and re-baseline once landed.
**Prevention**: When the SAST baseline tag drifts a long way behind reality (here: a month, including a major HTTP API rollout), every diff scan re-prosecutes pre-existing issues and the deploy team starts treating SAST output as background noise. Re-baseline immediately after each accepted-risk deploy so the next diff scan only flags genuinely new issues, and open the cleanup ticket at the same time so accepted findings don't quietly accrue.

## 2026-04-29 — Run power Z2 lower bound dropped into walk-jog wattage

**What happened**: User reported that today's "Easy Base Run" prescription gave a power band of 173–236 W on a 315 W critical power. They flagged the lower bound as "brisk walk, not runnable" — for a runner whose actual easy run power averages 220–260 W, anything below ~210 W is sub-running effort.
**Root cause**: `workout-builder.ts` derived Z2 endurance as 55–75% of FTP/CP, which loosely matches intervals.icu's stored `icu_power_zones` but is below the running-power model Stryd uses. Stryd's "Easy" ceiling is 80% CP and the user's lowest comfortable run sits at ~72% CP. 55% CP on a high CP collapses into walking territory.
**Fix**: Tightened all run-power bands toward Stryd's published model: Z1 <70%, Z2 70–80%, Z3 80–90%, Z4 90–105%. Updated `tests/engine/workout-builder.test.ts` expectations and the `ZONE_CP_PCT` map in `src/web/stryd-format.ts` so the Stryd workout-export agrees with the engine.
**Prevention**: When reasoning about run-power zones, anchor against the foot-pod's measured easy-run distribution, not against intervals.icu's auto-zone defaults — the latter were inherited from cycling-style zone widths and don't reflect the walk-to-run transition power floor.

## 2026-04-29 — Vigil baseline froze at 2/5 after initial backfill

**What happened**: User saw "Vigil: baseline building (2/5 activities)" on Praescriptor despite having four Stryd-instrumented runs in the last 30 days. Two runs (the Stryd-device uploads from the start of April) were in `vigil_metrics`; the more recent Garmin + Stryd CIQ run and the Apple Watch + Stryd run were not.
**Root cause**: `runVigilBackfillIfNeeded` was gated by `hasAnyVigilMetrics` — it ran the 90-day backfill exactly once, then returned early forever. The only ongoing path that wrote to `vigil_metrics` was `enrichLowFidelityActivities`, which by design only processes Apple Watch native runs that lack CIQ developer fields. Garmin + Stryd CIQ runs and any post-seed Stryd-device upload were structurally invisible to Vigil.
**Fix**: `runVigilBackfillIfNeeded` now runs an incremental 14-day Stryd sync once the seed exists. `processStrydActivity` is already idempotent via `hasVigilMetrics(activityId)`, so the new path is cheap once everything is processed. Debounced to once per UTC day per athlete to keep the Stryd `listActivities` call from firing on every prescription render. Added `tests/engine/vigil/backfill.test.ts` covering first-time vs. incremental, debounce, and the no-client no-op.
**Prevention**: When a one-shot bootstrap step writes to a table that other code paths also need to keep current, audit every long-running write path the next time a metric "froze." Symmetric writes (enrichment) and asymmetric writes (one-time backfill) need an incremental cousin or the table goes stale.

## 2026-03-23 — SAST found five vulnerabilities in initial scaffold

**What happened**: First full SAST scan (Gemini 2.5 Pro) flagged 5 findings: open redirect in OAuth (Critical), global auth lockout DoS (High), unbounded request body (Medium), path traversal via date params (Medium), unbounded session storage (Medium).
**Root cause**: OAuth middleware was ported from internuntius (Python) without applying all the hardening that the original accumulated over time. Date parameters weren't validated. Session management had no limits.
**Fix**: (1) Validate redirect_uri against localhost allowlist. (2) Per-IP lockout instead of global. (3) 64 KiB body size limit on readBody(). (4) Regex date validation + encodeURIComponent on all path-interpolated params. (5) Max 100 sessions + 5-minute idle timeout with periodic pruning.
**Prevention**: SAST scan is mandatory before every deploy. Added date regex validation pattern as standard for all date-accepting tools.

## 2026-03-23 — Claude Desktop connector fails with path mismatches

**What happened**: After deploying to Arca Ingens, Claude Desktop could not connect as a connector. Same issues previously hit in the signifer project.
**Root cause**: Two Claude Desktop behaviours differ from the OAuth/MCP specs: (1) It POSTs to `/` after OAuth completes, not `/mcp` where StreamableHTTPServerTransport listens. (2) It constructs OAuth endpoints as `/authorize`, `/token`, `/register` by appending to the server URL, rather than reading the full paths from RFC 8414 metadata (`/oauth/authorize`, etc.).
**Fix**: (1) Match both `/` and `/mcp` in the MCP request handler. (2) Match both `/oauth/authorize` and `/authorize` (and same for `/token`, `/register`) in the OAuth middleware.
**Prevention**: When implementing MCP OAuth for Claude Desktop connectors, always accept both short and prefixed OAuth paths, and handle `/` as an alias for `/mcp`.

## 2026-03-23 — OAuth token exchange failed: three compounding bugs

**What happened**: Claude Desktop connector completed passphrase entry but failed with "Authorization with the MCP server failed". Three separate issues:
**Root cause**: (1) PKCE verification used `createHmac("sha256", emptyKey)` instead of `createHash("sha256")` — HMAC with empty key produces different output than SHA-256, so every PKCE challenge comparison failed. (2) Registration response included `client_secret` and set `token_endpoint_auth_method: "client_secret_post"` — Claude Desktop expects `"none"` for browser-based auth_code flow. (3) Allowed redirect URIs only included localhost — Claude Desktop uses `https://claude.ai/api/mcp/auth_callback`.
**Fix**: (1) Switch to `createHash("sha256")` for PKCE. (2) Registration returns `token_endpoint_auth_method: "none"`, no client_secret. (3) Added `https://claude.ai/api/mcp/auth_callback` to allowed redirect URIs.
**Prevention**: Always test OAuth with an actual Claude Desktop connector before declaring it working. PKCE S256 is SHA-256, not HMAC-SHA-256.

## 2026-03-23 — intervals.icu rejects YYYY-MM-DD dates for event creation

**What happened**: `create_event` tool returned 422 Unprocessable Entity when passing a date-only string.
**Root cause**: intervals.icu expects a datetime string (`2026-03-24T00:00:00`), not a date-only string (`2026-03-24`).
**Fix**: Append `T00:00:00` to date-only strings in the `create_event` handler before forwarding to the API.
**Prevention**: When interfacing with external APIs, verify the exact format they expect — don't assume ISO 8601 date-only is sufficient even when the parameter is called "date".

## 2026-03-23 — Stale connector state after container rebuild

**What happened**: After deploying a fix and rebuilding the container, Claude Desktop reported every tool returning generic errors — despite the server being healthy and responding to curl.
**Root cause**: Container rebuild invalidated all existing MCP sessions. Claude Desktop cached the previous auth/session state and kept reusing it rather than re-authenticating.
**Fix**: Remove the connector in Claude Desktop Settings → Connectors, then re-add it.
**Prevention**: After any container rebuild that changes the server process, warn users to remove and re-add the connector. This is a Claude Desktop limitation — stale auth state is not automatically cleared on server restart.

## 2026-03-24 — Stale mcp-session-id causes "Server not initialized" after container restart

**What happened**: After container rebuild, the Claude.ai connector kept sending `mcp-session-id` from the previous container. The server's original code created a new `StreamableHTTPServerTransport` for the unknown session and handed it a non-initialize request (`tools/call`). The MCP SDK rejected this with "Bad Request: Server not initialized" because the transport had never received an `initialize` message.
**Root cause**: The session lookup fell through to the "new session" code path, which created a fresh transport. But a fresh transport expects `initialize` as its first message, not `tools/call`. The connector doesn't drop its cached session ID on error.
**Fix**: Added explicit handling for stale session IDs — return HTTP 404 with a JSON-RPC error body before reaching the new-session code path. This is spec-correct per the MCP streamable-http transport specification. The Claude.ai connector does not currently auto-recover from 404 (requires manual reconnection), but the error is now clear instead of cryptic.
**Prevention**: Always check for stale session IDs between the "existing session" lookup and the "new session" creation. Never create a new transport for a request that carries a session ID not in the session map.

## 2026-03-28 — Enriched Stryd uploads not recognised by power source detection

**What happened**: After deploying Stryd FIT enrichment, the run prescription showed "Power field is set to Garmin native but Stryd is connected" with the 0.87 correction warning — despite the FTP being correct (279W from Stryd CP). The enriched activity had `device_name: "STRYD"` and `external_id: "stryd-6151018183557120.fit"`.
**Root cause**: `isStrydNativeRecording()` only matched Apple Watch devices (`/^Watch\d/`) and case-sensitive "Stryd" in `external_id`. The enriched upload used `device_name: "STRYD"` (not a Watch pattern) and lowercase "stryd" in the filename. The function returned false, so `detectPowerSource()` fell through to the "Garmin active but Stryd connected" branch.
**Fix**: Extended `isStrydNativeRecording()` to also match `device_name === "STRYD"` and made the `external_id` check case-insensitive. Also excluded power context warnings from swim prescriptions entirely.
**Prevention**: When adding a new data path (enrichment upload), verify it's recognised by all downstream detection logic. The upload filename format (`stryd-{id}.fit`) was set by the enricher but never checked against the detection patterns. Test with the actual data the system produces, not just the original source data.

## 2026-03-28 — 66–80 readiness band hard-session downshift insufficient (tempo instead of base)

**What happened**: With readiness 68 and a VO2max session yesterday (correctly detected via `icu_intensity: 90.07`), the engine prescribed threshold tempo. The 66–80 band's hard-session downshift only went from `intervals` to `tempo`, not to `base`. Additionally, the `hardSessionGuard` from the #11 fix was blocking the `highPct > 0.4 → tempo→base` rebalancing — a downward shift that would have been protective.
**Root cause**: Two compounding issues: (1) The decision matrix treated the 66–80 band differently from 51–65 — hard session gave `tempo` not `base`, assuming higher readiness meant moderate intensity was acceptable. Physiologically wrong after VO2max. (2) The `hardSessionGuard` was applied symmetrically to both upward and downward rebalancing, but only upward shifts needed blocking.
**Fix**: (1) Changed 66–80 band: `daysSinceHard < 2` now gives `base` (matching 51–65 band). (2) Removed `!hardSessionGuard` from the `highPct > 0.4 && tempo → base` rebalancing path — downward shifts are always safe.
**Prevention**: When designing a decision matrix with protective guards, ensure the guard floor is low enough for the worst-case stimulus (VO2max, race, etc.), not just the average case. And when adding guard flags to rebalancing, consider directionality — blocking downward (protective) shifts defeats the purpose.

## 2026-03-28 — Zone rebalancing silently undid hard-session protection (#11)

**What happened**: After deploying the #9 fix for hard session detection, the engine correctly identified yesterday's VO2max session as hard and selected `base` — then the HR zone distribution rebalancing (`lowPct > 0.7`) bumped it back to `tempo`. The engine prescribed threshold work the day after VO2max intervals, with its own "negative TSB" warning contradicting the prescription.
**Root cause**: The rebalancing logic didn't distinguish why `base` was selected. Two paths lead to `base` in the 51–65 readiness band: (1) genuinely moderate readiness (36–50), (2) protective downshift from a hard session. The rebalancing was appropriate for case 1 but destructive for case 2. This was a silent regression path — the #9 fix appeared to work in unit tests but the downstream rebalancing undid it in production.
**Fix**: Added a `hardSessionGuard` flag (`readinessScore > 50 && daysSinceHard < 2`). When active, `lowPct > 0.7` cannot bump `base→tempo`, and `highPct > 0.4` cannot push `tempo→base` (protects the 66–80 band). The guard only prevents *upward* rebalancing; downward rebalancing (reducing intensity) still applies.
**Prevention**: When a multi-stage pipeline makes a decision (e.g. "select base because hard session"), downstream stages must know the *reason* for the decision, not just the result. A boolean flag is the simplest mechanism. Test the full pipeline path, not just the individual stage.

## 2026-03-28 — Stryd enrichment duplicate caused null icu_intensity and persistent wrong prescription

**What happened**: After Stryd FIT enrichment deployed, both the original HealthFit activity and the new Stryd activity existed in intervals.icu. The enriched activity had `icu_intensity: null` (not yet analysed by intervals.icu), causing `isHardSession()` to miss it. The engine prescribed tempo instead of base despite the #11 hard-session guard fix being deployed.
**Root cause**: The original enrichment used `icu_ignore_time: true` to mark the HealthFit activity, but this left a duplicate visible to intervals.icu's analysis pipeline. Two activities for the same run confused metric computation, delaying or preventing `icu_intensity` calculation on the replacement. The hard-session detection chain (intensity → HR zones → load) was intact, but the input data was incomplete.
**Fix**: Changed enrichment from `PUT /activity/{id}` with `icu_ignore_time: true` to `DELETE /activity/{id}`. The enriched FIT is strictly superior (93KB → 165KB, all developer fields). The SQLite `stryd_enrichments` table preserves the audit trail. Delete failure is caught and logged but doesn't fail the enrichment.
**Prevention**: When replacing one entity with another in an external system, prefer deletion over soft-ignore. Soft-ignore leaves ambiguity that downstream systems may not handle. Always verify the external system has fully processed the replacement before relying on computed fields like `icu_intensity`.

## 2026-03-28 — Apple Watch + Stryd misdetected as Garmin native power (#8)

**What happened**: When recording a run with the Stryd watchOS app on Apple Watch (synced via HealthFit), `detectPowerSource()` incorrectly identified the power field as Garmin native and applied the 0.87 correction factor. FTP was reported as 280 instead of 322, producing artificially low zone targets.
**Root cause**: Stryd on Apple Watch records `power_field: "power"` (lowercase, same as Garmin native) and does not produce CIQ stream markers (`StrydLSS`, `StrydFormPower`, `StrydILR`). The detection logic relied solely on these CIQ markers to identify Stryd. Older Garmin runs in the 5-run lookback window did have CIQ markers, so `athleteHasStryd = true`, which triggered the "Garmin active but Stryd connected (forgot to switch)" branch.
**Fix**: Added `isStrydNativeRecording()` helper — detects Stryd via `external_id` containing "Stryd" + `device_name` matching Apple Watch pattern (`/^Watch\d/`). New branch inserted before the Garmin+Stryd correction branch. Also fixed `getActivityLoad()` to use `power_load` for Stryd native recordings (not just CIQ recordings).
**Prevention**: When adding support for a new recording device/app combination, check all detection signals — don't assume the existing power field naming convention is universal. The intervals.icu API returns `external_id` and `device_name` which together identify the recording source reliably.

## 2026-03-28 — Back-to-back intense sessions prescribed due to narrow hard session detection (#9)

**What happened**: The engine prescribed VO2max intervals (2026-03-27) followed by threshold tempo (2026-03-28) — two intense sessions on consecutive days. The `isHardSession()` function failed to recognise yesterday's VO2max session as hard.
**Root cause**: `isHardSession()` used only two signals: (1) RPE ≥ 7 (was null — not logged), (2) load > 0.7 × sportCtl (threshold was inflated by the Apple Watch power source bug #8, pushing it above all recent loads). A 37-minute VO2max session with `icu_intensity: 90.07` and 64% of time in HR Z4+ was unambiguously hard by any physiological measure, but neither check caught it.
**Fix**: Added two new checks to `isHardSession()`: (1) `icu_intensity > 85` — normalised power as % of FTP, the single best objective intensity indicator. (2) HR Z4+ > 25% of session time — catches high-intensity sessions even without power data. Both fire before the load-based fallback. Ordering: RPE → intensity → HR zones → load.
**Prevention**: When designing heuristics that classify training sessions, always have multiple independent signals. Any single signal can be missing (RPE) or distorted (load via power ecosystem mismatch). The `icu_intensity` field was already available from intervals.icu but not typed or used.

## 2026-03-28 — Test interaction: new isHardSession checks vs hrZoneDistribution rebalancing

**What happened**: Three new workout-selector tests failed because the test data triggered the existing `hrZoneDistribution` rebalancing logic (highPct > 0.4 downgrades tempo→base) or the load-based check with an artificially low sportCtl.
**Root cause**: Tests were constructed to isolate the new `isHardSession()` signals but didn't account for downstream interactions: (1) A VO2max session's HR zones inflated the overall highPct across all activities, triggering the rebalancing. (2) A single activity with load 30 gave sportCtl = 15, making 30 > 0.7×15 = 10.5, so the load check falsely triggered.
**Fix**: (1) Use null HR zones on the VO2max fixture to isolate the intensity signal. (2) Add easy activities to dilute highPct below 40%. (3) Add multiple activities to raise sportCtl so the load check doesn't false-positive.
**Prevention**: When testing one part of a multi-stage pipeline, trace the full pipeline with the test data on paper before writing assertions. Account for all downstream transformations, not just the function under test.

## 2026-03-28 — Stryd API endpoint changed: calendar moved to user-scoped path with epoch params

**What happened**: The Python reference script's `listActivities()` used `GET https://www.stryd.com/b/api/v1/activities/calendar?srtDate=MM-DD-YYYY&endDate=MM-DD-YYYY`. This returned HTTP 430 with `"aid path param must be int64: calendar"` — the API was interpreting `calendar` as an activity ID.
**Root cause**: Stryd migrated their API. The activities calendar endpoint moved from `www.stryd.com/b/api/v1/activities/calendar` (with MM-DD-YYYY date params) to `api.stryd.com/b/api/v1/users/{userId}/calendar` (with `from`/`to` Unix epoch params and `include_deleted`). The old `srtDate`/`endDate` params were silently ignored even on the new endpoint, causing the API to return all 822 activities.
**Fix**: Updated `StrydClient.listActivities()` to use the correct endpoint with epoch-based `from`/`to` params. Discovered via browser dev tools HAR capture.
**Prevention**: When porting from a reference script that calls an undocumented API, always verify the endpoints work before writing tests. Capture a fresh HAR from the web app to confirm current request patterns. Undocumented APIs change without notice.

## 2026-03-28 — Vigil pipeline only ran for exact sport="Run", missing TrailRun/Treadmill

**What happened**: End-to-end review (Chain of Reasoning) found that `suggestWorkoutFromData` checked `sport === "Run"` before running the Vigil pipeline. When the sport selector chose "TrailRun" or "Treadmill", Vigil was silently skipped — no biomechanical monitoring for those activities.
**Root cause**: The initial wiring used a simple string equality check against "Run", not accounting for intervals.icu's run-type variants (TrailRun, VirtualRun, Treadmill). Separately, Stryd stores all activities as `sport = "Run"` in vigil_metrics regardless of intervals.icu's classification, so querying with the exact sport type would return no results for non-"Run" types.
**Fix**: Changed to check against all run types (`["Run", "VirtualRun", "TrailRun", "Treadmill"].includes(sport)`) and normalise to "Run" when calling `runVigilPipeline()`, matching how Stryd data is stored.
**Prevention**: When wiring a subsystem that operates on a sport category (running), always match the full set of sport type variants, not a single string. The `RUN_TYPES` constant in workout-selector.ts already defined this set — should have reused it or defined a shared constant.

## 2026-03-28 — Stryd Duo provides balance percentages, not separate L/R streams

**What happened**: The Vigil spec assumed Duo would provide separate left/right streams (e.g. `StrydL_GCT`, `StrydR_GCT`) based on CIQ naming conventions. Real Duo FIT data contains **balance percentages** instead: `Leg Spring Stiffness Balance` (52.0%), `stance_time_balance` (48.5%), etc. Also discovered field name differences: `stance_time` not "Ground Time", `Impact` (Body Weight) not "Impact Loading Rate", `vertical_oscillation` in mm not cm.
**Root cause**: The spec's bilateral field patterns were marked [UNVERIFIED] and based on guesses from CIQ naming conventions. Stryd's Duo uses a different paradigm — balance is a single percentage representing the left foot's share (50% = symmetric), not paired L/R absolute values.
**Fix**: Wrote a discovery script to download a real Duo FIT and inspect `field_descriptions`. Updated `STRYD_FIT_FIELDS` constants, added `balanceToAsymmetry()` (asymmetry = `|balance - 50| × 2`), and `splitByBalance()` to derive L/R from `total × balance`. Also fixed `vertical_oscillation` mm→cm conversion.
**Prevention**: When designing for hardware you don't yet have data from, always mark field assumptions as unverified and build a discovery step as the first task. The 10-minute script saved hours of debugging incorrect assumptions. For any undocumented sensor API, capture real data before writing production code.

## 2026-03-28 — SSR HTML tests matching CSS class names instead of rendered elements

**What happened**: Vigil render tests checking `not.toContain("vigil-section")` failed even when no Vigil section was rendered. The HTML contained `vigil-section` in the inlined `<style>` block as a CSS class definition, not as a rendered element.
**Root cause**: The `renderPage()` function inlines all CSS into a `<style>` tag. String matching on the full HTML output matches CSS class definitions (`.vigil-section { ... }`) as well as actual rendered elements (`class="vigil-section"`). When testing that an element is *not* rendered, the CSS definition creates a false match.
**Fix**: Added a `htmlBody()` helper that slices the HTML after `</style>`, testing only the rendered body content. Also used more specific selectors (`vigil-header` for element presence) that only appear in rendered output, not CSS definitions.
**Prevention**: When testing SSR output with inlined styles, always strip the `<style>` block before asserting on absence. Alternatively, test for element-specific content (text, attributes) rather than class names that also appear in CSS.

## 2026-03-28 — Module-level const captures env var at import time, not at use time

**What happened**: Vigil DB tests failed with stale data from prior tests despite setting `EXERCITATOR_DB_PATH` in `beforeEach`. The `getVigilMetrics()` function returned 4 rows when only 1 was saved — data from the previous test's DB was leaking through.
**Root cause**: `db.ts` declared `const DB_PATH = process.env.EXERCITATOR_DB_PATH ?? "data/exercitator.db"` at module scope. This evaluates once when the module is first imported, not when `getDb()` is called. Changing the env var in `beforeEach` had no effect — `DB_PATH` was already captured. Even with `_resetDb()` clearing the singleton, the new `getDb()` call used the original path.
**Fix**: Replaced `const DB_PATH` with `function getDbPath()` that reads the env var on each call. Also added `:memory:` guard to skip `mkdirSync` when using in-memory SQLite for tests.
**Prevention**: When a module needs to respect env var changes (especially in tests), never capture the env var in a module-level const. Use a function that reads `process.env` at call time. This is a common ESM/Node.js testing pitfall — modules are cached, consts are evaluated once.

## 2026-03-26 — Tailscale sidecar DNS clash with Docker container name

**What happened**: Praescriptor's Tailscale sidecar returned 502 when proxying to `http://praescriptor:3847`. The container was running and healthy on the Docker network.
**Root cause**: The Tailscale sidecar's `hostname: praescriptor` registered `praescriptor` in Tailscale's MagicDNS, which took priority over Docker's internal DNS. When the sidecar resolved `praescriptor`, it got the Tailscale IP (172.29.28.5 — itself) instead of the Docker container IP (172.29.28.4). Connection refused because the sidecar isn't listening on port 3847.
**Fix**: Renamed the web container from `praescriptor` to `praescriptor-web` (via `container_name: praescriptor-web`). Updated the serve config to proxy to `http://praescriptor-web:3847`. The Tailscale hostname stays `praescriptor` (for the public-facing URL) while the Docker container name is distinct.
**Prevention**: When a Tailscale sidecar uses `hostname: X`, never name the proxied container `X`. Use a different `container_name` (e.g. `X-web`, `X-app`) so Docker DNS and Tailscale MagicDNS don't collide. The existing exercitator setup already did this correctly: `hostname: exercitator` + `container_name: exercitator-mcp`.

## 2026-03-29 — OAuth "wrong password" caused by browser password manager autofill

**What happened**: User reported "wrong password" when authenticating at the OAuth passphrase gate. The passphrase was confirmed correct (copy-paste verified in plain text). curl POST from the command line succeeded (HTTP 302).
**Root cause**: The browser's password manager had `Hotcrumpet3579` (14 chars) saved for `exercitator.tail7ab379.ts.net` and was silently overwriting the clipboard paste with the saved credential. The server expected `praescriptor-fortis` (19 chars). Diagnostic hex logging of the POST body confirmed the mismatch — the browser was sending a value the user never typed.
**Fix**: Changed the passphrase to `Hotcrumpet3579` to match the password manager entry. Added `autocomplete="off"` to the password input to reduce future autofill interference (though browsers may ignore this).
**Prevention**: When debugging "wrong password" issues where the user insists the input is correct, add server-side diagnostic logging to see what was actually received. Password manager autofill on `<input type="password">` fields is invisible to the user and can override clipboard paste. The `autocomplete="off"` attribute is a best-effort mitigation — not all browsers respect it.

## 2026-03-29 — IntervalsClient.athleteId "0" is an alias, not a unique identifier

**What happened**: Per-user Vigil isolation (athlete_id column in vigil_metrics/baselines) was ineffective — both Ze and Pam resolved to `client.athleteId = "0"`, so Ze's Vigil data blocked Pam's 90-day backfill.
**Root cause**: intervals.icu treats athlete ID `"0"` as a convenience alias meaning "the athlete owning this API key". Two different API keys both resolve to `"0"` locally, even though they represent different athletes server-side. Using `client.athleteId` as a DB partition key created a collision.
**Fix**: Use `profile.id` ("ze", "pam") as the Vigil athlete_id instead of `client.athleteId`. The profile ID is stable, unique, and doesn't depend on intervals.icu API semantics.
**Prevention**: When partitioning local data by user, never use an external API's convenience aliases as partition keys. Use the application's own unique identifiers (profile IDs, slugs, UUIDs) that are guaranteed distinct.

## 2026-03-29 — Apple Watch native power misclassified as Garmin with Stryd correction

**What happened**: When an athlete ran with just an Apple Watch (no Stryd pod), the power source was classified as "Garmin native with Stryd connected", applying a meaningless 0.87 correction factor to Apple's wrist-accelerometer power estimate.
**Root cause**: Apple Watch and Garmin both report `power_field: "power"` (lowercase). The detection logic only distinguished them by checking for Stryd CIQ streams (`StrydLSS`, etc.) in the history, not by checking the device type of the most recent run. An Apple Watch run with `athleteHasStryd = true` (from older runs) hit the Garmin+Stryd correction branch.
**Fix**: Added an Apple Watch native detection check before the Garmin+Stryd branch. When `isNonGarminDevice(mostRecentRun)` is true and it's not a Stryd native recording, look past it to find the most recent Stryd-powered run. If none exists, return `source: "none"`.
**Prevention**: When classifying device ecosystems, check the specific device of the activity in question, not just the athlete's historical data. Different devices from the same athlete can produce fundamentally different data.

## 2026-03-29 — Stryd has an undocumented workout API

**What happened**: Research suggested Stryd had no public API for pushing workouts. A HAR capture of the PowerCenter web UI revealed a full REST API for creating, scheduling, and deleting structured workouts.
**Root cause**: Stryd's API is not publicly documented. The only way to discover it was traffic analysis.
**Fix**: Reverse-engineered three endpoints: `POST /workouts` (create), `POST /users/{id}/workouts?id=&timestamp=` (schedule on calendar), `DELETE /users/{id}/workouts/{calendarId}` (remove). Power targets use CP% — maps directly to our zone model. Auth is the same Bearer token from the existing login endpoint.
**Prevention**: When a vendor's public documentation says "no API", check the web UI's network traffic. Modern SPAs almost always have a REST/GraphQL API behind them. HAR captures are the fastest way to map undocumented APIs.

## 2026-04-01 — Doubled repeat count in swim prescriptions (#24)

**What happened**: Swim prescriptions displayed "4×4×200m" — the repeat count appeared twice in the UI and intervals.icu workout text.
**Root cause**: All swim builders embedded the rep count in `target_description` (e.g. "4×200m Z2") while also setting the `repeats` field. The rendering layer prepended `repeats`, producing doubled output.
**Fix**: Stripped the `N×` prefix from `target_description` in all swim and run builders. The `repeats` field carries the count structurally.
**Prevention**: When a segment has both a structured field (`repeats`) and a human-readable description (`target_description`), the description should describe the work interval only, not include structural data that the renderer will add.

## 2026-04-01 — intervals.icu parser treats `m` as minutes, not metres

**What happened**: Swim workouts sent to intervals.icu parsed incorrectly — "200m" was interpreted as "200 minutes". The downloaded workout JSON showed only 4 bare steps with no distances.
**Root cause**: The intervals.icu workout text parser uses `m` for minutes and `mtr` for metres. Our format used `200m` (minutes), not `200mtr` (metres). Also: repeat blocks need blank lines before/after, rest needs an intensity target (not just the word "rest"), and pace needs a `Pace` suffix.
**Fix**: Rewrote `buildIntervalsDescription` for swim: `mtr` for metres, `Pace` suffix, blank lines around repeats, `50%` for rest. Swim uses `target_description` directly for distance-based steps.
**Prevention**: When generating text for an external parser, always verify against the parser's documentation — don't assume units match common conventions. Download and inspect the parsed result to confirm structure.

## 2026-04-02 — Readiness scoring: five compounding bugs inflated scores by ~8 points

**What happened**: Athlete with suppressed HRV (73% of baseline), poor sleep (5h58), and Oura readiness of 51 got a readiness score of 49 and was prescribed long sessions for both run and swim. Should have been ~42 with base sessions.
**Root cause**: Five issues: (1) Oura readiness (0–100) treated as 0–10 scale, always clamping subjective component to 100. (2) Sleep warning only fired below score 60 — too lenient. (3) No multi-night sleep trend detection. (4) HRV cliff at 75% of mean — anything below scored 0, losing gradient information. (5) Long session trigger gate at readiness 45 — too low for fatigued athletes.
**Fix**: (1) Use readiness directly as 0–100. (2) Raise sleep warning to < 70 and sleepScore < 75. (3) Add 3-night trend check. (4) Extend HRV gradient to 0.6 (score 0) through 0.75 (score 20). (5) Raise long gate to 60 + add HRV guard (component < 30 blocks long).
**Prevention**: When integrating data from wearable APIs (Oura, Garmin), verify the scale of each field against the API documentation — don't assume all numeric fields use the same range. When designing readiness thresholds, test with real athlete data at various fatigue levels, not just synthetic fixtures. The subjective scale bug went unnoticed for weeks because tests used neutral defaults.

## 2026-04-03 — Staleness cleared by a single session after 68-day break

**What happened**: Athlete swam once (04-01) after a 68-day break from swimming. The staleness check saw "last swim 2 days ago" and returned normal tier. The system prescribed a distance swim (long category) — inappropriate for a return-to-sport athlete.
**Root cause**: Staleness only checked "days since last activity in this sport", not the frequency of recent sessions. A single session after months off immediately cleared the staleness flag.
**Fix**: Added a minimum session count (3 in the 14-day window) for "normal" tier. Fewer sessions with a recent date get "moderate" tier with a "Return to sport" warning and pace buffer. This naturally downgrades the category and prevents aggressive prescriptions.
**Prevention**: When designing a "recency" check, consider both the date of the most recent session and the *density* of recent sessions. A single data point shouldn't override a pattern of absence.

## 2026-04-03 — Sleep warnings were advisory-only, didn't influence prescriptions

**What happened**: Athlete had 3+ nights of poor sleep (jet lag, London→Oakland), readiness score showed sleep warnings, but the system still prescribed tempo (threshold) running. The warnings were decorative — they informed but didn't protect.
**Root cause**: The sleep trend detection ran in `computeReadiness` and added warning strings, but the resulting score (which incorporates sleep as only 20% weight) could still be high enough for tempo. No mechanism existed to feed the sleep debt signal back into category selection.
**Fix**: Added `sleepDebt: boolean` to `ReadinessResult`, set when 3+ recent poor nights detected. Threaded through to `selectWorkoutCategory` where it caps category at base — overrides tempo/intervals/long regardless of readiness score.
**Prevention**: When a system generates warnings about a dangerous condition, consider whether those warnings should also trigger protective behaviour, not just inform the user. Advisory-only warnings are insufficient when the system can act on them.

## 2026-04-04 — Swim workout steps silently dropped by intervals.icu parser

**What happened**: Swimming prescriptions sent to intervals.icu were missing the warm-up and main set steps — only the drill repeats and cool-down appeared. The 200m warm-up and 400m pull main set were silently dropped.
**Root cause**: Two issues. First, cue text from `target_description` (e.g. "easy free, Z1", "pull Z1") was placed before the distance in the step line, confusing the parser — commas and zone-like text (`Z1`) were misinterpreted. Second and more critically, pace targets used `/100mtr Pace` but intervals.icu only recognises `/100m` as a valid pace denominator. The `mtr` suffix is exclusively for bare distance values (`200mtr`), not pace unit denominators. Steps with unrecognised pace format were silently dropped.
**Fix**: (1) Removed cue text from step output — step lines now contain only `[name] [distance]mtr [pace]/100m Pace`. (2) Changed pace format from `/100mtr Pace` to `/100m Pace`.
**Prevention**: When integrating with external parsers, read the spec carefully and distinguish between similar-looking formats in different contexts (`mtr` for distance vs `m` for pace denominators). Test by verifying the external system actually rendered the output, not just that the HTTP request succeeded. Silent parse failures are the hardest bugs to catch.
