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
- Sport-specific staleness detection (`src/engine/staleness.ts`) — prevents stale thresholds from being prescribed after extended breaks (issue #7)
  - Staleness tiers: normal (0–27d), moderate (28–60d), severe (>60d), no_history
  - Moderate: downgrades category by one level, adds 10s pace buffer, emits warning
  - Severe/no_history: caps category at base, adds 15s pace buffer, forces HR-only targets
  - Symmetric handling for both Run and Swim — per-sport units (/100m for swim, /km for run)
  - Integration point: after sport selection, staleness ceiling applied after readiness-based category selection
- Readiness advisory warnings for individual components (HRV below baseline, sleep under 7h, negative TSB, elevated fatigue/soreness)
- **Praescriptor** web UI — daily workout prescriptions rendered in ritualistic visual style
  - New container (`praescriptor-web`) sharing the Exercitator codebase with a separate HTTP entrypoint
  - Dual prescription cards: Run + Swim side-by-side, each with structured segments, readiness context, and terrain guidance
  - Deity invocation system: Diana (run), Amphitrite (swim), Minerva (rationale), Apollo (closing) — generated via Anthropic API with static fallbacks
  - "Send to intervals.icu" button with server-side dedup (HTTP 409 on duplicate, `?force=true` override)
  - intervals.icu workout text formatter — converts `WorkoutSegment[]` to parseable workout description syntax
  - In-memory prescription caching (day-level) to avoid redundant API calls on send
  - Tailscale `serve` sidecar (tailnet-only, no funnel) at `praescriptor.tail7ab379.ts.net`
  - Dark theme with sport-specific accents (green for run, teal for swim), Cormorant Garamond + JetBrains Mono
  - SSR HTML — no client-side framework, no external JS dependencies
  - Zone guides on every segment: watts for running (from FTP zones), HR bpm for swimming (from intervals.icu HR zones)
- Engine refactoring: extracted `fetchTrainingData()`, `suggestWorkoutFromData()`, and `suggestWorkoutForSport()` from `src/engine/suggest.ts` to support forced sport selection without pipeline duplication
- **Stryd FIT enrichment** (`src/stryd/`) — detects low-fidelity Apple Watch + Stryd activities (missing CIQ developer fields), downloads full FIT from Stryd PowerCenter API, uploads to intervals.icu, marks original as ignored. Tracked in SQLite to prevent re-processing. Graceful degradation: skipped if `STRYD_EMAIL`/`STRYD_PASSWORD` not set. Failures never break prescriptions (fixes #10)
  - `src/stryd/client.ts` — Stryd API client (email/password auth, user-scoped calendar with epoch-based date filtering, two-step FIT download via signed GCS URL)
  - `src/stryd/enricher.ts` — detection (`needsEnrichment`), matching (same calendar day + distance ±5%), enrichment orchestrator with per-activity error isolation
  - `src/intervals.ts` — added `uploadFile()` method for multipart/form-data FIT uploads
  - `src/db.ts` — added `stryd_enrichments` table for enrichment tracking
- Praescriptor: refresh button (↻) in header to regenerate prescriptions from fresh data (`POST /api/refresh` invalidates day-level cache)
- Praescriptor: data source bar showing activity count, device breakdown, wellness window, Stryd enrichment count, and generation timestamp
- 124 unit and integration tests covering the full engine pipeline, web prescriptions, Stryd client, enricher, intervals.icu format, send dedup, and invocations

### Fixed
- Power source detection for Apple Watch + Stryd: Stryd watchOS app records `power_field: "power"` (lowercase) without CIQ stream markers, causing false Garmin correction (0.87×). Now detected via `external_id` containing "Stryd" + Apple Watch `device_name` pattern — no correction applied (fixes #8)
- `getActivityLoad()` now uses `power_load` for Stryd native recordings (Apple Watch), not just CIQ recordings (Garmin) — fixes cascading underreported load
- Hard session detection too narrow: `isHardSession()` now checks `icu_intensity > 85` and HR Z4+ > 25% of session time, in addition to RPE and load. Prevents back-to-back intense prescriptions when RPE is missing and load threshold is inflated (fixes #9)
- Extended `ActivitySummary` with `icu_intensity`, `external_id`, `source` fields from intervals.icu API
- Streamable-http crash on second request — McpServer.connect() called once per session, not per request
- Claude Desktop connector: accept both `/oauth/*` and `/*` paths for OAuth endpoints
- Claude Desktop connector: accept `/` as alias for `/mcp` (POST after OAuth)
- OAuth redirect URI: added `https://claude.ai/api/mcp/auth_callback` to allowlist
- PKCE S256: replaced `createHmac` (empty key) with `createHash("sha256")` — HMAC ≠ SHA-256
- OAuth registration: return `token_endpoint_auth_method: "none"` for browser-based flow
- `create_event`: append `T00:00:00` to date-only strings (intervals.icu requires datetime)
- Stale session handling: return HTTP 404 for unknown `mcp-session-id` instead of creating broken transport
- Monotony override: non-sport activities (WeightTraining, yoga) now break a run/swim streak
- Swim pace formatting: `threshold_pace` converted from secs/metre to secs/100m before rendering
- Minimum session durations enforced (recovery 20min, base 25min, tempo/intervals 30min, long 45min run/35min swim)
- Swim terrain: return `"pool"` instead of misleading `"flat"` for swim workouts

### Security
- Fixed open redirect in OAuth authorisation flow — redirect_uri validated against localhost allowlist
- Fixed global authentication lockout DoS — lockout tracking is now per-IP
- Added 64 KiB request body size limit on OAuth endpoints
- Added YYYY-MM-DD regex validation on all date parameters to prevent path traversal
- Added URL encoding (encodeURIComponent) on path-interpolated parameters
- Added session cap (100) and idle timeout (5 min) to prevent memory exhaustion
