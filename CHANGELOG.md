# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Initial project setup via Armature framework
- TypeScript MCP server with dual transport (stdio / streamable-http)
- intervals.icu API client with Basic auth
- MCP tools: athlete profile, activities, wellness, calendar events
- OAuth middleware with PKCE, passphrase gate, signed tokens, rate limiting
- SQLite cache layer for infrequently-changing data
- Docker + Docker Compose with Tailscale funnel sidecar
- Biome linting/formatting, TypeScript strict mode, Vitest test suite
- Per-session McpServer instantiation for streamable-http (max 100, 5-min idle timeout)
- `suggest_workout` MCP tool — Daily Suggested Workout engine modelled on Garmin/Firstbeat DSW
  - Readiness scoring (0–100) from TSB, sleep, HRV, recency, subjective wellness
  - Sport selection (Run vs Swim) based on load deficit and monotony prevention
  - Workout category selection (rest/recovery/base/tempo/intervals/long) from readiness + training context
  - Structured workout builder with warm-up, main set, and cool-down for both running and swimming
  - Duration scaling by CTL, HR zone distribution rebalancing, long session triggers
- 33 unit and integration tests covering the full engine pipeline
- DSW engine v2: power source detection (Stryd vs Garmin native vs HR-only)
  - `src/engine/power-source.ts` — detects active power ecosystem from recent activity streams
  - Garmin→Stryd correction factor (0.87) applied when Stryd is connected but Garmin power is active
  - `getActivityLoad()` selects appropriate load metric (power_load vs hr_load) per activity
- DSW engine v2: terrain guidance as first-class field
  - `src/engine/terrain-selector.ts` — recommends flat/rolling/trail based on workout category and recent terrain
  - Recovery, base, and intervals always prescribe flat terrain to prevent power spikes
- DSW engine v2: dual-target prescription for running workouts
  - Power targets derived from FTP zones (primary execution target)
  - HR safety cap on every running segment (reduce power if HR exceeds cap)
  - Power zone derivation: Z1 <55%, Z2 55–75%, Z3 76–90%, Z4 91–105% of FTP
- DSW engine v2: power-aware load computation throughout pipeline
  - Sport selector uses `PowerContext` for load deficit calculations
  - Workout selector uses `PowerContext` for hard session detection
- Extended `ActivitySummary` type with power fields (`power_load`, `hr_load`, `power_field`, `stream_types`, `icu_rolling_ftp`, `total_elevation_gain`)
- Extended `WorkoutSuggestion` with `terrain`, `terrain_rationale`, `power_context` fields
- Extended `WorkoutSegment` with `target_power_low`, `target_power_high` fields
- 58+ unit and integration tests covering the full engine pipeline including power source detection and terrain selection

### Fixed
- Streamable-http crash on second request — McpServer.connect() called once per session, not per request
- Claude Desktop connector: accept both `/oauth/*` and `/*` paths for OAuth endpoints
- Claude Desktop connector: accept `/` as alias for `/mcp` (POST after OAuth)
- OAuth redirect URI: added `https://claude.ai/api/mcp/auth_callback` to allowlist
- PKCE S256: replaced `createHmac` (empty key) with `createHash("sha256")` — HMAC ≠ SHA-256
- OAuth registration: return `token_endpoint_auth_method: "none"` for browser-based flow
- `create_event`: append `T00:00:00` to date-only strings (intervals.icu requires datetime)

### Security
- Fixed open redirect in OAuth authorisation flow — redirect_uri validated against localhost allowlist
- Fixed global authentication lockout DoS — lockout tracking is now per-IP
- Added 64 KiB request body size limit on OAuth endpoints
- Added YYYY-MM-DD regex validation on all date parameters to prevent path traversal
- Added URL encoding (encodeURIComponent) on path-interpolated parameters
- Added session cap (100) and idle timeout (5 min) to prevent memory exhaustion
