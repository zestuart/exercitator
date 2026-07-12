# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This file is Claude's operating manual. Keeping it accurate is not busywork — it is
> self-care. An outdated CLAUDE.md leads to wrong assumptions, missed context, and
> compounding errors. Treat this document and its subsidiaries as first-class code
> artifacts: review them, update them, and trust them only when they reflect reality.

## Project

**Name**: Exercitator + Praescriptor
**Description**: MCP bridge for Claude to access the intervals.icu API, plus a web UI serving daily workout prescriptions. Hosted on Cogitator (Mac Mini M4 Pro) via Docker and Tailscale (migrated from Arca Ingens 2026-04-04).
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
- **Networking**: Tailscale funnel (MCP, public) + Tailscale serve (Praescriptor + HTTP API, tailnet-only) on Cogitator
- **External API**: [intervals.icu](https://intervals.icu) REST API
- **HTTP API**: bearer-scoped REST surface for native clients (Excubitor iOS/watchOS) — port 8643, tailnet-only

## Architecture

Two co-located containers off the same codebase: **Exercitator** (MCP server + HTTP API) and **Praescriptor** (web UI). The DSW (Daily Suggested Workout) engine lives under `src/engine/` and is imported by all three surfaces — no network calls between containers. Vigil (biomechanical injury warning) hangs off `src/engine/vigil/`. Compliance tracking persists prescriptions and grades execution under `src/compliance/`.

Full file map, module responsibilities, and key patterns: see **`architecture.md`**.
How a workout is actually chosen — readiness weights, data sources, the category ladder and its guards, and the vendor swap — see **`decision-model.md`**.

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
   comments, not in documentation. The `.env` file is never committed. Secrets in
   git history are effectively public — they persist in every clone, fork, and
   backup, forever. One leaked key can mean unauthorised access, unexpected bills,
   or a full breach.

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
- **CHANGELOG.md**: Every user-visible change, every deploy. [Keep a Changelog](https://keepachangelog.com/) format with [Semantic Versioning](https://semver.org/). Security changes are always documented, even when internal-only.
- **User-facing docs**: README, API docs, guides — update them as part of the change,
  not as a separate task.
- **lessons.md**: After every bug, failed deploy, unexpected behaviour, security
  finding, or any insight that would help future development.

## Document Management

### The blooming pattern

Sections that exceed comfortable inline reading get extracted to their own files.
`CLAUDE-INDEX.md` is the index of subsidiary files. Current layout:

```
CLAUDE.md         — core rules, workflow, conventions (this file)
CLAUDE-INDEX.md   — index of all subsidiary files
architecture.md   — file map, module responsibilities, key patterns
decision-model.md — how a workout is chosen: readiness weights, data sources, category ladder, swap
deployment.md     — Cogitator deploy procedure, networking, volumes
SECURITY.md       — security surfaces, outstanding findings, remediation history
lessons.md        — chronological post-mortem log (append-only)
CHANGELOG.md      — user-visible changes per release
```

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

All credentials live in `.env` at the project root: gitignored, never logged or echoed, the single source of truth for API keys, tokens, and secrets. A committed `.env.example` documents required variables with placeholder values and is kept in sync with `.env`.

Every deployment includes a SAST scan via Gemini 2.5 Pro (different model family from Claude, independent review). `scripts/sast_scan.py` is zero-dependency (Python stdlib) and reads `GEMINI_API_KEY` from `.env` or environment. Diff mode during deploys (changes since last baseline), full mode on demand via `/sast`. Clean scans tag as `sast-baseline-YYYY-MM-DD`. Findings block deployment — fix or explicitly accept.

**Current baseline**: `sast-baseline-2026-07-12-b` on commit `6d8a52c` (**Garmin FIT → Vigil biomechanics + per-source injury baselines (Garmin recovery Phase 2)**. Vigil injury detection extended from Stryd-only to Garmin-recorded runs (ze's Stryd pods went non-op; runs now arrive via Garmin Connect). New `src/engine/vigil/garmin-fit.ts` (`extractGarminMetrics`) reads Garmin's *standard* running-dynamics FIT fields (`stance_time`, `stance_time_balance`, `vertical_oscillation`, `power`, `cadence`+`fractional_cadence`) — **not** Stryd CIQ developer fields — yielding a **subset**: avg GCT, GCT drift, power:HR drift (native power), and **GCT asymmetry** (from Garmin's native `stance_time_balance`, a signal the single-pod Stryd never provided); VO + cadence informational; no Leg Spring Stiffness / Form Power / ILR (null). Four scoreable metrics clear the ≥2-metric gate. `src/engine/vigil/garmin-backfill.ts` pulls runs from the bridge (`/activities` + `/activity/{id}/fit`), extracts metrics **same-activity** (no enrich/replace — Garmin runs already live in intervals as `GARMIN_CONNECT`), source-scoped 90d-first/14d-incremental, daily-debounced; wired into the prescription path via the already-constructed `healthOpts.garminClient` (runs whenever a `garmin`/`auto` health source is active, independent of which source wins readiness). **Per-source baselines**: `source` (`stryd`|`garmin`) column on `vigil_metrics` + in the `vigil_baselines` PK (in-place migration — `ADD COLUMN` on `vigil_metrics`, rebuild `vigil_baselines`; baselines are derived, recomputed next prescription); `runVigilPipeline` keeps its signature but scores Stryd and Garmin independently and returns the **worst active severity** (injury-conservative), so a wrist-watch GCT offset can't contaminate the foot-pod baseline and a concerning Garmin baseline still downshifts while a stale Stryd one is quiet. Shared FIT helpers (`validMean`/`computeGctDrift`/`computePowerHrDrift`/`balanceToAsymmetry`/`MIN_RECORDS`/`MAX_RECORDS`) exported from `fit-parser.ts` for reuse; `computePowerHrDrift` already reads native lowercase `power`. Field names verified against a real ze trail-run FIT (activity 23572046674) before building — didn't guess. **Committed fixture is GPS-stripped + gzipped** (`tests/fixtures/garmin/garmin-run-records.json.gz`, 43 KB) — the repo is **public**, so no home coordinates enter git history; tests run the extractor on parsed records + mock the bridge. Praescriptor "Vigil: no Stryd data" copy generalised to "no run data". **No new env** (reuses Phase 1 `GARMIN_BRIDGE_API_KEY` / `GARMIN_URL`; no `docker-compose.yml` change). Diff SAST (16 changed files): **2 Medium DoS guards FIXED** (Vigil-query 800-day date-range cap in `db.ts`; `MAX_RECORDS` 200k cap in both FIT extractors) → re-scan surfaced **1 Medium accepted-risk** — the binary FIT-download buffer-before-cap (`StrydClient.downloadFit` / `GarminClient.getActivityFit` `arrayBuffer()` then 10/16 MB check), an **extension of #37** on trusted authenticated single-user upstreams (the scanner missed the existing caps; Garmin is additionally capped **bridge-side before transmission**, and FIT is an uncompressed record stream — no decompression amplification), recorded in `SECURITY.md` § #37 extension. 17 new vitest cases, **684 pass**; tsc + biome clean. In-place migration path unit-tested (existing rows → `source:'stryd'`, baseline PK rebuilt). **Verified live end-to-end**: post-deploy `/ze/api/prescriptions` triggered the Garmin backfill → **18 `source:'garmin'` `vigil_metrics` rows** now in production alongside 35 Stryd rows, cleanly separated; activity 23572046674 = GCT 287.6 ms / asymmetry 1.87% / power:HR drift 19.5% / `avg_lss` null (matches local extraction). `vigil_baselines` computes on the next non-`already_trained` run prescription (today's short-circuited on `already_trained`). **Phase 2b (native power → intervals re-upload) intentionally skipped** — intervals already relays Garmin `power_field:"power"`. Prior accepted-risk **#36** (send-path TOCTOU) unchanged. See `CHANGELOG.md`, `decision-model.md` §5, `architecture.md`, `lessons.md` 2026-07-12, and memory `project_garmin_recovery_source`.). Prior: `sast-baseline-2026-07-12` on commit `042ec30` (**Garmin Connect recovery source + WHOOP-absent fallback**. Ze's WHOOP data arrives via the in-house **Nunc** app, not the WHOOP app; a multi-week strap hiatus made `healthSource: "promus-whoop"` hard-fail every prescription (and hid the power-source toggle, since a blocked card has no run card). New **`garmin-bridge/`** Python/FastAPI sidecar over `garth`/`garminconnect` (lifted from `../blueToothDisco`; **pinned garth 0.8.0 / garminconnect 0.3.3** to match the cloned token format) normalises Garmin into the **same DTOs as the WHOOP feed** (`/body_battery/current`, `/hrv_nightly`, `/sleep_nightly`, `/activity/{id}/fit`); bearer-gated (`GARMIN_BRIDGE_API_KEY`), tailnet-only, garth OAuth token in a mounted volume (`garmin-token-state`, **cloned** from `~/.garminconnect/garmin_tokens.json` — no fresh MFA login). Read internally over the compose network via `src/garmin/client.ts` (mirror of `PromusClient`), so `fetchHealthTelemetry` reuses `mergeWhoopHealth` and **`readiness.ts` is unchanged**: Garmin **Body Battery → the acute (Vigor-Vitae) slot**, overnight HRV → HRV, sleep → sleep. `healthSource` widens to `"promus-whoop" | "garmin" | "auto"`; ze defaults to **`"auto"`** (WHOOP primary, Garmin fallback on a missing WHOOP night, hard-fail only when both are down). WHOOP/Garmin/Auto **recovery selector** on the Praescriptor readiness block (`POST /:userId/api/health-source`, sticky in `user_preferences`, enum-validated + write-rate-limited); acute label VV (WHOOP) / BB (Garmin). Misleading "Open the WHOOP app" copy corrected to reference Nunc. **New env** `GARMIN_BRIDGE_API_KEY` + `GARMIN_URL` (default compose-internal `http://garmin-bridge:8655`), forwarded to exercitator + praescriptor; two new external volumes (`garmin-token-state`, `garmin-tailscale-state`). Diff SAST (30 changed files): **3 Medium findings all FIXED** (unbounded date range → DoS, unauthenticated live-Garmin probe, zip-bomb in the FIT download) → re-scan **NO_FINDINGS**; the only post-scan change was the two-line garth version pin (dependency bump, negligible). 21 new vitest cases, 667 pass. **Verified live end-to-end**: bridge authenticates with the cloned token (account "Ze Stuart"); forcing `healthSource: garmin` → `/ze/api/prescriptions` sources the acute value from Garmin Body Battery (integer 39/"medium"), no `health_unavailable`; restored to `auto`. **Phase 2 (Garmin FIT → Vigil biomechanics) deferred** — needs a real Garmin FIT to map running-dynamics fields. The prior accepted-risk items (**#36** send-path TOCTOU, **#37** unbounded `res.text()` buffering) remain outstanding/unchanged. See `CHANGELOG.md`, `decision-model.md` (Recovery source), `garmin-bridge/README.md`, and memory `project_garmin_recovery_source`.). Prior: `sast-baseline-2026-07-11` on commit `9b4e88d` (manual run **power-source toggle** — a sticky per-user Auto/Stryd/Garmin override that pins the run FTP scale instead of `detectPowerSource`'s rolling-5-run-window heuristic, which flips as runs age out (ze's Stryd pods went non-op; the last full-Stryd run aged out and iPhone/RunGap runs now auto-classify as `garmin`). `applyPowerSourceOverride` (`src/engine/power-source.ts`) runs **after** the Stryd-CP anchoring block in `suggestWorkoutFromData`: "stryd" trusts the CP FTP as-is; "garmin" scales it up to Garmin's native scale by `÷0.87` (Garmin reads ~15% higher). `correction_factor` is display-only — every target derives from `power.ftp` directly — so this is pure FTP scaling, no builder change. Persisted in a new SQLite `user_preferences` table (`getPowerSourceOverride`/`setPowerSourceOverride`, shared `exercitator-data` volume so both containers see it); `"auto"` clears the row. `POST /:userId/api/power-source` (enum-validated `{auto,stryd,garmin}`, write-rate-limited, invalidates the day cache) + a Praescriptor run-card segmented control. Honoured on every surface: Praescriptor, MCP `suggest_workout` (keyed by `DEFAULT_USER`), HTTP API `/workouts/suggested` + `/dashboard`; wire field `power_context.override`. `/status` `critical_power` unchanged (measured Stryd CP, not a target-scale choice). **No new env**. Run-only; swim unaffected. Diff SAST (33 changed files): **NO_FINDINGS**. 22 new vitest cases, 646 pass; verified live end-to-end (`/ze/api/prescriptions` returns `powerSourceOverride: "auto"`; new code confirmed running — ze currently in `health_unavailable`/`whoop_today_missing`, so the blocked card shows and the toggle appears once WHOOP syncs). The two prior accepted-risk items (**#36** send-path TOCTOU, **#37** unbounded `res.text()` buffering) remain outstanding/unchanged. See `CHANGELOG.md`, `decision-model.md` §4, and memory `project_power_source_toggle`.). Prior: `sast-baseline-2026-06-04` on commit `2322c87` (readiness acute component is now Promus **Vigor Vitae** — the 0.20 acute slot (`WEIGHT_VIGOR`, `components.vigor`) takes VV (Promus in-house Body-Battery 0–100 from `GET /api/whoop/{serial}/vigor_vitae/current`) instead of the 5h→0/8h→100 sleep-duration band. VV is a strong now/last-night recovery signal but mean-reverts, so trend stays with TSB (0.30) + HRV-vs-baseline (0.20). VV is best-effort: a failed/absent read is non-fatal and falls back to the sleep band (Pam/non-WHOOP unchanged; a VV outage never blocks a prescription). Sleep-duration warnings + sleep-debt still read real duration. Surfaced as `ReadinessBlock.vigor_vitae {value, level}` (API) + a "VV {n} · {level}" line under the Praescriptor readiness score. No new env (reuses `PROMUS_API` + `WHOOP_SERIAL`). **Trial from 2026-06-04 — evaluate over a few days** (deployed end-to-end: ze dashboard shows readiness 72 / "VV 98 · high"). Diff SAST (17 changed files): **one Medium accepted-risk** — pre-existing unbounded `res.text()` buffering in `parseBoundedJson` (`src/promus/client.ts`) reads the full response before the size cap; codebase-wide pattern (promus/stryd/form/intervals clients); accepted because all upstreams are trusted in-house/authenticated, not untrusted input; proper fix reuses the streaming `readBoundedText` (`src/web/promus-dsw.ts:68`) across all clients + updates their test mocks — issue #37, `SECURITY.md` § Outstanding. 9 new vitest cases, 623 pass. See `CHANGELOG.md` and memory `project_vigor_vitae_trial`.). Prior: `sast-baseline-2026-06-03-e` on commit `9d8971c` (Stryd/intervals send-path timezone + status-guard fix — `sendToStryd` regenerated the prescription with `generatePrescriptions(client, profile)`, omitting both `tz` and `strydClient`; with `tz` undefined `localDateStr` defaults to container-UTC, so an evening "Send to Stryd" west of UTC (21:10 PDT) computed "today" as tomorrow → the WHOOP day-window targeted a night that hadn't happened → `status: "health_unavailable"`, and neither send path guarded `suggestion.status`, so the "Health telemetry unavailable" placeholder was serialised by `toStrydWorkout` and pushed to the Stryd calendar. Fix: `sendToStryd` forwards `strydClient` + `tz` (mirrors `sendToIntervals`); both paths now return `422 {not_sendable, status, message}` for any non-`ready` status (422 not 409 — the web client auto-retries 409 with `?force=true`). Junk Stryd entry deleted. Diff SAST (10 changed files): **one Medium accepted-risk** — pre-existing TOCTOU dedup race in both send paths (`getSendEvent` check separated from `persistSendEvent` by the awaited external API call → concurrent same-day requests can both pass the check and duplicate-send); accepted because both surfaces are OAuth/bearer-gated single-user (ze/pam), Praescriptor is tailnet-only, and the impact is a user-deletable duplicate calendar entry, not a security control; proper fix is a `UNIQUE(user_id,date,sport,target)` constraint + INSERT-first (an in-process lock is insufficient — the two send callers run in separate containers sharing one SQLite volume), tracked in issue #36, `SECURITY.md` § Outstanding. 5 new vitest cases, 616 pass — incl. an engine test pinning the exact incident (same instant → success in `America/Los_Angeles`, `whoop_today_missing` in UTC). See `lessons.md` 2026-06-03. Third UTC-vs-athlete-tz defect — always thread `tz` through `generatePrescriptions`/`localDateStr`/`fetchTrainingData`.). Prior: `sast-baseline-2026-06-03-d` on commit `465ed4a` (intervals.icu subjective-scale correction + readiness-field removal — soreness/fatigue/stress/mood/sleepQuality are intervals' 1–4 dropdown, not 0–10/1–5: the API badge now flags `"low"` at `>= 3` (was an unreachable `>= 6`, so "high" soreness always read "ok"), and `computeSubjective` inverts via `((4 - value) / 3) * 100` (was `(10 - value) * 10`, which made "high" *raise* readiness). The intervals `readiness` field is dropped from `computeSubjective` entirely — same unreliable Oura/Garmin-sync provenance that moved Sleep+HRV to Promus WHOOP; Subjective is now soreness+fatigue self-report only. `update_wellness` field descriptions corrected. Diff SAST (12 changed files): **one Medium accepted-risk** — `update_wellness` scaled fields still lack range validation (`z.number().optional()` with no bounds → out-of-range value forwarded to intervals.icu); accepted because callers are OAuth-only (ze/pam), `computeReadiness` clamps, and intervals validates upstream; proper fix must preserve the `-1` clear-sentinel — see `SECURITY.md` § Outstanding. 9 new vitest cases, 611 pass). Prior: `sast-baseline-2026-06-03-c` on commit `2613600` (readiness made whole-athlete on every surface — the prescription, `/status`, and `/dashboard` all drop the `sport` recency filter so a recent ride/swim tempers the number and the Praescriptor header, wire `suggested` block, and API status blocks report one identical value; per product decision that readiness is a multi-sport recovery indicator, not Run-only. `computeReadiness`'s `sport` option retained for direct callers/tests. Diff SAST: **NO_FINDINGS**). Prior: `sast-baseline-2026-06-03-b` on commit `6219369` (HTTP API readiness DTO follow-up — `/status` + `/dashboard` now read the HRV/Sleep component badges from the same WHOOP `NightlyHealth[]` as the score, resolve the athlete tz on `/status` so the WHOOP window matches `/dashboard`, and compute the status-block readiness with the prescription's `{sport, ftp, health}` inputs so every surface shows one number; fixes the Nunc "HRV/Sleep unknown, readiness 71 vs 75" report). Diff SAST (8 changed files): **NO_FINDINGS**. Prior: `sast-baseline-2026-06-03` on commit `ef4f038` (Sleep + HRV readiness telemetry moved from intervals.icu wellness to the in-house Promus WHOOP strap feed for `healthSource: "promus-whoop"` users — new `src/promus/client.ts` + `src/health-source.ts`; hard-fails to `status: "health_unavailable"` when today's WHOOP night is missing or Promus is unreachable; API 0.2.2; new `WHOOP_SERIAL` env forwarded to both Docker services, auth reuses `PROMUS_API`). Diff SAST (21 changed files): **NO_FINDINGS**. The new external surface is a single GET-only bearer client reading two WHOOP endpoints; serial is `encodeURIComponent`-escaped, JSON bodies are 512 KB-capped, no secret is logged. Motivated by an intervals.icu Oura-sync artefact (18-minute "night" suppressing a real prescription) — see `lessons.md` 2026-06-03. Prior: `sast-baseline-2026-06-02` on commit `76908ac` (Praescriptor fallback source-chip humanised — `humaniseFallbackReason` turns slugs like `stride_rejected_on_recovery` into plain English; raw slug retained in the chip tooltip + on the HTTP API). That diff SAST surfaced two pre-existing findings in the touched `src/web/render.ts`: a **Medium XSS** in `clientJs` (user slug server-interpolated into `fetch()` path strings) — **fixed** by emitting the slug as a JSON literal (`const __userId = …`) + client-side prefix concatenation (non-exploitable anyway: `getUserProfile` whitelists slug to ze/pam); and a **Low** `prompt()`-in-compliance-picker social-engineering vector — **accepted-risk** (narrow threat model, backend `^[A-Za-z0-9_-]{1,64}$` allowlist rejects the payload, tailnet-only), tracked in issue #35 (`SECURITY.md` § Outstanding). API 0.2.1 unchanged. Prior: `sast-baseline-2026-05-27-c` on `06e429b` (API 0.2.1 patron-deity invocation block, NO_FINDINGS); `sast-baseline-2026-05-27-b` on `9e2d2fc` (same-sport already-trained Quies suppression card + API 0.2.0); `sast-baseline-2026-05-27` on `c9dc2bd` (Phase 7 replay closed-loop via Promus #167). Earlier today: `sast-baseline-2026-05-26-b` on `fad8d6b`, `sast-baseline-2026-05-26` on `ec2b6ff`. Earlier baselines: `sast-baseline-2026-05-25-d` on `9d3ce13`, `sast-baseline-2026-05-25-c` on `5fc31b0`, `sast-baseline-2026-05-25-b` on `53f063e`, `sast-baseline-2026-05-25` on `9960fc3`. Accepted finding from prior -d diff: pre-existing hardcoded `"0"` for Swim userId at `prescriptions.ts:118` — `"0"` is a Vigil-disable sentinel (Vigil is Run-only), not a real user id; cross-user leak is structurally impossible because upstream `data` is fetched per-user. **For future external-coach integrations** see `phase2/external-coach-integration-playbook.md` (Stryd run + FORM swim are the canonical reference arcs). `python3 scripts/sast_scan.py --mode diff` scans only files changed since this tag. Re-baseline immediately after each clean deploy or accepted-risk deploy.

Full inventory of security surfaces, outstanding findings, and remediation history: see **`SECURITY.md`**.

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

Tarball upload + `docker compose up -d --build` against Cogitator (`dominus@cogitator.tail7ab379.ts.net`), three Tailscale-fronted services on the `tail7ab379.ts.net` tailnet. Deploy from `main` only.

Full target details, networking, container/volume layout, deploy procedure, and pre-flight sequence: see **`deployment.md`**. Wider home-lab conventions live in `github.com/zestuart/praefectura`.

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

## graphify

This project has a graphify knowledge graph at `graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
