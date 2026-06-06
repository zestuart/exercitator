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
| **Promus WHOOP** *(users flagged `healthSource: "promus-whoop"` — ze; Pam stays on intervals)* | `/api/whoop/{serial}/sleep`, `/hrv_nightly`, `/vigor_vitae/current` | Sleep duration, nightly RMSSD (HRV), **Vigor Vitae** (acute recovery). Bearer `PROMUS_API`, serial `WHOOP_SERIAL`. |
| **Stryd** | `cp/history`, FIT downloads, `/workouts/recommendations` | Run FTP (Critical Power), Vigil biomechanics + low-fidelity activity enrichment, Stryd workout bodies for the swap. |
| **FORM** | swim recommendations | FORM swim workout bodies for the swap. |

Provenance note: the WHOOP-sourced values are computed by **Promus's own algorithms**, not
WHOOP's — we do not have WHOOP's recovery/sleep-performance scores. Vigor Vitae is our
in-house Body-Battery equivalent. Sleep + HRV moved off intervals.icu (Oura-sync) onto
Promus after an unreliable-sync incident (`lessons.md` 2026-06-03).

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

## 5. Injury overlay — Vigil

`src/engine/vigil/` — independent of readiness. Z-score deviation of Stryd running
biomechanics (GCT, LSS, form-power ratio, ILR, bilateral balance) vs a personal 30-day
baseline. Composite severity 0–3 (needs ≥2 metrics deviating). Severity ≥2 triggers the
category downshift above and writes the intervals `injury` field. Run-only. Full spec:
`phase2/injury-warning-spec.md`.

---

## Keeping this doc current

This document must be updated **in the same change** as any edit to the decision logic or
data sources, specifically when you touch:

- Readiness weights/components/formulas or the renormalisation (`src/engine/readiness.ts`)
- The readiness→category ladder or any guard (`src/engine/workout-selector.ts`)
- Sport selection (`src/engine/sport-selector.ts`)
- Data sourcing / health telemetry (`src/engine/suggest.ts`, `src/promus/client.ts`, `src/health-source.ts`)
- The vendor swap layers (`src/web/stryd-swap.ts`, `src/web/form-swap.ts`)
- Pre-emptive statuses (`health_unavailable`, `already_trained`, `awaiting_input`)

A stale decision model is a bug (per the CLAUDE.md "documentation is code" principle).
The `/doc-sync` skill checks this file against the code.
