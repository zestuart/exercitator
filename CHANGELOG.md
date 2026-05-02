# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- MCP `suggest_workout` tool now applies the Stryd Critical Power override that Praescriptor and the HTTP API have always used. The MCP path was passing `undefined` as `strydCp` to the engine and falling back to intervals.icu's inferred FTP, so Claude conversations got different watt targets than Praescriptor's web UI for the same day's prescription. Tool registration now accepts an optional `StrydClient` (constructed once at startup from `STRYD_EMAIL` / `STRYD_PASSWORD`). All four prescription paths (MCP, Praescriptor, HTTP API status, HTTP API workouts/dashboard) now resolve CP through a shared `fetchStrydCpInput` helper.
- HTTP API `critical_power.watts` reports the FTP the engine actually prescribed against, not the raw Stryd CP. Previously `criticalPowerFromContext` preferred `strydCp` over `powerContext.ftp`, so when the new staleness override fired (engine chose intervals.icu rolling FTP because Stryd CP was stale and lower) the API would still report the stale Stryd watts — so a client checking `watts` against segment targets would see them disagree. Wire `source` enum still distinguishes `stryd_direct` (we did query Stryd) from `stryd_intervals`; the warning in `power_context.warnings` carries the override reason.

### Changed
- Stryd `getLatestCriticalPower` returns `{ criticalPower, createdAt }` (was bare watts) so callers can detect stale CP. The HTTP API `critical_power.updated_at` field now reports the real Stryd CP creation timestamp instead of `now()`.
- Engine FTP override applies a staleness guard: when Stryd CP is older than 30 days **and** intervals.icu's rolling FTP exceeds it by ≥ 5%, the engine uses the higher rolling FTP and emits a warning recommending a fresh CP test. Handles the post-layoff failure mode where Stryd's CP estimate hasn't seen enough hard efforts to revise upward, so the prescribed Z2 sweet-spot ends up at upper-Z1 absolute watts. Stale CP without a higher inferred FTP keeps Stryd CP but emits a softer "consider a CP test" warning.

### Added
- Two new run workout categories aligned to Stryd's published 5-zone model: **`progression`** (Stryd Z1 Easy → Z2 Moderate, three equal-duration thirds at 65–72%, 72–80%, 80–87% CP) and **`threshold`** (Stryd Z3 Threshold, 3 × 15 min sustained at 90–100% CP). The selector inserts `threshold` between `tempo` and `intervals` on the readiness ladder so a solid-but-not-peak day prescribes intensive-threshold work rather than jumping straight to VO2max. `WorkoutCategory` union, builder dispatch, terrain rules, staleness downgrade, Vigil downshift, sleep-debt cap, and same-day cross-training cap order all updated.
- `WorkoutSegment.stryd_zone` (1–5) — explicit Stryd power zone for export, distinct from `target_hr_zone`. Lets the engine carry HR-zone (for the safety cap UI) and Stryd-zone (for the workout export) independently, since the two don't always align under the new mapping.
- `isValidIntervalsId` (`src/api/validate.ts`) — already lived here; now also referenced from the threshold/progression flow via the cache-key allowlist.
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
- Page-level readiness score in the Praescriptor header (replaces per-card duplicates). Whole-athlete metric appears once below the date row in gold accent.

### Changed
- Run power zones realigned to Stryd's published 5-zone model. Engine categories now map onto Stryd zones as follows:

  | Engine category | Stryd zone | % CP |
  |---|---|---|
  | recovery | Z1 Easy (low) | 65–75% |
  | base | Z1 Easy | 65–80% |
  | long | Z1 Easy | 65–80% with optional Z2 Moderate pickup |
  | progression *(new)* | Z1 Easy → Z2 Moderate | thirds: 65–72 / 72–80 / 80–87% |
  | tempo | Z2 Moderate (sweet-spot) | 80–90% |
  | threshold *(new)* | Z3 Threshold | 90–100% |
  | intervals | Z4 Interval (VO2max) | 100–115% |

  Sweet-spot tempo replaces the previous "tempo = 80–90% CP" — Stryd labels this band "Extensive Threshold Stimulus" and reserves the term *threshold* for sustained 90–95% CP work, now its own category. Intervals jumped from 90–105% to true VO2max territory at 100–115% so the Z3/Z4 distinction becomes prescriptive rather than nominal. Stryd-format (`src/web/stryd-format.ts`) also gained an explicit `RECOVERY_PCT` band (sub-Z1, 0–65%) so warm-up walks and inter-rep recoveries don't get pushed up into a jog target by the new Z1 floor.
- Run power zones tuned for runnability (2026-04-29 morning, superseded by Stryd 5-zone alignment later the same day): Z1 recovery <70% CP, Z2 base/long 70–80%, Z3 tempo 80–90%, Z4 intervals 90–105%. See above for the final values.
- `runVigilBackfillIfNeeded` now does an incremental 14-day Stryd sync once the initial 90-day baseline exists, debounced to once per UTC day per athlete. Garmin + Stryd CIQ runs that arrive after the seed (the enricher only catches Apple Watch low-fidelity uploads) now reach `vigil_metrics` on the next prescription render instead of being silently skipped forever.
- Vigil baseline-building gate now counts activities over a **60-day** lookback window (was 30 days). The metric baseline still computes statistics over the most recent 30 days — the wider count just stops athletes who run 4×/month from being stuck at "4/5 activities" indefinitely while their baseline is statistically usable. Building summary updated to include the count-window duration. (`src/engine/vigil/index.ts`)
- All run warm-ups now uniformly carry `stryd_zone: 1` (Stryd Z1 Easy 65–80% CP). Tempo / threshold / intervals / long / progression already did; recovery and base warm-ups had been bare and fell through to the sub-Z1 RECOVERY_PCT band. Cool-downs deliberately stay bare so they remain in the walk-fade band.
- Praescriptor renderer's segment zone-guide pill now derives watt bands from `stryd_zone` rather than a stale FTP-percent table keyed off `target_hr_zone`. Eliminates the case where the engine prescription said "Stryd Z1 Easy 178–219W" while the same segment's pill said "Z2 (151–206W)".
- Praescriptor `buildRationale` is now sport-aware. Run rationales keep Stryd-zone vocabulary ("Sweet-spot tempo (Stryd Z2 Moderate)…"); swim rationales drop Stryd references entirely since Stryd doesn't apply to swim. Sport-agnostic categories (rest/recovery/base/long) are unchanged.
- Card title for sweet-spot tempo run is now "Sweet-spot Tempo Run" (was "Threshold Tempo Run") — distinguishes it from the new `threshold` run category at Stryd Z3.
- Send-to-intervals.icu and send-to-Stryd dedup migrated from in-memory Maps to SQLite persistence (survives container restarts)
- Vigil 90-day Stryd FIT backfill: helper lifted from Praescriptor to `src/engine/vigil/backfill.ts` so the HTTP API's `/status` and `/dashboard` can fire-and-forget on first call. Per-athlete in-flight Set guards against concurrent kicks.
- Deployment target moved from Arca Ingens (QNAP, decommissioned 2026-04-04) to Cogitator (Mac Mini M4 Pro). Same tarball flow, different host (`dominus@cogitator.tail7ab379.ts.net`, port 22, key auth) and home path (`~/Container/exercitator/`). See `praefectura/docs/cogitator-operations.md`.
- `docker-compose.yml`: `exercitator-data` volume now declared `external: true` to match its actual lifecycle and silence the compose warning.

### Security
- URL-encode caller-supplied activity IDs before path-interpolating them into intervals.icu API URLs. Closed a SAST-flagged path traversal in the Praescriptor `/api/compliance/confirm` handler (`src/web/routes.ts`) where a malicious tailnet client could traverse the upstream API path; the same pattern in the MCP `submit_cross_training_rpe` tool (`src/tools/suggest.ts`) was hardened pre-emptively.
- HTTP API response cache now bounded **per user** — the store is a `Map<userId, Map<key, Entry>>` with each inner map capped at `EXERCITATOR_API_CACHE_MAX_ENTRIES` (default 64). One user spamming distinct keys can no longer evict another user's entries, plus a 60 s background prune drops already-expired entries. Closes both the original unbounded-memory vector and the cross-user cache-flooding vector that surfaced after `tz` joined the cache key (`src/api/cache.ts`, `src/api/server.ts`).
- HTTP API bearer matching is now constant-time across all three components (`client`, `userId`, `token`) — every configured key receives the same comparison work regardless of whether the bearer is well-formed, so a remote caller can't time the difference between "(client, userId) matches but token is wrong" and "no key with this (client, userId) is configured" (`src/api/auth.ts`).
- Per-user token-bucket rate limiting on Praescriptor and the HTTP API (60 reads/min, 10 writes/min by default; configurable via `EXERCITATOR_RATE_LIMIT_READ` / `_WRITE`, set to `0` to disable). Returns `429` with `Retry-After` and a JSON envelope. Read and write buckets are independent so a poll loop doesn't starve calendar pushes (`src/rate-limit.ts`).
- HTTP API `/workouts/suggested` cache key now allowlists the `sport` query parameter to {`auto`, `Run`, `Swim`} and includes a strictly-validated IANA `tz` so two clients on different sides of the date line don't share a stale "today" suggestion (`src/api/handlers/workouts.ts`).
- Timezone inputs (Praescriptor `tz` cookie, HTTP API `tz` query, intervals.icu profile timezone) are now validated against `Intl.DateTimeFormat` before reaching `localDateStr` or any cache key — closes a Medium cache-flooding vector via crafted `tz` values and a Low DoS where a malformed cookie raised an unhandled `RangeError` 500 (`src/engine/date-utils.ts` exports `isValidTimezone`; consumed by `src/api/handlers/workouts.ts` and `src/web/routes.ts`).
- intervals.icu activity IDs received from clients (`POST /api/compliance/confirm`, `POST /api/users/:userId/cross-training/:activityId/rpe`, `GET /api/users/:userId/workouts/iv-:id`) are now allowlisted to `[A-Za-z0-9_-]{1,64}` before path interpolation. `encodeURIComponent` on the path already neutralised the protocol-relative SSRF pattern (`%2F%2F` survives URL parsing), but the strict allowlist returns 400 for clearly-malformed input rather than a 502 from the upstream and aligns with the date-string regex pattern documented in CLAUDE.md (`src/api/validate.ts`).
- Praescriptor `POST /:userId/api/compliance/backfill` and `GET /:userId/api/compliance/trending` now clamp the `days` query parameter to `[1, 730]` (≈ 2 years). The backfill issues one upstream call per day with a send event, so an unbounded value let an authenticated tailnet caller burn intervals.icu quota and CPU at will (`src/web/routes.ts`).
- Praescriptor HTML responses ship with defence-in-depth headers — Content-Security-Policy (allowing inline styles/scripts and Google Fonts only), Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options, Referrer-Policy. Base headers (everything except CSP) apply to every Praescriptor response (`src/web/security-headers.ts`, `src/web/routes.ts`).
- Removed the truncated Tailscale auth-key prefix from `CLAUDE.md` — the value lives only in `.env` and `praefectura/docs/tailscale.md` so a partial leak can't seed an attacker's recovery work.

### Fixed
- Swim `threshold_pace` was read as seconds-per-metre but intervals.icu actually stores it as metres-per-second. The DSW computed `cssPer100m = threshold_pace * 100` which collided near `x ≈ 1.0` and only diverged once a slower swimmer's value moved the pace target the wrong direction. Replaced with `100 / threshold_pace`, added regression tests covering 0.94 m/s and null/zero, and documented the m/s convention in code comments. Existing tests asserting `1:37/100m` for `threshold_pace = 0.97` were also updated to `1.0309 m/s` with corrected arithmetic. Running pace builders use a similar suspect pattern but are dead code (Stryd users have `Run.threshold_pace = null`) — flagged in `lessons.md` for audit before non-Stryd runner onboarding.
- FORM copy button on swim card no longer flips to "✗ Failed — try again" after a successful clipboard copy. The button shares `class="send-btn"` for visual styling but the general send handler's selector excluded only `.stryd-btn`, so it also tried `fetch('/api/send/undefined')` and overwrote the "✓ Copied" state with the failed-fetch error. Selector now also excludes `.form-btn`.
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
