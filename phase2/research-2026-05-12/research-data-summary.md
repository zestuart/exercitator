# Research data summary — Promus + intervals.icu (2026-02-12 → 2026-05-13)

Data files:
- `/tmp/research-promus-sessions.json` — 7 Promus sessions (90 days)
- `/tmp/research-iv-activities.json` — 54 intervals.icu activities (60 days)
- `/tmp/research-iv-wellness.json` — 62 wellness records (60 days)
- `/tmp/research-correlation.md` — bilateral match table
- `/tmp/research_analyse.py` + `/tmp/research-analyse-output.txt` — analysis script and full output

---

## 1. Exercise vocabulary

Aggregated set counts across all Promus sessions (note: `High row` and `High row ` (trailing space) and `Leg extension` / `Leg extension ` collide as separate keys in the upstream data — data-cleansing concern for the backtest):

| Count | Exercise | First-pass class |
|---:|---|---|
| 11 | Back Squat | lower |
| 9 | Deadlift | lower+core |
| 9 | Bench Press | upper |
| 4 | High row | upper |
| 3 | High row (trailing space) | upper |
| 3 | Leg curl | lower |
| 3 | Barbell Row | upper |
| 2 | Leg extension | lower |
| 1 | Leg extension (trailing space) | lower |

Lower-body bias: 25/45 sets (56%) are lower-body; 19/45 (42%) upper-body. No core-only or unknown exercises observed.

## 2. Cross-training cadence

- 7 sessions over 12.9 weeks = **0.54 sessions / week**, well below a typical 2×/week strength prescription for an endurance athlete.
- But: real-vs-test split — only 3 of the 7 are full sessions (12–16 sets, 25–28 min). The other 4 are calibration artefacts (1–2 sets, <2 min). True cadence is **~0.23 real sessions / week** (≈1 every 4 weeks).
- Gaps between sessions (any kind): min 0d, max 16d, mean 4.7d. Gaps between *real* sessions: 6d (Apr 19 → Apr 25), 17d (Apr 25 → May 12).
- RPE present: 3/7 (43%) — and **only on the calibration micro-sessions**. Zero real sessions have RPE set. This is the critical data gap for the strain cascade.
- intervals.icu shows 6 WeightTraining activities in the 60-day window (cadence ~1×/week from intervals' perspective), but 3 of those predate Promus and the other 3 are the matched pairs above.

Implication for the backtest: the user's strength cadence is too sparse and the Promus RPE field is too empty to validate any cascade tier purely against historical data without enriching the missing RPE.

## 3. Engine-fire frequency

Engine rules touched by weight sessions:
- **Same-day cap**: hard weight → recovery; moderate → base.
- **Cross-training hard-session guard**: moderate/hard weight session in last 2 days prevents intensity.

Currently, both rules fall through to `awaiting_input` for the user because the cascade lands at tier-3 (no in-session HRV, no `session_rpe` on Palaestra-source uploads, no Promus RPE).

Counterfactual: if every Promus session were classified at least "moderate":
- Over the 60-day Run prescription window, **11 / 62 days (18%)** would have the 2-day rule fire.
- All 11 days cluster around the three real sessions (Apr 19, Apr 25, May 12) — each casts a 3-day shadow.
- Combined with the 7/11 hard runs already in the window, this is a meaningful gating signal — but only for an athlete who actually lifts weekly, which this user does not yet.

A blunt 2-day rule fires on 18% of days when fed the real session list; on this user's current cadence that's roughly the right order of magnitude — but the bigger problem is the absence of any RPE signal, not the rule's bluntness.

---

## Headline counts

| Metric | Value |
|---|---|
| Promus sessions (90d) | 7 (3 real, 4 calibration) |
| Distinct exercises | 7 (9 keys due to trailing-space duplication) |
| Promus sessions with RPE | 3 / 7, all calibration |
| intervals.icu activities (60d) | 54 |
| intervals.icu WeightTraining | 6 (3 Garmin/legacy + 3 Palaestra-matched) |
| Hard runs (engine heuristic) | 7 / 11 |
| Cross-correlation matches (±10 min) | 3 |
| Days the 2-day rule would fire (60d, counterfactual) | 11 / 62 (18%) |
