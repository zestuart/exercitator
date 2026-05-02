# Daily Suggested Workout — Implementation Specification

## Overview

Add a new MCP tool `suggest_workout` to Exercitator that generates a personalised
daily workout recommendation for running or swimming. The tool analyses 14 days of
activity history and 7 days of wellness data from intervals.icu, then applies a
decision engine modelled on Garmin's Daily Suggested Workout algorithm (Firstbeat
Analytics) to produce a structured workout with warm-up, main set, and cool-down.

This is a **read-only advisory tool** — it does not create calendar events. The
user can separately call `create_event` to push the workout to their calendar if
they choose.

---

## 1. New files

### `src/engine/`

Create a new directory `src/engine/` containing the decision logic, kept separate
from MCP tool registration so it can be unit-tested independently.

#### `src/engine/types.ts`

Define the following TypeScript types/interfaces:

```typescript
/** Activity summary as returned by intervals.icu list_activities */
interface ActivitySummary {
  id: string;
  start_date_local: string;          // ISO 8601
  type: string;                       // "Run", "Swim", "VirtualRun", etc.
  moving_time: number;                // seconds
  distance: number;                   // metres
  icu_training_load: number;          // impulse-response training load
  icu_atl: number;                    // acute training load at time of activity
  icu_ctl: number;                    // chronic training load at time of activity
  average_heartrate: number | null;
  max_heartrate: number | null;
  icu_hr_zone_times: number[] | null; // seconds in each HR zone
  perceived_exertion: number | null;  // 1-10 RPE
}

/** Wellness record for a single day */
interface WellnessRecord {
  id: string;                         // YYYY-MM-DD
  ctl: number | null;                 // fitness (chronic training load)
  atl: number | null;                 // fatigue (acute training load)
  restingHR: number | null;           // bpm
  hrv: number | null;                 // rMSSD ms
  sleepSecs: number | null;           // total sleep seconds
  sleepScore: number | null;          // Garmin sleep score (if synced)
  readiness: number | null;           // 1-10
  weight: number | null;              // kg
  soreness: number | null;            // 1-10
  fatigue: number | null;             // 1-10
  stress: number | null;              // 1-10
}

/** Sport-specific settings from intervals.icu */
interface SportSettings {
  type: string;                       // "Run", "Swim"
  ftp: number | null;                 // functional threshold power/pace
  lthr: number | null;                // lactate threshold HR
  threshold_pace: number | null;      // seconds per km (run) or m/s (swim — convert to s/100m via 100/x)
  hr_zones: number[] | null;          // HR zone boundaries
  pace_zones: number[] | null;        // pace zone boundaries
}

/** The six workout categories the engine can recommend */
type WorkoutCategory = "rest" | "recovery" | "base" | "tempo" | "intervals" | "long";

/** A single segment of a structured workout */
interface WorkoutSegment {
  name: string;                       // e.g. "Warm-up", "Main Set", "Cool-down"
  duration_secs: number;
  target_description: string;         // human-readable, e.g. "Z2 pace 5:30-5:50/km"
  target_hr_zone?: number;            // 1-5
  target_pace_secs?: number;          // secs/km or secs/100m
  repeats?: number;                   // for intervals: number of reps
  work_duration_secs?: number;        // for intervals: work segment duration
  rest_duration_secs?: number;        // for intervals: rest segment duration
}

/** Complete workout suggestion returned by the engine */
interface WorkoutSuggestion {
  sport: "Run" | "Swim";
  category: WorkoutCategory;
  title: string;                      // e.g. "Easy Base Run" or "Threshold Intervals"
  rationale: string;                  // why this workout was chosen
  total_duration_secs: number;
  estimated_load: number;             // expected training load
  segments: WorkoutSegment[];
  readiness_score: number;            // 0-100 computed readiness
  sport_selection_reason: string;     // why this sport was chosen over the other
  warnings: string[];                 // e.g. "HRV below baseline — consider extra rest"
}
```

#### `src/engine/readiness.ts`

Computes a **readiness score** (0–100) from wellness data. This is the primary
gate that determines workout intensity.

**Inputs:** Last 7 days of `WellnessRecord[]`, plus hours since last activity.

**Algorithm:**

```
readiness = weighted_sum(
  tsb_component     * 0.30,   // Training Stress Balance: CTL - ATL, normalised 0-100
  sleep_component   * 0.20,   // Last night's sleep score or duration, normalised
  hrv_component     * 0.20,   // Today's HRV vs 7-day rolling mean, normalised
  recency_component * 0.15,   // Hours since last activity, sigmoid around 24h
  subjective_component * 0.15 // Average of (10 - fatigue) + (10 - soreness) + readiness, normalised
)
```

**Normalisation rules:**

- **TSB**: TSB of +20 → 100, TSB of -20 → 0, linear between. Clamp to [0, 100].
  TSB = today's CTL - today's ATL from the most recent wellness record.
- **Sleep**: If `sleepScore` is available, use it directly (Garmin 0-100 scale).
  Otherwise, use `sleepSecs`: 8h+ → 100, 5h → 0, linear between.
- **HRV**: Compute 7-day mean HRV. Today's HRV as percentage of mean:
  ≥110% → 100, 100% → 75, 90% → 50, ≤75% → 0. Linear interpolation.
  If HRV data is missing, use 50 (neutral).
- **Recency**: Hours since last activity end time. Apply sigmoid:
  `100 / (1 + exp(-0.15 * (hours - 24)))`. This gives ~50 at 24h, ~88 at 36h,
  ~12 at 12h.
- **Subjective**: Average of available subjective fields (fatigue inverted,
  soreness inverted, readiness direct), all on 1-10 scale, normalised to 0-100.
  If none available, use 50 (neutral).

If fewer than 3 of the 5 components have real data, append a warning:
`"Limited wellness data — suggestion may be less accurate"`.

#### `src/engine/sport-selector.ts`

Determines whether today's workout should be **Run** or **Swim**.

**Algorithm:**

1. Compute per-sport ATL and CTL from the 14-day activity window. For each sport:
   - Filter activities to that sport's type list:
     - Run: `["Run", "VirtualRun", "TrailRun", "Treadmill"]`
     - Swim: `["Swim", "OpenWaterSwim", "VirtualSwim"]`
   - Sum `icu_training_load` for last 7 days → sport-specific acute load
   - Sum `icu_training_load` for last 14 days / 2 → sport-specific chronic load proxy

2. Compute **load deficit** for each sport:
   `deficit = chronic_load - acute_load`
   Higher deficit = more undertrained recently in that sport.

3. Select the sport with the **higher deficit** (the sport that has been
   relatively neglected).

4. **Tie-breaking rules:**
   - If both deficits are within 10% of each other, prefer the sport with fewer
     sessions in the last 7 days.
   - If still tied, prefer running (higher overall training stimulus).

5. **Override rules:**
   - If the last 3 consecutive activities were the same sport, suggest the other
     sport (prevent monotony).
   - If readiness_score < 30 and only one sport was done in the last 3 days,
     suggest the other sport (active recovery in a different modality).

Return: `{ sport: "Run" | "Swim", reason: string }`.

#### `src/engine/workout-selector.ts`

Maps readiness score + training context to a `WorkoutCategory`.

**Decision matrix:**

| Readiness | Recent pattern | Category |
|-----------|---------------|----------|
| 0–20 | Any | `rest` |
| 21–35 | Any | `recovery` |
| 36–50 | Any | `base` |
| 51–65 | No hard session in 2+ days | `tempo` |
| 51–65 | Hard session yesterday/today | `base` |
| 66–80 | No hard session in 2+ days | `intervals` |
| 66–80 | Hard session yesterday | `tempo` |
| 81–100 | No hard session in 3+ days | `intervals` |
| 81–100 | Hard session in last 2 days | `tempo` |

**"Hard session" definition:** Any activity with `icu_training_load > 0.7 * sport_ctl`
for that sport, OR `perceived_exertion >= 7`.

**Load focus balancing:** After the initial category selection, check the 14-day
distribution of HR zone time:
- If >70% of time is in zones 1-2 (low aerobic) → bias toward higher intensity
  categories (shift `base` → `tempo` if readiness allows)
- If >40% of time is in zones 4-5 (anaerobic) → bias toward lower intensity
  (shift `intervals` → `tempo`, `tempo` → `base`)
- These adjustments can only shift by one category level and must not violate
  readiness floor constraints.

**Long session logic:** Every 7 days, if no session in the last 7 days exceeded
90 minutes, and readiness ≥ 45, upgrade a `base` workout to `long`. This applies
to running only — swimming long sessions cap at 60 minutes.

#### `src/engine/workout-builder.ts`

Generates structured `WorkoutSegment[]` for each category × sport combination.

**Running workouts:**

All paces derived from intervals.icu sport settings. If `threshold_pace` is
available, derive zones from it. If not, use HR zones as fallback targets.

| Category | Structure |
|----------|-----------|
| `recovery` | 5min warm-up walk → 20-25min Z1 run (very easy) → 5min cool-down walk |
| `base` | 10min progressive warm-up (walk→Z1→Z2) → 25-40min Z2 steady → 5min cool-down |
| `tempo` | 10min warm-up → 2×(8-12min Z3 threshold / 3min Z1 recovery) → 5min cool-down |
| `intervals` | 10min warm-up → 5-8×(2-3min Z4 / 2min Z1 jog) → 10min cool-down |
| `long` | 10min warm-up → 50-80min Z2 (with optional 10min Z3 pickup in middle) → 10min cool-down |

**Swimming workouts:**

All paces derived from CSS (critical swim speed) via intervals.icu sport settings
for Swim. `threshold_pace` is stored in m/s; convert to s/100m via `100 / threshold_pace`,
then derive zones:
- Z1 recovery: CSS + 15-20s/100m
- Z2 endurance: CSS + 8-12s/100m
- Z3 threshold: CSS ± 3s/100m
- Z4 VO2max: CSS - 5-8s/100m

| Category | Structure |
|----------|-----------|
| `recovery` | 200m easy free → 4×50m drill/swim on :15 rest → 400m pull Z1 → 200m easy cool-down |
| `base` | 300m warm-up (100 free/100 kick/100 pull) → 6×200m Z2 on :20 rest → 200m cool-down |
| `tempo` | 300m warm-up → 4×200m Z3 descending on :30 rest → 4×50m Z4 on :20 rest → 200m cool-down |
| `intervals` | 300m warm-up → 8×100m Z4 on :15 rest → 200m easy → 4×50m sprint on :30 rest → 200m cool-down |
| `long` | 400m warm-up → 2000-3000m continuous Z2 (broken into 400m segments with :10 rest) → 200m cool-down |

**Duration scaling:** All durations are scaled by `current_ctl / 50`, clamped to
[0.6, 1.5]. An athlete with CTL 25 gets 60% of the default duration. An athlete
with CTL 75 gets the full duration. This prevents suggesting a 90-minute long run
to someone with low base fitness.

**Estimated load:** Use a rough heuristic:
`estimated_load = duration_minutes * intensity_factor`
Where intensity_factor is: recovery=0.5, base=0.7, tempo=1.0, intervals=1.2, long=0.8.

#### `src/engine/suggest.ts`

Top-level orchestrator. This is the function the MCP tool calls.

```typescript
async function suggestWorkout(
  client: IntervalsClient
): Promise<WorkoutSuggestion>
```

**Steps:**

1. Fetch in parallel:
   - `GET /athlete/{id}/activities?oldest=<14d ago>&newest=<today>&fields=id,start_date_local,type,moving_time,distance,icu_training_load,icu_atl,icu_ctl,average_heartrate,max_heartrate,icu_hr_zone_times,perceived_exertion`
   - `GET /athlete/{id}/wellness?oldest=<7d ago>&newest=<today>`
   - `GET /athlete/{id}/sport-settings/Run`
   - `GET /athlete/{id}/sport-settings/Swim`

2. Call `computeReadiness(wellnessRecords, activities)` → readiness_score + warnings
3. Call `selectSport(activities)` → sport + reason
4. Call `selectWorkoutCategory(readiness_score, activities, sport)` → category
5. Call `buildWorkout(category, sport, sportSettings, readiness_score, ctl)` → segments
6. Assemble and return `WorkoutSuggestion`

### `src/tools/suggest.ts`

New MCP tool registration file.

```typescript
export function registerSuggestTools(server: McpServer, client: IntervalsClient): void {
  server.tool(
    "suggest_workout",
    "Generate a personalised daily workout suggestion based on recent training load, " +
    "wellness data, and recovery status. Analyses 14 days of activities and 7 days of " +
    "wellness data to recommend a running or swimming workout with structured warm-up, " +
    "main set, and cool-down. Does not create a calendar event — use create_event " +
    "separately to add the workout to your calendar.",
    {},
    async () => {
      const suggestion = await suggestWorkout(client);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(suggestion, null, 2)
        }]
      };
    }
  );
}
```

Register in `src/index.ts` alongside the existing tool registrations:
```typescript
import { registerSuggestTools } from "./tools/suggest.js";
// ... in the server setup:
registerSuggestTools(server, client);
```

---

## 2. Tests

Create `tests/engine/` mirroring the engine structure.

### `tests/engine/readiness.test.ts`

Test cases:

1. **Full wellness data, well-rested**: Sleep 8h, HRV 10% above mean, TSB +10,
   36h since last activity → readiness ~80-90.
2. **Poor sleep, high fatigue**: Sleep 4h, HRV 20% below mean, TSB -15,
   8h since last activity, fatigue 8/10 → readiness ~15-25.
3. **Missing data gracefully**: Only TSB and sleep available, all else null →
   uses neutral 50 for missing components, emits warning.
4. **Edge case — no activities in 14 days**: recency component maxes out,
   TSB defaults to CTL (no fatigue) → readiness high.
5. **Edge case — empty wellness array**: All components default to neutral 50.

### `tests/engine/sport-selector.test.ts`

Test cases:

1. **Swim-heavy week**: 5 swim sessions, 1 run → suggests Run (higher deficit).
2. **Balanced week**: 3 runs, 3 swims, similar load → tie-break by session count
   or default to Run.
3. **Monotony override**: Last 3 activities all Run → suggests Swim regardless
   of load balance.
4. **Low readiness cross-training**: readiness < 30, only ran in last 3 days →
   suggests Swim.
5. **No activities at all**: Both deficits 0 → defaults to Run.

### `tests/engine/workout-selector.test.ts`

Test cases for the decision matrix — one per row minimum:

1. Readiness 15 → rest
2. Readiness 25 → recovery
3. Readiness 45 → base
4. Readiness 60, no hard session in 3 days → tempo
5. Readiness 60, hard session yesterday → base
6. Readiness 75, no hard session in 2 days → intervals
7. Readiness 90, hard session yesterday → tempo
8. Load focus override: 80% Z1-Z2 time + readiness 55 → bumped from base to tempo
9. Long session trigger: no >90min session in 7 days + readiness 50 → long

### `tests/engine/workout-builder.test.ts`

Test cases:

1. **Run recovery**: Produces 3 segments (warm-up, main, cool-down), total ≤ 35min.
2. **Run intervals**: Produces warm-up, interval set with repeats, cool-down.
   Interval paces reference threshold_pace if available.
3. **Swim base**: Produces structured set with distances in metres.
4. **Duration scaling**: CTL 25 produces ~60% duration of CTL 75.
5. **Missing pace data**: Falls back to HR zone targets instead of pace.
6. **Estimated load**: Within ±20% of expected heuristic value.

### `tests/engine/suggest.test.ts`

Integration test with mocked `IntervalsClient`:

1. Mock all four API calls with realistic fixture data.
2. Verify the full pipeline produces a valid `WorkoutSuggestion` with all
   required fields populated.
3. Verify sport_selection_reason is non-empty.
4. Verify segments array is non-empty and durations sum to total_duration_secs.

---

## 3. Fixture data

Create `tests/fixtures/` with:

- `activities-14d.json` — 14 days of mixed Run + Swim activities (8-12 entries)
  with realistic training loads (40-120), HR zone times, and perceived exertion.
- `wellness-7d.json` — 7 days of wellness records with resting HR (~52-58bpm),
  HRV (~45-65ms), sleep (6-8h), and some null fields.
- `sport-settings-run.json` — Run sport settings with threshold_pace, HR zones,
  pace zones.
- `sport-settings-swim.json` — Swim sport settings with threshold_pace (CSS),
  HR zones.

Use the actual intervals.icu API response shapes. Fetch a real example from the
API first if uncertain about field names — the existing tools in
`src/tools/activities.ts` and `src/tools/wellness.ts` already call these
endpoints, so inspect the response schemas from the intervals.icu API docs at
`https://intervals.icu/api-docs.html`.

---

## 4. Implementation sequence

Execute in this order. Run `/test` after each step.

1. Create `src/engine/types.ts` with all type definitions.
2. Create `tests/fixtures/` with mock data files.
3. Implement `src/engine/readiness.ts` + `tests/engine/readiness.test.ts`.
4. Implement `src/engine/sport-selector.ts` + `tests/engine/sport-selector.test.ts`.
5. Implement `src/engine/workout-selector.ts` + `tests/engine/workout-selector.test.ts`.
6. Implement `src/engine/workout-builder.ts` + `tests/engine/workout-builder.test.ts`.
7. Implement `src/engine/suggest.ts` + `tests/engine/suggest.test.ts`.
8. Create `src/tools/suggest.ts` and register in `src/index.ts`.
9. Update `CHANGELOG.md` with the new feature.
10. Update `README.md` MCP tools table with `suggest_workout`.
11. Run `/test` for final validation.

---

## 5. Design constraints

- **No new dependencies.** The engine is pure computation over JSON. No ML
  libraries, no Firstbeat SDK, no external services beyond the existing
  intervals.icu API calls via `IntervalsClient`.
- **Follows existing patterns.** Tool registration in `src/tools/suggest.ts`
  matches the pattern in `src/tools/athlete.ts`. Zod validation on inputs (none
  needed here since the tool takes no parameters). Error propagation via thrown
  `Error` objects.
- **British English** in all user-facing strings (rationale, warnings, segment
  descriptions).
- **ISO 8601 dates** throughout. Use `toISOString().slice(0, 10)` for date-only
  strings.
- **Biome-clean.** All new code must pass `npx biome check .` without errors.
- **TypeScript strict mode.** No `any` types. Explicit null handling on all
  optional wellness fields.
- **Testable in isolation.** Engine functions take data as arguments, not the
  client directly (except `suggest.ts` orchestrator). This enables unit tests
  with fixture data and no API mocking at the individual module level.

---

## 6. Garmin DSW algorithm reference

The implementation mirrors Garmin's Firstbeat-powered Daily Suggested Workout
system with these adaptations:

| Garmin input | Exercitator equivalent | Source |
|-------------|----------------------|--------|
| Training Load | `icu_training_load` per activity | activities endpoint |
| Training Load Focus (low/high aerobic, anaerobic) | `icu_hr_zone_times` distribution | activities endpoint |
| Recovery Time | Modelled via TSB + hours since last activity | wellness + activities |
| VO2 Max trend | Not modelled (v1) — could use power curve trends later | — |
| Training Status | Approximated via CTL trend (rising/flat/falling) | wellness endpoint |
| Sleep Quality | `sleepScore` or `sleepSecs` | wellness endpoint |
| HRV Status | `hrv` vs 7-day rolling mean | wellness endpoint |
| Training Readiness | Composite readiness_score (see readiness.ts) | computed |
| Race/Event Goals | Not modelled (v1) — general fitness mode only | — |

Garmin generates both running and cycling workouts daily; this implementation
generates one workout per invocation for either running or swimming, selecting the
sport algorithmically based on load balance.

---

## 7. Future enhancements (out of scope for v1)

- **VO2 max trending**: Use power curve data over time to detect fitness trajectory
  and adjust periodisation.
- **Event-targeted periodisation**: If a race event exists on the intervals.icu
  calendar, shift the workout mix toward race-specific preparation.
- **Workout execution scoring**: After the suggested workout is completed, compare
  actual zone times to prescribed zones and compute adherence.
- **Cycling support**: Add cycling as a third sport option with power-based
  workout prescription.
- **Calendar integration**: Automatically push the suggestion as a planned workout
  event via `create_event`.
- **Multi-day lookahead**: Generate a 3-5 day workout schedule rather than just
  today's session.
