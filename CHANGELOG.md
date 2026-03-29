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
- **Vigil Phase 1** — biomechanical injury warning system data layer (issues #12–16)
  - `src/engine/vigil/types.ts` — `VigilMetrics`, `VigilAlert`, `VigilFlag`, `VigilBaseline` interfaces; metric weight constants (GCT/LSS 1.0, Form Power Ratio 0.8, ILR 0.5); Stryd FIT developer field name constants
  - `src/engine/vigil/fit-parser.ts` — FIT file parsing via `fit-file-parser`, Stryd developer field detection, per-activity metric extraction (averages, GCT drift via quartile comparison, power:HR drift via 5-minute windowed ratio)
  - `src/engine/vigil/backfill.ts` — 90-day Stryd FIT backfill pipeline with rate limiting (500ms between downloads); incremental per-activity processing for enrichment integration
  - `src/db.ts` — `vigil_metrics` table (per-activity summaries with bilateral Duo stubs) + `vigil_baselines` table (30d rolling + 7d acute windows); CRUD helpers; `:memory:` DB support for test isolation
  - Extended `StrydActivity` with `rpe`, `feel`, `surface_type` from Stryd post-run report (already returned by calendar API)
  - `fit-file-parser` npm dependency added
  - 18 new tests (FIT parsing, metric extraction, drift detection, DB operations, baseline upserts)
- **Vigil Phase 2** — baseline model and deviation scoring
  - `src/engine/vigil/metrics.ts` — scoreable metric extraction from VigilMetrics rows, field-to-metric-name mapping
  - `src/engine/vigil/baseline.ts` — 30-day rolling mean + stddev, 7-day acute window, minimum activity thresholds (5 for 30d, 2 for 7d), pure computation variant for testing
  - 10 new tests (baseline computation, insufficient data, partial nulls, stddev, acute vs chronic windows, bilateral)
- **Vigil Phase 3** — scoring engine, protective downshift, and pipeline wiring
  - `src/engine/vigil/scorer.ts` — z-score deviation with directional concern mapping, metric weights, composite severity 0–3, bilateral severity boost
  - `src/engine/vigil/index.ts` — pipeline orchestrator (check data → compute baselines → score → alert)
  - `src/engine/workout-selector.ts` — Vigil protective downshift at severity ≥ 2 (one category down), severity 3 forces base; preserves rest/recovery
  - `src/engine/types.ts` — `VigilSummary` interface added to `WorkoutSuggestion`
  - `src/engine/suggest.ts` — Vigil pipeline wired into `suggestWorkoutFromData()` for all running sports (Run, TrailRun, VirtualRun, Treadmill); normalises to "Run" for Stryd data queries; `VigilSummary` included in output
  - 21 new tests (scorer thresholds, ILR weight dampening, bilateral boost, downshift integration, guard coexistence)
- **Vigil Phase 4** — surface layer (Praescriptor UI + MCP response)
  - Vigil section on run prescription cards: severity 1 amber advisory, severity 2 amber warning with downshift detail, severity 3 red alert; weighted z-score display with ILR annotation
  - Data source bar: Vigil status (active/building/inactive, flag count, severity, baseline run count)
  - `DataSource.vigil` field for rendering pipeline
  - CSS: `.vigil-section`, `.vigil-caution`, `.vigil-alert` with amber/red palette variants
  - 12 new tests (severity levels, weight annotations, swim exclusion, data source bar variants)
- **Vigil Phase 5** — Stryd Duo bilateral metrics (confirmed with real Duo FIT data)
  - Duo provides **balance percentages** (left foot share, 50% = symmetric), not separate L/R streams: `Leg Spring Stiffness Balance`, `Vertical Oscillation Balance`, `Impact Loading Rate Balance`, `stance_time_balance`
  - `hasBilateralFields()` detection from balance field presence
  - Asymmetry computed as `|balance - 50| × 2` (e.g. 55% balance = 10% asymmetry)
  - L/R values derived from `total × (balance / 100)` for GCT, LSS, VO, ILR
  - Mixed-pod handling: bilateral baselines computed from Duo activities only (min 5); unilateral baselines from all activities
  - Updated FIT field names from real data: `stance_time` (not "Ground Time"), `Impact` in Body Weight (not "Impact Loading Rate"), `vertical_oscillation` in mm (converted to cm)
  - Bilateral severity boost already wired in Phase 3 scorer
  - 8 new Duo-specific tests (asymmetry extraction, L/R derivation, symmetric balance, developing asymmetry, mixed-pod baselines)
- Praescriptor: refresh button (↻) in header to regenerate prescriptions from fresh data (`POST /api/refresh` invalidates day-level cache)
- Praescriptor: data source bar showing activity count, wellness window, Stryd CP/enrichment, Vigil status with run count, and generation timestamp
- Stryd critical power used as authoritative FTP for running prescriptions — sourced directly from the foot pod via Stryd PowerCenter API (`/cp/history`), overriding intervals.icu's inferred FTP when Stryd is the detected power source
- 212 unit and integration tests covering the full engine pipeline, Vigil (FIT parsing, Duo bilateral, DB, metrics, baselines, scoring, integration, rendering), web prescriptions, Stryd client, enricher, intervals.icu format, send dedup, and invocations

### Fixed
- Vigil pipeline now runs for all running sport types (TrailRun, VirtualRun, Treadmill), not just "Run" — normalises to "Run" for Stryd data queries since Stryd stores all activities as "Run" regardless of intervals.icu classification
- Power source detection for Apple Watch + Stryd: Stryd watchOS app records `power_field: "power"` (lowercase) without CIQ stream markers, causing false Garmin correction (0.87×). Now detected via `external_id` containing "Stryd" + Apple Watch `device_name` pattern — no correction applied (fixes #8)
- `getActivityLoad()` now uses `power_load` for Stryd native recordings (Apple Watch), not just CIQ recordings (Garmin) — fixes cascading underreported load
- Hard session detection too narrow: `isHardSession()` now checks `icu_intensity > 85` and HR Z4+ > 25% of session time, in addition to RPE and load. Prevents back-to-back intense prescriptions when RPE is missing and load threshold is inflated (fixes #9)
- Stryd enrichment now deletes the original HealthFit activity instead of marking it ignored — prevents duplicate load, analysis pipeline confusion, and null `icu_intensity` on the replacement activity
- 66–80 readiness band: hard session yesterday now gives `base` (was `tempo`) — threshold work is inappropriate after VO2max intervals regardless of readiness score
- Hard-session rebalancing guard now only blocks upward shifts (`base→tempo`); downward shifts (`tempo→base` from high Z4+) are always allowed
- Enriched Stryd FIT uploads (`device_name: "STRYD"`, `external_id: "stryd-*.fit"`) now recognised by power source detection — eliminates false "Garmin native but Stryd connected" warning on run prescriptions
- Power context warnings (Stryd/Garmin detection) excluded from swim prescriptions — irrelevant for swimming
- Zone rebalancing no longer overrides hard-session protection: if `base` was selected because of a recent hard session (daysSinceHard < 2, readiness > 50), the `lowPct > 0.7` bump to `tempo` is suppressed. Same guard prevents `highPct > 0.4` from pushing `tempo→base` when the downshift was a hard-session guard (fixes #11)
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
