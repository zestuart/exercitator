# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This file is Claude's operating manual. Keeping it accurate is not busywork — it is
> self-care. An outdated CLAUDE.md leads to wrong assumptions, missed context, and
> compounding errors. Treat this document and its subsidiaries as first-class code
> artifacts: review them, update them, and trust them only when they reflect reality.

## Project

**Name**: Exercitator + Praescriptor
**Description**: MCP bridge for Claude to access the intervals.icu API, plus a web UI serving daily workout prescriptions. Hosted on Arca Ingens via Docker and Tailscale.
**Domains**: `exercitator.tail7ab379.ts.net` (MCP, funnel — public) · `praescriptor.tail7ab379.ts.net` (web UI, serve — tailnet only)
**Repository**: https://github.com/zestuart/exercitator

## Stack

- **Runtime**: Node.js + TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Database**: SQLite (via `better-sqlite3`) — local caching/state
- **Linter/Formatter**: Biome
- **Type checking**: `tsc --noEmit`
- **Test runner**: Vitest
- **Containerisation**: Docker + Docker Compose
- **Networking**: Tailscale funnel (MCP, public) + Tailscale serve (Praescriptor + HTTP API, tailnet-only) on Arca Ingens
- **External API**: [intervals.icu](https://intervals.icu) REST API
- **HTTP API**: bearer-scoped REST surface for native clients (Excubitor iOS/watchOS) — port 8643, tailnet-only

## Architecture

```
src/
  index.ts              — entry point, transport selection, session management, HTTP API listener wiring
  intervals.ts          — intervals.icu REST client (Basic auth over HTTPS)
  auth.ts               — OAuth middleware (PKCE + passphrase + signed tokens)
  users.ts              — shared user profile registry (ze, pam) consumed by Praescriptor + HTTP API
  db.ts                 — SQLite cache + enrichment tracking + Vigil metrics/baselines + compliance tables (better-sqlite3, WAL mode)
  compliance/
    types.ts            — compliance tracking type definitions
    assess.ts           — segment-to-lap matching, binary compliance scoring
    persist.ts          — DB read/write for prescriptions, send events, assessments, aggregates
    aggregate.ts        — weekly/monthly rollup computation, trending queries
  stryd/
    client.ts           — Stryd PowerCenter API client (auth, list activities, download FIT, post-run report fields, create/schedule/delete workouts)
    enricher.ts         — detect low-fidelity activities, match to Stryd, upload full FIT
  tools/
    athlete.ts          — get_athlete_profile, get_sport_settings
    activities.ts       — list_activities, get_activity, get_activity_streams, get_power_curve
    wellness.ts         — get_wellness, update_wellness
    events.ts           — list_events, create_event
    suggest.ts          — suggest_workout, submit_cross_training_rpe (DSW engine + RPE submission)
    compliance.ts       — get_compliance_summary, get_compliance_detail
  engine/
    types.ts            — shared TypeScript interfaces
    date-utils.ts       — timezone-aware date string utility (localDateStr)
    readiness.ts        — readiness score (0–100) from wellness + activity data
    power-source.ts     — Stryd vs Garmin vs HR-only detection, load metric selection
    sport-selector.ts   — Run vs Swim selection from load deficit + monotony rules
    staleness.ts        — sport-specific threshold staleness detection + category ceiling
    cross-training-strain.ts — cross-training classification, three-tier strain cascade (HRV/session_rpe/unknown)
    workout-selector.ts — category selection (rest/recovery/base/tempo/intervals/long) + cross-training guard + same-day cap
    terrain-selector.ts — flat/rolling/trail/pool guidance per category + recent terrain
    workout-builder.ts  — structured segment generation per sport × category
    suggest.ts          — top-level orchestrator: fetchTrainingData, suggestWorkoutFromData, suggestWorkoutForSport, suggestWorkout
    vigil/
      types.ts          — Vigil interfaces, metric weights, Stryd FIT field constants
      fit-parser.ts     — FIT file parsing, Stryd developer field extraction, per-activity metric computation
      metrics.ts        — scoreable metric extraction from VigilMetrics, field-to-metric-name mapping
      baseline.ts       — 30-day rolling mean + stddev, 7-day acute window, min activity thresholds
      scorer.ts         — z-score deviation scoring, directional concern mapping, composite severity 0–3
      index.ts          — pipeline orchestrator: check data → baselines → score → alert
      backfill.ts       — 90-day Stryd FIT backfill + incremental per-activity processing
  web/
    server.ts           — Praescriptor HTTP entrypoint (port 3847), per-user IntervalsClient map
    routes.ts           — route handler (/:userId/, /:userId/api/*, /health)
    prescriptions.ts    — per-user prescription generator with day-level cache
    send.ts             — push workout to intervals.icu calendar with per-user dedup
    send-stryd.ts       — push running workout to Stryd calendar (create + schedule + dedup)
    stryd-format.ts     — WorkoutSegment[] → Stryd blocks (CP% power targets)
    intervals-format.ts — WorkoutSegment[] → intervals.icu workout text
    form-format.ts      — WorkoutSuggestion → FORM swim goggles Script text
    invocations.ts      — deity invocations via Anthropic API with static/plain fallbacks
    render.ts           — SSR HTML renderer (inlined CSS + JS, no framework)
  api/
    server.ts           — HTTP API listener (port 8643, co-resident with MCP; started only when EXERCITATOR_API_KEYS set)
    router.ts           — dispatch /api/users/:userId/* to handlers with bearer-userId scoping
    auth.ts             — bearer middleware (<client>:<userId>:<token> constant-time compare)
    errors.ts           — JSON error envelope + jsonResponse helper
    types.ts            — wire DTOs (independent of engine internals)
    payload.ts          — engine → DTO mappers (readiness bands, polymorphic segment targets, Vigil → injury_warning)
    cache.ts            — per-user response cache (default 300s, keyed by userId+endpoint)
    handlers/
      health.ts         — GET /api/health (unauthenticated, 60s-cached upstream probe)
      status.ts         — GET /api/users/:userId/status (readiness, CP, fitness/fatigue/form)
      workouts.ts       — GET /workouts/{today,suggested,:id} (engine-backed, polymorphic targets)
      compliance.ts     — GET /compliance/{summary,detail}
      dashboard.ts      — GET /dashboard (status + today + suggested aggregate)
      cross-training.ts — POST /cross-training/:activityId/rpe (unblocks 409 awaiting_input)
```

### Key patterns

- **Per-session McpServer**: The MCP SDK allows only one transport per `McpServer`. In streamable-http mode, each session gets its own `McpServer` + `StreamableHTTPServerTransport` instance, tracked in a session map. Sessions are capped at 100 and pruned after 5 minutes idle.
- **Dual transport**: `MCP_TRANSPORT=stdio` for local dev (`claude mcp add`), `MCP_TRANSPORT=streamable-http` for Docker/funnel production.
- **OAuth middleware** (`src/auth.ts`): RFC-compliant (9728, 8414, 7591). PKCE S256 (SHA-256 hash, not HMAC) + client_credentials grants. Passphrase-gated authorisation. Self-validating HMAC-SHA256 signed tokens with version-based revocation. Per-IP rate limiting and lockout. Redirect URIs validated against allowlist (`https://claude.ai/api/mcp/auth_callback`, `http://localhost`, `http://127.0.0.1`). Request body capped at 64 KiB. Registration returns `token_endpoint_auth_method: "none"` for browser-based auth_code flow.
- **Claude Desktop compatibility**: OAuth endpoints accept both `/oauth/*` and `/*` paths (e.g. `/authorize` and `/oauth/authorize`). The MCP handler accepts both `/` and `/mcp` — Claude Desktop POSTs to `/` after OAuth.
- **Tool registration**: Each tool module exports a `register*Tools(server, client)` function. Tools use Zod schemas for input validation. Date parameters enforce `YYYY-MM-DD` regex. Date-only strings are appended with `T00:00:00` before forwarding to intervals.icu (which requires datetime format).
- **DSW engine** (`src/engine/`): Pure computation over JSON — no external dependencies. Pipeline: power source detection → Stryd CP override (if available) → readiness scoring → cross-training strain assessment → sport selection → staleness check → workout category (with cross-training guard + same-day cap + staleness ceiling + HRV guard + sleep debt cap) → terrain selection → structured segments with dual-target prescription (power + HR cap). Staleness tiers (normal/moderate/severe) apply pace buffers and can force HR-only targets for return-to-sport safety. Staleness also requires ≥ 3 sessions in the 14-day window to consider an athlete "current" — a single session after a long break gets moderate tier (return-to-sport). Sleep debt (3+ recent poor nights) caps category at base regardless of readiness score. All date computations use `localDateStr(date, tz)` for per-user timezone awareness — "today" is correct regardless of server UTC offset. Testable in isolation with fixture data.
- **Power source detection** (`src/engine/power-source.ts`): Supports three ecosystems: Stryd CIQ (Garmin, `power_field: "Power"`), Stryd native (Apple Watch via HealthFit, `power_field: "power"` with `external_id` containing "Stryd"), and Garmin native. Non-Garmin detection uses `device_name` pattern (`/^Watch\d/` for Apple Watch, `"STRYD"` for enriched uploads) + case-insensitive `external_id` containing "stryd" to avoid false Garmin correction. `getActivityLoad()` correctly uses `power_load` for both CIQ and native Stryd recordings. **FTP source**: when Stryd credentials are available, FTP is queried directly from Stryd's CP history API (`/cp/history`) — this is the authoritative value from the foot pod. Without Stryd credentials, FTP falls back to `icu_rolling_ftp` or `icu_ftp` from intervals.icu activity data.
- **Hard session detection** (`src/engine/workout-selector.ts`): Multi-signal `isHardSession()` — RPE ≥ 7 (including Stryd RPE augmented from vigil_metrics), `icu_intensity > 85` (normalised power as % of FTP), HR Z4+ > 25% of session time, load > 0.7 × sportCtl. Multiple signals prevent back-to-back intense prescriptions when individual metrics are missing. A `hardSessionGuard` flag prevents HR zone distribution rebalancing from overriding the protective category downshift.
- **Cross-training strain** (`src/engine/cross-training-strain.ts`): Three-tier cascade for weight training and climbing activities (WeightTraining, RockClimbing, IndoorClimbing). Tier 1: in-session HRV (RMSSD from R-R intervals vs rolling baseline; lower RMSSD = harder). Tier 2: `session_rpe` (duration × RPE from Garmin) vs rolling 10-activity baseline with absolute fallback (>200 moderate, >400 hard). Tier 3: unknown → prescription blocked until user provides RPE. Feeds into `selectWorkoutCategory()` via two mechanisms: cross-training hard-session guard (moderate/hard weight session in last 2 days prevents intensity) and same-day cap (hard → recovery, moderate → base). Prescription gating: if any same-day cross-training has unknown strain, `suggestWorkoutFromData()` returns early with `status: 'awaiting_input'` and the `submit_cross_training_rpe` MCP tool allows the user to unblock it.
- **Stryd FIT enrichment** (`src/stryd/`): Optional pipeline that detects low-fidelity Apple Watch + Stryd activities (missing CIQ developer fields), downloads the full FIT from Stryd PowerCenter API, uploads to intervals.icu, and deletes the original HealthFit activity (deletion prevents duplicate load and analysis pipeline confusion). Runs before prescription generation. Tracked in SQLite (`stryd_enrichments` table) to prevent re-processing. Graceful degradation: skipped entirely if `STRYD_EMAIL`/`STRYD_PASSWORD` not set. Failures never break prescriptions.
- **Stryd critical power as FTP** (`src/stryd/client.ts`): When Stryd credentials are available, the latest CP from `/cp/history` overrides intervals.icu's inferred FTP for running prescriptions. This is the authoritative value — measured directly by the foot pod, not inferred from activity data. Only applies when `detectPowerSource()` identifies Stryd as the active power source. Swim FTP is unaffected.
- **Vigil** (`src/engine/vigil/`): Biomechanical injury warning system. Detects abnormal deviations in Stryd running metrics from the athlete's personal 30-day baseline using z-score deviation scoring. Data sourced directly from Stryd FIT files (not intervals.icu streams API) — avoids rate limits and provides access to all developer fields. 90-day deep backfill on first run, then incremental per-activity extraction. Metric weights reflect shoe-mounted IMU reliability: GCT/LSS 1.0, Form Power Ratio 0.8, ILR 0.5 (noisier from foot mount), drift metrics 0.8–1.0. Composite-only alerting: severity 0–3 requiring 2+ metrics to deviate simultaneously. Severity ≥ 2 triggers protective downshift in workout-selector; severity ≥ 2 writes to intervals.icu wellness `injury` field (2=Niggle, 3=Poor, never 4=Injured automatically). Runs for all running sport types (Run, TrailRun, VirtualRun, Treadmill) — normalises to "Run" for Stryd queries since Stryd stores all activities as "Run" regardless of intervals.icu classification. `StrydActivity` extended with `rpe`, `feel`, `surface_type` from post-run reports. **Stryd Duo**: bilateral data arrives as balance percentages (left foot share, 50% = symmetric), not separate L/R streams. Fields: `Leg Spring Stiffness Balance`, `Vertical Oscillation Balance`, `Impact Loading Rate Balance`, `stance_time_balance`. Asymmetry = `|balance - 50| × 2`. Mixed-pod handling: bilateral baselines computed from Duo activities only (min 5); unilateral baselines from all activities. Stored in SQLite: `vigil_metrics` (per-activity summaries with bilateral columns) + `vigil_baselines` (rolling 30d + 7d acute windows). Full spec: `phase2/injury-warning-spec.md`.
- **Stale session handling**: POSTs with an unknown `mcp-session-id` return HTTP 404 with a JSON-RPC error. This prevents the SDK from creating a fresh transport for non-initialize requests after container restarts.
- **Compliance tracking** (`src/compliance/`): Compares prescribed workouts against actual execution. Prescriptions and send events are persisted to SQLite on generation/send. Assessment uses intervals.icu lap data matched sequentially to flattened prescription segments. Binary pass/fail per metric (HR zone, power, pace — no tolerance; duration has 15% tolerance for lap timing). Traffic light UI (green/amber/red dots) on Praescriptor segments. Confirmation buttons for yesterday's sent prescriptions. Aggregated trends (weekly/monthly) answer: compliance over time, deviation by category, consistent overshoot patterns. MCP tools: `get_compliance_summary`, `get_compliance_detail`. Long-term goal: self-correcting prescriptions from systematic deviation data.
- **SQLite cache**: TTL-based cache in `data/exercitator.db`. Used for infrequently-changing data (athlete profile), Stryd enrichment tracking, Vigil biomechanical metrics/baselines, and compliance tracking. WAL mode for concurrent reads. DB path configurable via `EXERCITATOR_DB_PATH` env var (supports `:memory:` for tests).
- **Praescriptor** (`src/web/`): Separate container, same codebase. Multi-user via URL-based routing: `/:userId/` (e.g. `/ze/`, `/pam/`). User profiles (`src/web/users.ts`) define per-user sports, deity invocations, Stryd enrichment, and API key env var. Per-user `IntervalsClient`, prescription cache, and send dedup. Users without a configured API key get 503. `GET /` redirects to default user (`/ze/`). Imports the DSW engine directly — no network calls between containers. **Timezone**: resolved per request — browser `tz` cookie (set via `Intl.DateTimeFormat`) → intervals.icu athlete profile → UTC fallback. Deity invocations generated via Anthropic API with static fallbacks (or plain text for non-deity users). Opening invocation per card, Apollo's closing rendered once at page bottom (centred). "Send to intervals.icu" with server-side dedup. "Copy FORM Text" on swim cards copies a FORM goggles Script-compatible workout description to the clipboard (stroke abbreviations, effort levels, rest intervals — no zones or pace targets). Every segment shows a zone guide: watts for running (derived from FTP zones), HR bpm for swimming (from intervals.icu HR zones). Z1 uses `<` threshold format, higher zones show ranges. Warnings shared between both prescriptions (e.g. HRV alerts) rendered once above cards; sport-specific warnings remain per card. Single-card layout when a user has only one sport. Mediterranean light theme ("Andalucían"): warm off-white `#f4efe6` background, white `#fffcf7` card surface with soft shadow, sport-coloured accent stripe + left-bordered segments, metadata as pill badges, readiness score top-right. CSS custom property `--card-accent` per card drives segment borders, duration colour, sport tag fill, and button accents. **intervals.icu workout format**: swim workouts use `mtr` for metres (not `m` which means minutes), `/100m` for pace denominators (not `/100mtr` — only bare distances use `mtr`), `Pace` suffix on pace targets, blank lines around repeat blocks, `50%` for rest steps. Swim steps with pace targets also include HR targets so the chart renders in any view mode. Rest steps (`20s 50%`) rendered between non-repeat swim segments. Swim warm-ups broken into individual 100m drill steps (free, kick, pull) with 10s rest gaps.

## Philosophy

These principles govern all development work in this project. They are not
guidelines — they are constraints.

1. **Security is non-negotiable.** A missed deployment is always better than an
   insecure deployment. Every change passes a SAST scan before reaching production.
   No exceptions, no overrides, no "we'll fix it later".

2. **Tests grow with the project.** When you write code, you write tests. When you
   find a bug, you write a test that catches it. When a deployment fails, you write
   a test that would have caught it. The test suite is a ratchet — it only moves
   forward.

3. **Documentation is code.** This file, the changelog, user-facing docs, and API
   references are maintained with the same rigour as source code. Stale documentation
   is a bug. Claude auto-maintains all documentation — not by flagging staleness, but
   by fixing it.

4. **Lessons are permanent.** Every failure, surprise, or hard-won insight is recorded
   in `lessons.md`. This prevents the same mistake from happening twice, across
   conversations, across contributors, across time.

5. **Never commit secrets.** API keys, tokens, passwords, and credentials live in
   `.env` and nowhere else. Not in source code, not in commit messages, not in
   comments, not in documentation. The `.env` file is never committed. This matters
   because secrets in git history are effectively public — they persist in every
   clone, every fork, every backup, forever. Even "private" repositories get shared,
   transferred, and compromised. One leaked key can mean unauthorised access,
   unexpected bills, or a full breach.

## Development Workflow

Every change follows this sequence. No steps are optional.

```
Write code → Run tests (/test) → Update docs → Update CHANGELOG → Deploy (/deploy)
```

The `/deploy` skill enforces this by running pre-flight checks (tests + SAST) before
any code reaches production. If you are not deploying, still run `/test` after changes.

### When to update documentation

- **CLAUDE.md**: When you add a new pattern, dependency, convention, or architectural
  decision. When you discover that existing documentation is wrong.
- **Subsidiary files**: When a CLAUDE.md section exceeds ~50 lines, split it into a
  subsidiary file and link it from the index. Use your judgement — the goal is
  efficient retrieval, not arbitrary size limits.
- **CHANGELOG.md**: Every user-visible change, every deploy. Follow Keep a Changelog
  format (see below).
- **User-facing docs**: README, API docs, guides — update them as part of the change,
  not as a separate task.
- **lessons.md**: After every bug, failed deploy, unexpected behaviour, security
  finding, or any insight that would help future development.

## Document Management

### The blooming pattern

This CLAUDE.md starts small. As the project grows, sections will need more detail
than fits comfortably in one file. When that happens, split the section into its own
file and replace the section content with a link.

Maintain an index file (`CLAUDE-INDEX.md`) listing all subsidiary files with one-line
descriptions. This index serves both Claude and human developers.

Example structure after blooming:
```
CLAUDE.md              — core rules, workflow, conventions (this file)
CLAUDE-INDEX.md        — index of all subsidiary files
architecture.md        — file map, module responsibilities, data flow
decisions.md           — architectural and technical decisions with rationale
lessons.md             — post-mortem log (auto-maintained)
security.md            — security surfaces, acknowledged risks, remediation history
```

### Changelog

Maintain `CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com/) format
with [Semantic Versioning](https://semver.org/):

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- New features

### Changed
- Changes to existing features

### Fixed
- Bug fixes

### Security
- Security-related changes (always document these)

### Removed
- Removed features
```

Move `[Unreleased]` items to a versioned section on each release. Security changes
are always documented, even if they are internal refactors with no user-visible effect.

### Lessons learned

`lessons.md` is a chronological post-mortem log. Claude maintains this proactively —
every time something unexpected happens, a bug is found, a deployment fails, or a
security issue is discovered, add an entry:

```markdown
## YYYY-MM-DD — Brief title

**What happened**: Factual description of the issue.
**Root cause**: Why it happened.
**Fix**: What was done to resolve it.
**Prevention**: What test, check, or process change prevents recurrence.
```

This file is append-only. Do not edit or remove past entries.

## Security

### Credential management

All credentials live in `.env` at the project root. This file is:
- Listed in `.gitignore` (verified by /init)
- Never committed, logged, or echoed
- The single source of truth for all API keys, tokens, and secrets

A `.env.example` file documents required variables with placeholder values. This file
IS committed and kept in sync with `.env`.

```bash
# .env.example — commit this, not .env
GEMINI_API_KEY=your-gemini-api-key-here          # Required for SAST scans
INTERVALS_ICU_API_KEY=your-intervals-icu-api-key  # Required for intervals.icu access (Ze)
INTERVALS_ICU_API_KEY_PAM=pam-api-key-here       # Optional: Pam's intervals.icu access
TAILSCALE_AUTH_KEY=your-tailscale-auth-key         # Required for Docker deployment
MCP_OAUTH_CLIENT_ID=exercitator                   # OAuth client ID
MCP_OAUTH_CLIENT_SECRET=<openssl rand -hex 32>    # OAuth token signing secret
MCP_OAUTH_AUTHORIZE_PASSPHRASE=<your passphrase>  # Human-memorable auth gate
MCP_TOKEN_VERSION=1                               # Increment to revoke all tokens
ANTHROPIC_API_KEY=<your-anthropic-api-key>         # Optional: deity invocations in Praescriptor
STRYD_EMAIL=<your-stryd-email>                    # Optional: Ze's Stryd FIT enrichment
STRYD_PASSWORD=<your-stryd-password>              # Optional: Ze's Stryd FIT enrichment
STRYD_EMAIL_PAM=<pam-stryd-email>                 # Optional: Pam's Stryd FIT enrichment
STRYD_PASSWORD_PAM=<pam-stryd-password>           # Optional: Pam's Stryd FIT enrichment
QNAP_PASSWORD=<arca-ingens-password>              # SSH to Arca Ingens (dominus@192.168.4.180:2022)
```

### SAST scanning

Every deployment includes a SAST scan using Gemini 2.5 Pro (a different model family
from Claude, providing independent security review). The scan:

- Runs in `diff` mode during deploys (only changes since last baseline)
- Runs in `full` mode on demand via `/sast`
- Tags clean scans as `sast-baseline-YYYY-MM-DD` for incremental tracking
- **Blocks deployment on findings** — findings must be fixed or explicitly accepted

The SAST scanner (`scripts/sast_scan.py`) is zero-dependency (Python stdlib only) and
reads `GEMINI_API_KEY` from `.env` or environment.

### Security surfaces

- **intervals.icu API key**: Stored in `.env`, used server-side only. Leaking it grants read/write access to the user's training data.
- **Tailscale funnel exposure**: The MCP server is publicly reachable via the funnel. All endpoints must validate requests — no open proxy behaviour.
- **SQLite injection**: Any user-supplied parameters used in SQL queries must be parameterised.
- **MCP tool input validation**: All tool parameters received from Claude must be validated before forwarding to intervals.icu.
- **Anthropic API key**: Optional, used server-side only by Praescriptor for deity invocations. Never sent to the client. Stored in `.env`.
- **Praescriptor access**: Tailnet-only via `tailscale serve` (no funnel). No authentication layer — Tailscale provides device-level access control.
- **Stryd credentials**: Optional `STRYD_EMAIL`/`STRYD_PASSWORD` in `.env`, used server-side only by Praescriptor for FIT enrichment. Token is short-lived and held only in memory during enrichment. Never exposed via web UI or MCP tools.
- **Docker secrets**: Container environment variables must not be logged or exposed via health/debug endpoints.
- **OAuth redirect URI**: Validated against allowlist (`https://claude.ai/api/mcp/auth_callback`, localhost). Do not add arbitrary URIs.
- **Session exhaustion**: HTTP sessions are capped at 100 with 5-minute idle timeout to prevent memory exhaustion DoS.
- **Request body size**: OAuth endpoints limit request bodies to 64 KiB.
- **HTTP API bearer keys**: `EXERCITATOR_API_KEYS` holds `<client>:<userId>:<token>` triples. Tokens are compared in constant time. Each key is scoped to one userId — cross-user reads return 403 before the user profile is loaded. Tailnet-only exposure means only tailnet members can reach the listener at all.
- **HTTP API body size**: POST bodies (cross-training RPE) are capped at 1 KiB; the listener also enforces a 1 MiB global body cap.

## Testing

```bash
npx biome check .              # Lint + format check
npx tsc --noEmit               # Type check
npx vitest run                 # All tests
npx vitest run src/tools       # Tests in a specific directory
npx vitest run -t "tool name"  # Single test by name
```

The `/test` skill runs all three in sequence.

### Test growth protocol

When adding new functionality:
1. Write tests for the new code path
2. Run the full suite to verify no regressions

When fixing a bug:
1. Write a test that reproduces the bug (it should fail)
2. Fix the bug (test should now pass)
3. Add a lessons.md entry

When a deployment or production issue occurs:
1. Write a test that would have caught it
2. Add a lessons.md entry with the prevention section referencing the new test

## Deployment

- **Target**: Cogitator (Mac Mini M4 Pro) — `dominus@cogitator.tail7ab379.ts.net` (tailnet) or `dominus@192.168.4.192` (LAN). Key auth via `~/.ssh/id_ed25519`; password fallback in `.env` as `cogitatorPass`. Services migrated from Arca Ingens 2026-04-04.
- **Path on server**: `~/Container/exercitator/` (i.e. `/Users/dominus/Container/exercitator/`). `.env` lives here and is managed out-of-band.
- **Docker**: Colima VM, `DOCKER_HOST=unix:///Users/dominus/.colima/docker.sock`. Non-interactive SSH does not source `~/.zshrc` — wrap docker commands in `zsh -ic "..."`. Only `$HOME` is mounted into the VM; don't use `/tmp` for bind mounts or build contexts.
- **Method**: Tarball upload + `docker compose up -d --build`. Same pattern as Arca Ingens, different host/port/path.
- **Networking**: Tailscale serve (`exercitator.tail7ab379.ts.net`, funnel-enabled) → `exercitator-mcp:8642`; Tailscale serve (`praescriptor.tail7ab379.ts.net`, tailnet-only) → `praescriptor-web:3847`; Tailscale serve (`exercitator-api.tail7ab379.ts.net`, tailnet-only) → `exercitator-mcp:8643` (HTTP API, co-resident with MCP).
- **Branch**: `main` — deploy from main only.
- **Containers**: `exercitator-mcp` (MCP server + HTTP API on 8643) + `tailscale-exercitator` (funnel sidecar) + `praescriptor-web` (web UI) + `tailscale-praescriptor` (serve sidecar) + `exercitator-api-ts` (serve sidecar for HTTP API).
- **Volumes**: `exercitator-data` (SQLite), `exercitator-tailscale-state` (external), `praescriptor-tailscale-state` (external), `exercitator-api-tailscale-state` (external). Do not delete external volumes — Tailscale node identity lives in them. Pre-create the new API state volume on Cogitator once: `ssh dominus@cogitator.tail7ab379.ts.net 'zsh -ic "docker volume create exercitator-api-tailscale-state"'`.
- **Tailscale auth key**: exercitator family `tskey-auth-kqDKwGVavf...` (reusable, preauthorised). Works for all three sidecars. See `praefectura/docs/tailscale.md`.
- **Operations reference**: full Cogitator conventions in `github.com/zestuart/praefectura` (`docs/cogitator-operations.md`, `docs/exercitator.md`, `docs/tailscale.md`).

### Deploy procedure

```bash
# 1. Load cogitator password (only needed if key auth fails)
CP=$(grep '^cogitatorPass=' .env | cut -d= -f2-)

# 2. Tarball (exclude git, node_modules, .env, data, dist, phase2)
tar czf /tmp/exercitator.tar.gz --exclude='.git' --exclude='node_modules' \
  --exclude='dist' --exclude='data' --exclude='.env' --exclude='phase2' \
  --exclude='.claude/settings.local.json' .

# 3. Upload and extract (key auth)
scp /tmp/exercitator.tar.gz dominus@cogitator.tail7ab379.ts.net:~/Container/exercitator/
ssh dominus@cogitator.tail7ab379.ts.net \
  'cd ~/Container/exercitator && tar xzf exercitator.tar.gz && rm exercitator.tar.gz'

# 4. Unlock keychain, then rebuild (non-interactive SSH needs zsh -ic for docker)
ssh dominus@cogitator.tail7ab379.ts.net "security unlock-keychain -p '$CP' ~/Library/Keychains/login.keychain-db && \
  cd ~/Container/exercitator && zsh -ic 'docker compose up -d --build exercitator praescriptor'"

# 5. Verify services
curl -s https://exercitator.tail7ab379.ts.net/health
curl -s https://praescriptor.tail7ab379.ts.net/health
curl -s https://exercitator-api.tail7ab379.ts.net/api/health

# 6. Clean up
rm -f /tmp/exercitator.tar.gz
```

### Pre-flight sequence (enforced by /deploy)

1. **Lint + type check** — language-appropriate static analysis
2. **Test suite** — all tests must pass
3. **Secret scan** — verify no credentials in staged files
4. **SAST scan** — Gemini security review of changed files
5. **Documentation check** — CHANGELOG.md updated, docs current
6. **Commit** — descriptive message with co-author attribution
7. **Push** — to configured branch/remote
8. **Monitor** — verify deployment status (if CI/CD configured)

## Conventions

- ISO 8601 dates (YYYY-MM-DD), 24-hour time (HH:MM)
- Commit messages: imperative mood, concise summary, optional body
- Co-author attribution on AI-assisted commits
- Biome handles formatting and linting — no separate Prettier/ESLint config
- British English in documentation and user-facing strings

## Skills

| Command   | Description |
|-----------|-------------|
| `/init`   | First-run project interview — configures everything |
| `/test`   | Run the test suite (lint + type check + tests) |
| `/deploy` | Pre-flight checks + SAST + commit + push + monitor |
| `/sast`   | Full SAST scan of the entire codebase |
