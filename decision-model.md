# Decision Model — how a workout is chosen

Subsidiary to `CLAUDE.md`. This is the single human-readable reference for **how the
DSW (Daily Suggested Workout) engine decides what to prescribe, and where every input
comes from**. It doubles as Claude's reference. Keep it in sync with the code — see the
maintenance note at the foot.

> Scope: the run/swim endurance engine under `src/engine/`. Weight-lifting prescriptions
> are a future workstream (not yet built).

## Pipeline at a glance

```
fetch data ─► readiness score ─► sport ─► category (intensity) ─► workout body ─► output
 (per user)     (0–100)          Run/Swim   rest…intervals          engine or vendor
```

Pre-emptive short-circuits can replace the whole result before the body is built:

| Condition | Result | Where |
|---|---|---|
| `promus-whoop` user, no WHOOP night today / Promus down | `status: health_unavailable` (no segments) | `suggest.ts` (hard-fail) |
| Requested sport already trained today | `status: already_trained` (Quies card) | `suggest.ts` suppression |
| Cross-training strain unknown (weights logged, no RPE) | `status: awaiting_input` (asks for RPE) | `suggest.ts` |

## Where the data comes from

| Source | Endpoint(s) | Feeds |
|---|---|---|
| **intervals.icu** | `/activities` (14 d), `/wellness` (7 d), `/sport-settings/{Run,Swim}` | Activities (load, zones, RPE), TSB (CTL/ATL), Subjective (soreness/fatigue), HR/pace/power zones, FTP fallback. Also the **write** target for planned workouts + the Vigil `injury` field. |
| **Promus WHOOP** *(the WHOOP path of the recovery source below)* | `/api/whoop/{serial}/sleep`, `/hrv_nightly`, `/vigor_vitae/current` | Sleep duration, nightly RMSSD (HRV), **Vigor Vitae** (acute recovery). Bearer `PROMUS_API`, serial `WHOOP_SERIAL`. |
| **Garmin Connect** *(the Garmin path)* via the `garmin-bridge` sidecar | `/body_battery/current`, `/hrv_nightly`, `/sleep_nightly`, `/activities`, `/activity/{id}/fit` | **Body Battery** (acute, ↔ Vigor Vitae), overnight HRV, sleep duration — normalised to the same DTOs as WHOOP; plus **Vigil biomechanics** from the original run FIT (§5). Bearer `GARMIN_BRIDGE_API_KEY`. |
| **Stryd** | `cp/history`, FIT downloads, `/workouts/recommendations` | Run FTP (Critical Power), Vigil biomechanics + low-fidelity activity enrichment, Stryd workout bodies for the swap. |
| **FORM** | swim recommendations | FORM swim workout bodies for the swap. |

**Recovery source** (`src/health-source.ts`, `fetchHealthTelemetry`): per-user `healthSource`
selects where Sleep + HRV + acute recovery come from — resolved as the runtime selector
(Praescriptor WHOOP/Garmin/Auto, stored in `user_preferences`) over the profile default:
- `"promus-whoop"` — WHOOP via Promus; hard-fails to `health_unavailable` on a missing today-night.
- `"garmin"` — Garmin via the bridge; hard-fails only when Garmin has no data (Body Battery is
  the acute signal + liveness gate).
- `"auto"` (ze's default) — WHOOP primary; on a missing WHOOP night / Promus outage, **fall back
  to Garmin** instead of blocking, and only fail when both are down. This is what lets a WHOOP
  strap hiatus degrade to Garmin. Both sources normalise to the same `NightlyHealth[]` + acute
  value, so the readiness blend is source-agnostic.
- unset → intervals.icu wellness (Pam).

Provenance note: WHOOP-sourced values are computed by **Promus's own algorithms**, not WHOOP's;
Vigor Vitae is our in-house Body-Battery equivalent, and Garmin Body Battery is the real-world
original of exactly that signal. Sleep + HRV moved off intervals.icu (Oura-sync) onto Promus
after an unreliable-sync incident (`lessons.md` 2026-06-03).

## 1. Readiness score (0–100)

`computeReadiness` (`src/engine/readiness.ts`). Weighted blend of five components,
**renormalised over whichever components have real data** (≥3 required; below that it
falls back to a NEUTRAL 50 fill so a thin-data score stays conservative). Readiness is a
**whole-athlete** number — identical on every surface (prescription header, `/status`,
`/dashboard`); no per-sport filter on production paths.

| Component | Weight | Source | How it scores 0–100 |
|---|---|---|---|
| **TSB** (form) | 0.30 | intervals CTL−ATL | `lerp(−20…+20 → 0…100)`. Rebuild floor 60 when CTL < 30 and FTP/CTL > 12 (returning athlete). The **trend / chronic-fatigue** signal. |
| **Vigor** (acute) | 0.20 | Vigor Vitae, else sleep band | Vigor Vitae (0–100) when present; **best-effort** — if absent/failed, falls back to the sleep-duration band (WHOOP duration `5h→0, 8h→100`, or intervals `sleepScore`). The **now / last-night** signal (mean-reverts → not a trend signal). *Trial from 2026-06-04.* |
| **HRV** | 0.20 | WHOOP RMSSD (else intervals) | today's RMSSD ÷ 7-day mean: ≥110%→100, 100%→75, 90%→50, 75%→20, ≤60%→0. A short-term autonomic-trend signal. |
| **Recency** | 0.15 | intervals activities | hours since the last activity of **any** sport; sigmoid around 24 h. Null when no activities. |
| **Subjective** | 0.15 | intervals soreness + fatigue | mean of inverted soreness + fatigue (1–4 dropdown → `((4−v)/3)×100`). Null when neither logged. The intervals `readiness` field is **not** used. |

Trend vs acute, by design: **TSB + HRV carry the trend; Vigor carries the acute state.**
Aggregate = weighted mean of present components, clamped 0–100, rounded.

Advisory warnings (do not change the score): HRV below baseline, sleep < 7 h (always read
from real sleep duration even when Vigor scores the slot), and multi-night **sleep-debt**
(3+ recent nights < 7 h) which also caps category at `base`.

## 2. Sport selection (Run vs Swim)

`selectSport` (`src/engine/sport-selector.ts`) runs **only when no sport is forced** — i.e. the
MCP `suggest_workout` tool and `GET /api/users/:userId/workouts/suggested` *without* a `?sport=`
parameter. (`/dashboard` and the Praescriptor cards instead use `profile.sports`; a forced sport
yields `sport_selection_reason: "Forced: <sport>"`.) The chosen sport and the reason are reported
in **`sport_selection_reason`**. Rules, in order of precedence:

1. **3-session anti-monotony** — if the **last 3 sport activities** (run/swim only; weights/yoga/etc.
   break the streak) are all the same sport → pick the other ("Last 3 sessions were all Run —
   switching to Swim…").
2. **Low-readiness recovery** — readiness **< 30** and only one sport done in the last 3 days →
   pick the other ("active recovery via …").
3. **Load deficit** (the usual path) — for each sport, `deficit = chronic − acute`, where
   `acute` = sum of session load over the last **7 days** and `chronic` = sum over the last
   **14 days ÷ 2** (≈ a 7-day baseline). Load is power-aware: `getActivityLoad`
   (`src/engine/power-source.ts`) uses Stryd `power_load` for runs, `hr_load` for swims. The
   sport with the **larger deficit** (more *under*-trained vs its own baseline) wins
   ("Running has a higher load deficit (56 vs −23) — relatively undertrained"). A *negative*
   deficit means that sport is currently **above** its baseline.
4. **Tie-break** — when the two deficits are within **10%** of each other: fewer sessions in the
   last 7 days wins; if still tied, **default to Run**.

**Recency is deliberately NOT a factor.** Whether you trained a sport *yesterday or today* does
not influence selection — only the 7/14-day load balance and the two override rules above do. A
run from yesterday counts the same toward the deficit as one from six days ago. (Same-sport
*intensity* spacing is handled later, in the category ladder's `daysSinceHard` guard — §3 — not
in sport choice.)

> **Worked example (return-to-run).** Athlete ran yesterday but only **2×/14 d**; swam 3× incl.
> today. runDeficit ≈ +1 (acute 52 vs chronic 53); swimDeficit ≈ −7 (acute 40 vs chronic 33.5 —
> swimming is *above* baseline). Run wins (+1 > −7): over the fortnight, **run is the neglected
> sport**, so it is primary the day after a run — by design, not a bug. (Readiness 49 still
> shaped it into a gentle *recovery* run.)

## 3. Category / intensity selection

`selectWorkoutCategory` (`src/engine/workout-selector.ts`). Base ladder from the readiness
score, then a series of guards. `daysSinceHard` = days since the last hard session (running
**or** moderate/hard cross-training).

| Readiness | Category |
|---|---|
| ≤ 20 | `rest` |
| ≤ 35 | `recovery` |
| ≤ 50 | `base` |
| ≤ 65 | `tempo` if `daysSinceHard ≥ 2`, else `base` |
| ≤ 80 | `threshold` if `daysSinceHard ≥ 2`, else `base` |
| > 80 | `intervals` (≥3 d rest) → `threshold` (2 d) → `tempo` (yesterday) |

Then, in order:
- **Hard-session guard** — no *upshift* when `daysSinceHard < 2` and readiness > 50 (never two hard days back-to-back).
- **Zone rebalancing** — too much easy (low-zone > 70%) nudges `base → tempo`; too much hard (high-zone > 40%) downshifts tempo/threshold/intervals one step. Downshifts always allowed; upshifts blocked by the hard-session guard.
- **Long trigger** — `base` + readiness ≥ 60 + HRV not suppressed (component ≥ 30) + no long session in 7 d (90 min run / 60 min swim) → `long`.
- **Same-day cross-training cap** — weights earlier today cap the ceiling (hard → `recovery`, moderate → `base`).
- **Vigil downshift** — biomechanical alert severity ≥ 2 downshifts one step; severity 3 forces `base` (unless already rest/recovery). Applied last, overrides everything above.
- **Sleep-debt cap** — 3+ poor nights caps at `base`.

## 4. Workout body

The category decides *intensity*; the body (segments, targets) is then built:
- **Engine builder** (`src/engine/`) — warm-up / main set / cool-down with power (run, Stryd
  watts) or HR (swim) targets, dual-target safety HR cap, terrain guidance.
- **Vendor swap** — after the category is fixed, the body can be replaced by a vendor's own
  workout: **Stryd** for runs (`runRecommendationSource: "stryd"`, `src/web/stryd-swap.ts`),
  **FORM** for swims (`src/web/form-swap.ts`). The engine never re-decides intensity; the
  vendor only supplies the body for the chosen category. On any vendor failure it falls back
  to the engine body with a `fallbackReason` chip.
  - **Distance-based Stryd segments** — a Stryd library template can prescribe reps by
    **distance** rather than time (`duration_type: "distance"`; observed 2026-07-14 when the
    `long` bucket served "The Tom Workout (Distance)" — 1-mile reps). The unit is a
    per-segment property of the authored template (`distance_unit_selected`, e.g. `"mile"`),
    not an account setting, so `strydWorkoutToSegments` reads it per segment and converts to
    metres (`distanceToMetres`); Exercitator renders and serialises metric only (km on the
    dashboard, `mtr` to intervals.icu). A distance segment carries `distance_m` and
    `duration_secs = 0` — so `total_duration_secs`/`estimated_load` **understate** a
    distance workout (the reps contribute no seconds; a distance meta-pill shows the metric
    total instead). Accurate duration would require threading Stryd's per-segment
    `estimated_workout` estimate — deferred (see `lessons.md` 2026-07-14).

### Power source (run FTP)

`src/engine/power-source.ts` decides which reference the run power targets are expressed in.
`detectPowerSource` auto-detects from the **last 5 runs** (Stryd → Garmin → HR-only). Because
the 5-run window re-composes on every upload, the auto verdict can **flip** while an athlete
transitions between a Stryd pod and a native watch (the last Stryd run ages out of the window).

A **manual override** pins the source: the Praescriptor run-card *Auto / Stryd / Garmin* toggle
(`POST /api/power-source`) is sticky per-user in SQLite (`user_preferences`). The effective
source (override, else the detected one) then decides **where the FTP comes from** —
`resolveRunFtp` draws each ecosystem's value from its own home, no cross-scale approximation:
- **Auto** — the heuristic above (default; the only mode for Pam).
- **Stryd** — FTP = the **Stryd critical-power API** (foot-pod authoritative; a `none`
  detection with a valid CP upgrades to Stryd).
- **Garmin** — FTP = **intervals.icu's FTP** (`icu_rolling_ftp ?? icu_ftp`), which intervals
  derives directly from the run's Garmin power. No FTP configured → HR-only.

This replaced the earlier `Garmin = Stryd ÷ 0.87` scaling (a Stryd-CP approximation) with the
real Garmin-scale FTP intervals already computes. Surfaced on the HTTP API as
`power_context.override`; the Praescriptor footer labels the chip *Stryd: CP {n}W* or
*Garmin: FTP {n}W* to match the source. Run-only; swim never reads power context.

## 5. Injury overlay — Vigil

`src/engine/vigil/` — independent of readiness. Z-score deviation of running
biomechanics vs a personal 30-day baseline. Composite severity 0–3 (needs ≥2 metrics
deviating). Severity ≥2 triggers the category downshift above and writes the intervals
`injury` field. Run-only. Full spec: `phase2/injury-warning-spec.md`.

**Two recording sources, separate baselines.** Each run FIT is tagged `source`:

| Source | FIT | Metrics | Backfill |
|--------|-----|---------|----------|
| **Stryd Duo** (`fit-parser.ts`) | Stryd PowerCenter FIT (CIQ dev fields) | GCT, LSS, form-power ratio, ILR, bilateral GCT/LSS/VO/ILR balance — the full set | enrich-and-replace (`stryd/enricher.ts`) + 90-day backfill |
| **Garmin** (`garmin-fit.ts`) | original Garmin FIT via the bridge | **subset**: GCT, GCT drift, power:HR drift (native power), **GCT asymmetry** (native `stance_time_balance` — matches the Duo's GCT balance, but Garmin has GCT balance only, no LSS/VO/ILR balance); VO + cadence informational. No LSS/Form Power/ILR. | `garmin-backfill.ts`, same-activity (no replace) + 90-day backfill |

Baselines are **per-source** (`vigil_baselines` PK includes `source`): a wrist-watch GCT
offset never contaminates the foot-pod baseline. `runVigilPipeline` **ties to the effective
run power source** — it scores the source the athlete has selected on the run-card *Auto /
Stryd / Garmin* toggle (or auto-detected), so the injury baseline follows the same ecosystem
as the power targets and a stale non-selected baseline never shows. When there is no run power
source (`none`), it falls back to the **worst active** source across Stryd + Garmin
(injury-conservative). The Garmin backfill runs on the prescription path whenever a Garmin
health source (`garmin`/`auto`) is active. Four scoreable Garmin metrics clear the ≥2-metric
gate.

The Vigil footer indicator is **always shown** (`prescriptions.ts` computes it via
`vigilResultToSummary` for the footer even on an `already_trained`/rest card, where the run
pipeline short-circuits before Vigil) and reads the same source. Every surface — Praescriptor,
the HTTP API `/status` + `/dashboard` — resolves the effective source the same way
(`resolveRunFtp(...).source`) so the indicator is consistent.

---

## Keeping this doc current

This document must be updated **in the same change** as any edit to the decision logic or
data sources, specifically when you touch:

- Readiness weights/components/formulas or the renormalisation (`src/engine/readiness.ts`)
- The readiness→category ladder or any guard (`src/engine/workout-selector.ts`)
- Sport selection (`src/engine/sport-selector.ts`)
- Data sourcing / health telemetry / the recovery-source selection + fallback (`src/engine/suggest.ts`, `src/promus/client.ts`, `src/garmin/client.ts`, `src/health-source.ts`, `garmin-bridge/`)
- Power-source detection or the manual override / FTP scaling (`src/engine/power-source.ts`)
- The vendor swap layers (`src/web/stryd-swap.ts`, `src/web/form-swap.ts`)
- Vigil sources, the metric set, per-source baselines, or the pipeline combiner (`src/engine/vigil/{fit-parser,garmin-fit,backfill,garmin-backfill,baseline,index}.ts`)
- Pre-emptive statuses (`health_unavailable`, `already_trained`, `awaiting_input`)

A stale decision model is a bug (per the CLAUDE.md "documentation is code" principle).
The `/doc-sync` skill checks this file against the code.
