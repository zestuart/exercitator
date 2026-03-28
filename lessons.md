# Lessons Learned

Chronological log of bugs, failures, surprises, and insights. Claude maintains this
proactively. Entries are append-only — never edit or remove past entries.

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

## 2026-03-26 — Tailscale sidecar DNS clash with Docker container name

**What happened**: Praescriptor's Tailscale sidecar returned 502 when proxying to `http://praescriptor:3847`. The container was running and healthy on the Docker network.
**Root cause**: The Tailscale sidecar's `hostname: praescriptor` registered `praescriptor` in Tailscale's MagicDNS, which took priority over Docker's internal DNS. When the sidecar resolved `praescriptor`, it got the Tailscale IP (172.29.28.5 — itself) instead of the Docker container IP (172.29.28.4). Connection refused because the sidecar isn't listening on port 3847.
**Fix**: Renamed the web container from `praescriptor` to `praescriptor-web` (via `container_name: praescriptor-web`). Updated the serve config to proxy to `http://praescriptor-web:3847`. The Tailscale hostname stays `praescriptor` (for the public-facing URL) while the Docker container name is distinct.
**Prevention**: When a Tailscale sidecar uses `hostname: X`, never name the proxied container `X`. Use a different `container_name` (e.g. `X-web`, `X-app`) so Docker DNS and Tailscale MagicDNS don't collide. The existing exercitator setup already did this correctly: `hostname: exercitator` + `container_name: exercitator-mcp`.
