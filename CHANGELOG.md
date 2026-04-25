# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- HTTP API for native clients (`/api/...`) — tailnet-only via new `exercitator-api.tail7ab379.ts.net` Tailscale sidecar, co-resident with the MCP server on port 8643. Endpoints: `/api/health`, per-user `/api/users/:userId/{status,workouts/today,workouts/suggested,workouts/:id,dashboard,compliance/summary,compliance/detail,cross-training/:activityId/rpe}`. Bearer auth scoped `<client>:<userId>:<token>` with constant-time compare and cross-user 403 enforcement. Polymorphic segment targets (power / pace / hr) so swim is first-class. 409 + `awaiting_input` envelope unblocks cross-training RPE via dedicated POST. Per-user response cache (300 s default) shields intervals.icu and Stryd from poll amplification.
- Shared user registry (`src/users.ts`) — lifted from `src/web/users.ts` so Praescriptor and the HTTP API share one source of truth for (ze, pam) + env var names + feature flags.
- Workout compliance tracking: persist prescriptions and send events to SQLite, compare actual activity laps against prescribed targets with binary pass/fail scoring per segment
- Traffic light UI on Praescriptor cards: green/amber/red dots per segment showing how closely execution matched prescription; compliance summary with segment count
- Confirmation UI for yesterday's prescriptions: "I completed this" (auto-matches activity from intervals.icu) and "I skipped this" (with optional reason) buttons
- Compliance API routes: GET compliance by date, POST confirm/skip, GET trending, POST backfill
- MCP tools: `get_compliance_summary` (completion rate, compliance rate, category breakdown, weekly trends) and `get_compliance_detail` (per-segment pass/fail with actuals vs targets)
- Compliance aggregation: weekly/monthly rollups with HR overshoot and power deviation tracking for prescription self-correction
- 6 new SQLite tables: prescriptions, prescription_segments, send_events, compliance_assessments, segment_compliance, compliance_aggregates
- "Copy FORM Text" button on swim prescription cards — generates FORM goggles Script notation (stroke abbreviations, effort levels, rest intervals) for clipboard copy into the FORM app
- Rest intervals between non-repeat swim segments (20s easy, 40s hard) for FORM goggles programming and clearer intervals.icu workout descriptions

### Changed
- Send-to-intervals.icu and send-to-Stryd dedup migrated from in-memory Maps to SQLite persistence (survives container restarts)
- Vigil 90-day Stryd FIT backfill: helper lifted from Praescriptor to `src/engine/vigil/backfill.ts` so the HTTP API's `/status` and `/dashboard` can fire-and-forget on first call. Per-athlete in-flight Set guards against concurrent kicks.
- Deployment target moved from Arca Ingens (QNAP, decommissioned 2026-04-04) to Cogitator (Mac Mini M4 Pro). Same tarball flow, different host (`dominus@cogitator.tail7ab379.ts.net`, port 22, key auth) and home path (`~/Container/exercitator/`). See `praefectura/docs/cogitator-operations.md`.
- `docker-compose.yml`: `exercitator-data` volume now declared `external: true` to match its actual lifecycle and silence the compose warning.

### Fixed
- HTTP API `suggestion.power_context.source` emitted bare engine value (`"stryd"`) instead of the spec wire enum (`"stryd_direct" | "stryd_intervals" | "intervals_inferred" | "none"`); `status.critical_power.source` already mapped correctly. Extracted shared `mapWirePowerSource` helper so the two endpoints can never disagree, and rewired `/workouts/suggested` to fetch Stryd CP so `stryd_direct` is reachable from that path. (closes #25)
- HTTP API `critical_power.watts` returned a float from the Stryd CP API; now rounded to integer at the wire boundary.
- Swim workout steps silently dropped by intervals.icu: pace format changed from `/100mtr Pace` to `/100m Pace` (intervals.icu only recognises `/100m` as a pace denominator)
- Swim workout steps missing from intervals.icu chart: steps with pace-only targets now include both pace and HR targets so the chart renders in any view mode
- Swim cue text (e.g. "easy free, Z1") removed from step output to avoid confusing intervals.icu parser

### Added (prior)
- Per-user timezone awareness — `localDateStr(date, tz)` utility replaces all UTC date computations; timezone resolved per request via browser cookie → intervals.icu athlete profile → UTC fallback; threaded through engine, web layer, and MCP tools
- Swim warm-up broken into individual 100m drill sections (free, kick with board, pull with buoy) with 10s rest gaps between steps; 400m warm-up (long sessions) adds a 4th drill/swim choice step
- Multi-night sleep trend warning — alerts when 3+ recent nights have poor sleep (< 7h or score < 75) to catch cumulative sleep debt and jet lag
- Sleep debt category cap — when 3+ recent poor nights detected, category capped at base regardless of readiness score; makes sleep warnings actionable, not just advisory
- HRV guard on long session trigger — HRV component < 30 blocks base→long upgrade to prevent long sessions when recovery is suppressed
- Staleness session count gate — requires ≥ 3 sessions in 14-day window to consider athlete "current" in a sport; one session after a long break gets moderate staleness (return-to-sport) with pace buffer and category downgrade
- New workout-selector tests: long session blocked below readiness 60, long session blocked when HRV suppressed, sleep debt caps at base
- New staleness tests: return-to-sport pattern (recent but too few sessions)

### Changed
- Readiness scoring: Oura/Garmin readiness (0–100) now used directly in subjective component — was incorrectly treated as 0–10 scale, always clamping to 100
- HRV scoring gradient smoothed: ratio < 0.75 no longer cliffs to 0; extended to gradient from 0.75 (score 20) down to 0.6 (score 0)
- Sleep warning threshold raised from < 60 to < 70 (component score) and sleepScore threshold from < 60 to < 75
- Long session readiness gate raised from ≥ 45 to ≥ 60
- Swim intervals.icu workout format: uses `mtr` for metres (not `m`), `Pace` suffix, blank lines around repeat blocks, `50%` intensity for rest steps
- Swim format uses `target_description` directly for distance-based steps instead of time-based durations with HR percentages
- Rationale section: removed sport selection reason and readiness score from text, centred under "Under Minerva's Counsel" header (dropped "Rationale ·" prefix)
- Shared warnings (HRV, sleep) rendered once above cards instead of duplicated per card; centred alignment
- Apollo's closing tribute moved from per-card bottom to single centred block below cards
- Deity invocation text: colour darkened (#c48c28 → #7a5a1a), weight increased to 600
- Terrain block removed from Praescriptor UI (power-based training makes terrain guidance irrelevant)
- Generated timestamp and page date use per-user timezone instead of UTC

### Fixed
- Doubled repeat count in swim and run prescriptions — `target_description` embedded rep count (e.g. "4×200m") while `repeats` field also carried it, producing "4×4×200m" in UI (fixes #24)
- Sleep trend check: `.slice(-3).filter()` could miss poor nights if recent records lacked sleep data; now `.filter().slice(-3)` ensures the 3 most recent with sleep data are checked

### Added (prior)
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
- **Cross-training strain assessment** (`src/engine/cross-training-strain.ts`) — three-tier cascade for weight training and climbing activities (issues #17–23)
  - Activity classification: `CROSS_TRAINING_TYPES` (WeightTraining, RockClimbing, IndoorClimbing) with `isCrossTraining()` and `findTodayCrossTraining()` helpers
  - Tier 1: In-session HRV strain from R-R intervals — `flattenHrvStream()`, `computeRmssd()`, RMSSD vs rolling baseline (lower = harder)
  - Tier 2: `session_rpe` strain (duration × RPE) vs rolling 10-activity baseline with absolute fallback thresholds (>200 moderate, >400 hard)
  - Tier 3: Unknown strain → prescription blocked until user provides RPE via MCP tool
  - `CrossTrainingStrain` result type with source tracking (hrv/session_rpe/awaiting_input)
- Extended `ActivitySummary` with `session_rpe` and `kg_lifted` fields (Garmin-computed, for weight training)
- Extended `WorkoutSuggestion` with `status` ('ready'/'awaiting_input') and `awaitingInput` metadata for cross-training gating
- Cross-training hard-session guard in `selectWorkoutCategory()`: moderate/hard weight sessions prevent back-to-back endurance intensity (issue #20)
- Same-day cross-training cap: hard → recovery, moderate → base, light → no cap (issue #21)
- Prescription gating: blocks endurance prescription when same-day cross-training has unknown strain, returns `awaiting_input` status (issue #22)
- `submit_cross_training_rpe` MCP tool: accepts RPE (1–10) for a cross-training activity, writes to intervals.icu, enables re-running suggest_workout
- Vigil wellness injury write: `PUT /athlete/{id}/wellness/{date}` with `injury` field — severity 2 → Niggle (2), severity 3 → Poor (3), never 4 (Injured) automatically
- Stryd RPE as hard-session signal: Vigil metrics' `strydRpe` ≥ 7 augments `perceived_exertion` on running activities, feeding into `isHardSession()` detection
- 256 unit and integration tests covering the full engine pipeline, Vigil (FIT parsing, Duo bilateral, DB, metrics, baselines, scoring, integration, rendering), cross-training strain (classification, HRV, session_rpe, cascade), workout-selector (guard, cap), web prescriptions, Stryd client, enricher, intervals.icu format, send dedup, and invocations
- Praescriptor multi-user support: URL-based routing (`/ze/`, `/pam/`) with per-user intervals.icu API keys, sport selections, and feature flags (deity invocations, Stryd enrichment). Per-user prescription cache, send dedup, and graceful 503 when a user's API key is not configured. Single-card layout for users with one sport.
- Praescriptor "Send to Stryd" button: pushes running workout to the athlete's Stryd calendar via `POST /b/api/v1/workouts` (create) + `POST /b/api/v1/users/{id}/workouts` (schedule). Power targets expressed as CP% matching our zone model. Interval blocks use Stryd's repeat model with work+rest segment pairs. Server-side dedup with force-resend (deletes previous calendar entry). Visible only on run cards for users with `stryd: true`.

### Changed
- Praescriptor colour palette: dark theme replaced with "Andalucían" Mediterranean light theme — warm off-white background, sandstone cards, saffron/olive/terracotta accents
- Praescriptor UX overhaul: cards with white surface + soft shadow + coloured accent stripe, sport tag as filled pill, readiness score top-right, metadata as pill badges, segments with sport-coloured left border + hover highlight, send buttons fill on hover, stacked on mobile
- OAuth passphrase input: added `autocomplete="off"` to prevent password manager autofill overriding user input

### Fixed
- Vigil pipeline now runs for all running sport types (TrailRun, VirtualRun, Treadmill), not just "Run" — normalises to "Run" for Stryd data queries since Stryd stores all activities as "Run" regardless of intervals.icu classification
- Power source detection for Apple Watch + Stryd: Stryd watchOS app records `power_field: "power"` (lowercase) without CIQ stream markers, causing false Garmin correction (0.87×). Now detected via `external_id` containing "Stryd" + Apple Watch `device_name` pattern — no correction applied (fixes #8)
- Power source detection for Apple Watch without Stryd pod: Apple Watch native power (wrist accelerometer) was misclassified as "Garmin native with Stryd connected", applying a bogus 0.87 correction. Now detected as Apple Watch native — looks past the podless run to the most recent Stryd-powered run for power context, or falls back to HR-only if no Stryd history exists
- Stryd CP override now upgrades power source from "none" to "stryd" when the Stryd API returns a valid critical power — fixes prescription falling back to HR-only for athletes with Stryd credentials but no recent Stryd run data (e.g. ran with Apple Watch only)
- Vigil metrics and baselines now scoped per athlete (athlete_id column) — prevents multi-user data collision where Ze's existing Vigil data blocked Pam's 90-day backfill from running
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
