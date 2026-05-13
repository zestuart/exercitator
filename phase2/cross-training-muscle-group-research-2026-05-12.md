# Cross-training muscle-group awareness — research and decision

**Date**: 2026-05-12
**Author**: Claude (background session while user was running)
**Scope**: Decision-quality research for [exercitator#33](https://github.com/zestuart/exercitator/issues/33). Goal: pick an implementation variant for muscle-group-aware cross-training prescription, backed by data + literature.

---

## TL;DR

The blunt 2-day rule isn't the bottleneck. The bottleneck is that **no real Promus session has RPE attached**, so the strain cascade falls through to `unknown` and no rule fires anyway. Muscle-group awareness is the right second step, not the first.

**Recommended path** — two thin phases instead of one fat one:

1. **Phase 1 (small, ship soon)** — wire Promus into the engine for strain classification using objective volume signals (set count + duration), not pure RPE. Closes the data-flow gap that makes today's "moderate weights yesterday" invisible to the engine. **~250 LOC, ~3–4 hours.**
2. **Phase 2 (bigger, after Phase 1 settles)** — layer muscle-group awareness on top of Phase 1's strain assessment. Switch from "any moderate/hard CT triggers guard" to "only CT with primary-musculature overlap with the prescription sport". **~200 LOC + exercise classifier.**

This sequencing matters because Phase 2's benefit is only measurable once Phase 1 unblocks the cascade. Doing both in one PR conflates two separately-debuggable behaviours.

**Recommend rejecting Variants B (granular weighted overlap) and C (time-decay)** as over-engineering relative to the user's actual cross-training cadence (~1 real session every 4 weeks). Reconsider in 6+ months if volume increases meaningfully.

---

## What the data says

### Cross-training cadence is sparse

Pulled the last 90 days from Promus and the last 60 from intervals.icu. Headline numbers:

| Metric | Value |
|---|---|
| Promus sessions logged (90 d) | 7 |
| Of those, **real workouts** (≥10 sets, ≥15 min) | **3** (Apr 19, Apr 25, May 11) |
| Calibration / test artefacts | 4 |
| Real session cadence | **~0.23 / week** (≈1 every 4 weeks) |
| Promus sessions with RPE set | 3 / 7 — **all on calibration micro-sessions** |
| intervals.icu WeightTraining (60 d) | 6 (3 Garmin pre-Promus + 3 Palaestra-matched) |
| Days the blunt 2-day rule would fire if every session were "moderate" | **11 / 62 (18 %)**, clustered as three 3-day shadows |

Raw analysis at `/tmp/research-data-summary.md` and `/tmp/research-correlation.md`.

### Exercise vocabulary is tiny

Only seven distinct exercises across 45 sets in 90 days:

| Sets | Exercise | First-pass class |
|---:|---|---|
| 11 | Back Squat | lower |
| 9 | Deadlift | lower + core |
| 9 | Bench Press | upper |
| 7 | High row | upper |
| 3 | Barbell Row | upper |
| 3 | Leg curl | lower |
| 3 | Leg extension | lower |

**A hardcoded classifier covers 100 % of historical sessions**. ML or a heavy ontology is unjustified at this volume. The lookup table fits on a single screen.

(Footnote: a data-hygiene issue surfaced — `"High row"` and `"High row "` (trailing space) collide as separate keys upstream. Worth a one-line fix in Palaestra's exercise picker or a normaliser in the Promus client.)

### Real sessions are mixed lower + upper, not single-region

Of the 3 real sessions in the window, every one hit both lower and upper musculature:

- **Apr 19**: 12 sets — Deadlift × 3, Back Squat × 3, Bench Press × 3, Barbell Row × 3 (50/50 split)
- **Apr 25**: 12 sets — High row × 3, Back Squat × 3, Bench Press × 3, Deadlift × 3 (50/50)
- **May 11**: 16 sets — High row × 4, Deadlift × 3, Bench Press × 3, Leg curl × 3, Leg extension × 2 (56 % lower)

**Practical implication**: on real historical sessions, the user has never done a pure upper-body day. Muscle-group differentiation between lower and upper would have made zero difference for this user's actual training. The benefit appears only when the user starts doing upper-only sessions — which they may or may not.

### The latent bug: zero RPE on real sessions

This is the most important finding. **None** of the three real Promus sessions has `rpe` set, and the matched intervals.icu activities have `session_rpe: null` (Palaestra-source uploads don't carry it). The blunt 2-day rule never fires today not because it's mis-designed, but because `assessCrossTrainingStrain` lands at tier 3 (`unknown`) and `daysSinceHardCrossTraining` filters those out.

Muscle-group awareness without solving the RPE gap is decoration — the cascade still won't classify these sessions as anything.

---

## What the literature says

[Percontator deep-research summary against sports-science PubMed]

1. **Lower-body strength impairs next-day running for 24–48 h, fully recovered by 48 h.** Stock et al. 2016 (J Strength Cond Res): 40-min session at 3×8–10 RM caused ~4–6 % running economy deficit at 24 h, none at 48 h. Wilson et al. 2012 meta (Sports Med, n = 20 studies): effect size −0.45 at 24 h, diminished by 48 h.
2. **Upper-body strength causes near-zero crossover.** McCarthy et al. 2020 (Eur J Appl Physiol): no change in next-day VO2max or economy after bench/pull-up sessions. Bright et al. 2021 (J Sci Med Sport) replicated in triathletes. Schumann et al. 2022 (Sports Med review) puts upper-body interference effect at < 0.1.
3. **Blanket 2-day rule is suboptimal.** Blagrove et al. 2018 (Scand J Med Sci Sports) RCT: muscle-group-specific scheduling improved 5 km time by 2.1 % vs 0.8 % for blanket rest, allowing 20 % higher weekly strength volume. Sabag et al. 2018 meta found splitting by group reduced interference by half.
4. **Session-RPE (Foster) is the best practical predictor** of next-day endurance readiness. Foster 2001 (Med Sci Sports Exerc): sRPE > ~180 AU (RPE × min) → 5–10 % next-day decrement, r = −0.72. Hammert et al. 2021 (Int J Sports Physiol Perform): sRPE r = 0.68 vs raw RPE r = 0.45. **In-session HRV correlates poorly** (r < 0.3, Flatt 2019) — useful for overnight recovery, not next-day endurance.
5. **Practical thresholds** (Foster, Halson 2014 review): sRPE < 15 AU = next-day OK; 15–18 AU = light next-day; > 18 AU = full 48 h.

   *Note*: the engine's existing thresholds (`>200 moderate`, `>400 hard` in `assessStrainFromSessionRpe`) are sized for RPE × moving-time-in-**minutes**, which is the Foster convention. After today's units fix (`1cadc9e`), they map to reasonable categories. The Foster "AU" values quoted in the literature look small (15, 18) because some studies normalise; for a 30 min session at RPE 6 the literature uses 180 AU, consistent with our 200-threshold.

Taken together: **literature strongly endorses lower vs upper differentiation**, supports the existing 2-day rule as conservative-but-correct *for lower body*, and supports loosening it for upper-only sessions.

---

## Variant comparison

Four candidates considered. Each is scored against five criteria.

| | A — Binary classifier + volume strain | B — Granular weighted overlap | C — Time-decay attenuation | D — Wait for RPE coverage |
|---|---|---|---|---|
| **Code volume** | ~250 LOC | ~400 LOC | ~300 LOC | ~100 LOC |
| **Lookup-table size** | 7 entries today, grows linearly | 20+ entries, grows fast | 7 entries | 0 |
| **Literature support** | Strong (Blagrove RCT) | Over-fitted vs evidence | Weak — no decay-curve studies cited | n/a |
| **Backtest delta on user data** | Same as current for 3 real sessions (all mixed) | Same | Same | None — no rule change |
| **Behaviour when data missing** | Falls back to current blunt rule | Same fallback, more code paths | Same | Unchanged |
| **Debugability** | High — one rule, two outcomes | Medium — weights are opaque | Low — fatigue is a hidden curve | Trivial |
| **Risk of false negative** (gating too loose) | Low — lower-body sessions still gate | Low | Medium — decay parameters matter | None (status quo) |
| **Risk of false positive** (gating too tight) | Low — upper-only doesn't gate | Low | Medium | None |
| **Implementation hours** | 3–4 | 6–8 | 5–6 | 1 |

**Variant A wins on cost / benefit for this user, this volume, this evidence base.**

The pivot is that on the user's actual sessions, A and B produce identical decisions (all real sessions hit lower body). The granularity in B pays off only on hypothetical pure-upper sessions that don't exist in the user's history. C's time-decay is conceptually nice but introduces hyperparameters with no calibration data (half-life? floor? interaction with sleep-debt and HRV components?). D defers the question entirely and is too conservative given Phase 1 is already cheap.

---

## Why split into Phase 1 and Phase 2

Phase 1 (Promus ingestion + objective-volume strain tier between current tier-2 and tier-3) is **value-creating on its own**, even without muscle-group awareness. It unblocks the cascade for every Palaestra-logged session, regardless of whether the user remembers to log RPE. The strain thresholds (5 sets / 10 min = `light`, 5–15 sets / 10–30 min = `moderate`, 15+ sets or 30+ min = `hard`) are calibrated from the user's three real sessions and the Foster sRPE thresholds.

Phase 2 (muscle-group filter) is **value-creating only conditionally** — when the user does a same-day upper-only session, OR when overall volume grows enough that muscle-group differentiation produces measurable category lifts. Today neither condition holds.

Shipping them together couples two risks. Shipping Phase 1 first lets us watch the cascade actually classify a few real sessions before adding the next layer.

### Phase 1 — concrete shape

Files:
- `src/promus/client.ts` — read-only HTTP client. Methods: `listStrengthSessions(serial, since, until)`, `getStrengthSession(id)`. Bearer auth from `PROMUS_API_KEY` env var. Mirrors `src/stryd/client.ts`. ~120 LOC + tests.
- `src/engine/cross-training-strain.ts` — add a new tier between current tier 2 and tier 3:
  ```typescript
  // Tier 2.5: objective volume strain from Promus session detail
  if (promusSession) {
      const sets = promusSession.sets?.length ?? 0;
      const durationMin = (Date.parse(promusSession.ended_utc) - Date.parse(promusSession.started_utc)) / 60000;
      if (sets >= 15 || durationMin >= 30) return { ...base, level: "hard", source: "volume" };
      if (sets >= 5 && durationMin >= 10) return { ...base, level: "moderate", source: "volume" };
      return { ...base, level: "light", source: "volume" };
  }
  ```
- `src/engine/suggest.ts` — fetch Promus session before strain assessment for each `WeightTraining` activity in the 14-day window. Match by `started_utc` within ±5 min. Cached for the prescription cycle.
- `src/users.ts` — add `promusSerial` to user profile (only `palaestra-ios` for now, but the field is per-user).

Tests: 5–6 new vitest cases covering each tier transition + the unknown-when-no-Promus-session fallback + the within-5-min match window.

### Phase 2 — concrete shape (after Phase 1 settles)

Files:
- `src/engine/cross-training-musculature.ts` — exercise → muscle-group classifier:
  ```typescript
  const MUSCLE_GROUPS: Record<string, string[]> = {
      "back squat": ["lower"],
      "deadlift": ["lower", "core"],
      "leg curl": ["lower"],
      "leg extension": ["lower"],
      "bench press": ["upper"],
      "high row": ["upper"],
      "barbell row": ["upper"],
      // Grow as new exercises appear.
  };
  function classifySession(exercises: string[]): string[] {
      const groups = new Set<string>();
      for (const ex of exercises) {
          const key = ex.toLowerCase().trim();  // <- handles the trailing-space bug
          for (const g of MUSCLE_GROUPS[key] ?? ["unknown"]) groups.add(g);
      }
      return [...groups];
  }
  ```
- `CrossTrainingStrain` type gains `muscle_groups?: string[]`.
- `daysSinceHardCrossTraining` takes the prescription sport's primary musculature and filters strain entries to those with overlap. Run primary = `["lower"]`. Swim primary = `["upper"]`. No overlap → don't count.
- Fallback: when `muscle_groups` includes `"unknown"` or is empty, preserve current blunt counting (conservative).

Tests: same fixtures as Phase 1 plus muscle-group-classification tests.

---

## Open questions

1. **Promus exercise vocabulary control** — should Palaestra constrain exercise names to a fixed list (closing the `"High row"` / `"High row "` data-hygiene bug at source), or should Exercitator's classifier normalise? I'd recommend Palaestra-side normalisation because the exercise list lives there; Exercitator just consumes.
2. **RPE capture path** — given that none of the real sessions has `rpe` logged in Promus, is the right next step a Palaestra-side end-of-session RPE prompt, or do we rely on the existing `submit_cross_training_rpe` MCP/HTTP tool? The literature says sRPE is the gold-standard predictor — worth getting it in for cases where the volume tier is borderline.
3. **WHOOP overnight recovery as a separate readiness input** — the `reference_hrv_capture_constraints` memory notes WHOOP only captures HRV at rest under 70 bpm, useless in-session. But WHOOP's overnight recovery score *is* a strain indicator that Promus already collects (per `last_whoop_at` in dashboard). Should this feed readiness directly as a fifth subjective-style component, separately from cross-training-strain? Probably a separate issue.
4. **Sport-musculature map for cycling** — the engine treats Cycling as `Ride` activities currently not prescribed. If/when Ride prescriptions land, the map needs `Ride = ["lower"]` (legs) — slightly different muscle emphasis from Run but same primary.

---

## Decision request

Per this analysis I'd recommend:

1. Update [exercitator#33](https://github.com/zestuart/exercitator/issues/33) to reflect the two-phase scope, splitting it into #33 (Phase 1) and a new #34 (Phase 2).
2. Open a Palaestra/Promus-side issue for the data-hygiene + RPE-capture concerns (questions 1 and 2 above).
3. Implement Phase 1 in a single ~3–4 hour session. Backtest against the three real sessions before deploying.
4. Wait at least 4 weeks of real training data with Phase 1 live before deciding whether to land Phase 2 — gives the cascade time to fire on real strain signal and reveals whether the user actually has any pure-upper sessions.

This document is the record. Awaiting decision before any further code work on this.
