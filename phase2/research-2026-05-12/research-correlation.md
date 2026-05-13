# Cross-correlation: intervals.icu WeightTraining ↔ Promus strength sessions

Window: intervals.icu 2026-03-13 → 2026-05-13 (60 days); Promus 2026-02-12 → 2026-05-13 (90 days).
Match rule: closest `started_utc` within ±10 min.

## Matches (3)

| intervals.icu id | Promus session_id (prefix) | Δ (min) | sets | top-5 exercises (by frequency) |
|---|---|---:|---:|---|
| `i141282265` (2026-04-19 21:54 UTC) | `BA2EAB58` | 0.0 | 12 | Deadlift (3), Back Squat (3), Bench Press (3), Barbell Row (3) |
| `i142973250` (2026-04-25 21:40 UTC) | `894A5D40` | 0.0 | 12 | High row (3), Back Squat (3), Bench Press (3), Deadlift (3) |
| `i147390366` (2026-05-11 21:56 UTC) | `ACAEC12D` | 0.3 | 16 | High row (4), Deadlift (3), Bench Press (3), Leg curl (3), Leg extension (2) |

All three matches landed within 20 seconds — clean correspondence on the days both systems were running.

## Unmatched intervals.icu WeightTraining (3)

These three weights sessions exist on intervals.icu but **no Promus session** (Promus only began collecting these workouts after ~2026-04-13, before that there is no Palaestra data):

| intervals.icu id | start (local) | source | external_id |
|---|---|---|---|
| `i132394917` | 2026-03-16 02:16 | GARMIN_CONNECT | `22189742784` |
| `i134136103` | 2026-03-23 02:20 | GARMIN_CONNECT | `22269304797` |
| `i135884771` | 2026-03-30 09:21 | UPLOAD | `Monday Morning Strength Training.fit` |

`session_rpe` is present on all three (147 / 204 / 249), so the engine's tier-2 cascade could classify these without Promus help. None show Palaestra as device — they predate Promus integration.

## Unmatched Promus sessions (4)

All four unmatched Promus sessions are tiny calibration / test artefacts from 2026-04-13 and 2026-04-19:

| Promus session_id (prefix) | start UTC | sets | duration |
|---|---|---:|---|
| `7A3E6F86` | 2026-04-13 22:50 | 1 | 1.2 min |
| `71CDACDE` | 2026-04-13 22:51 | 1 | 0.8 min |
| `2B08CD83` | 2026-04-13 22:58 | 2 | 0.2 min |
| `6A4C3647` | 2026-04-19 21:48 | 1 | 0.1 min |

These would never reach intervals.icu (too short to be a real workout). The 2026-04-19 single-set session sits 6 minutes before the matched `BA2EAB58`, so it is clearly a pre-session test of the app.

## Asymmetry summary

- intervals.icu has 3 pre-Promus weight sessions (Mar 16, 23, 30) — Promus side is empty there.
- Promus has 4 test sessions — intervals.icu side is empty there (correctly).
- 3 real bilateral matches with set-level exercise data on the Promus side and HR + intensity on the intervals.icu side. These are the rows a backtest can join confidently.
