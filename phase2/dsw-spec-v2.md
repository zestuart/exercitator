# Daily Suggested Workout — Implementation Specification v2

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

## Changelog from v1

| Change | Reason |
|--------|--------|
| Added `src/engine/power-source.ts` | Garmin native power reads ~13–30% higher than Stryd; intervals.icu defaults to Garmin power, corrupting load calculations when athlete trains with Stryd |
| Added `power_source` and `power_correction_factor` to types | Engine must know which power ecosystem targets are expressed in |
| Changed FTP reference from `icu_ftp` to `icu_rolling_ftp` | `icu_ftp` was stale (292W); `icu_rolling_ftp` (322W) tracks current fitness |
| Added `terrain` field to `WorkoutSuggestion` | Terrain guidance was buried in rationale text; needs first-class status |
| Added `structured_steps` field to `WorkoutSuggestion` | Text-only workout descriptions produce empty graphs in intervals.icu and fail to push to Garmin/Suunto |
| Moved biomechanical stream analysis to v2 | Stryd LSS/ILR and Garmin GCT/VO streams deferred |
| Added power source detection tests | Validate fallback chain Stryd → Garmin → HR-only |

---

## 1. New files

### `src/engine/`

Create a new directory `src/engine/` containing the decision logic, kept separate
from MCP tool registration so it can be unit-tested independently.

#### `src/engine/types.ts`

```typescript
/** Activity summary as returned by intervals.icu list_activities */
export interface ActivitySummary {
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
  power_load: number | null;          // power-based training load
  hr_load: number | null;             // HR-based training load (HRSS)
  icu_weighted_avg_watts: number | null; // normalised power
  icu_average_watts: number | null;
  icu_ftp: number | null;             // FTP used for this activity's analysis
  icu_rolling_ftp: number | null;     // rolling eFTP (auto-detected, current)
  power_field: string | null;         // which power stream was used: "power" or "Power"
  stream_types: string[] | null;      // available data streams in the FIT file
  device_name: string | null;         // e.g. "Garmin Forerunner 970"
}

/** Wellness record for a single day */
export interface WellnessRecord {
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
export interface SportSettings {
  type: string;                       // "Run", "Swim"
  ftp: number | null;                 // configured FTP
  lthr: number | null;                // lactate threshold HR
  threshold_pace: number | null;      // seconds per km (run) or m/s (swim — convert to s/100m via 100/x)
  hr_zones: number[] | null;          // HR zone boundaries
  pace_zones: number[] | null;        // pace zone boundaries
  power_zones: number[] | null;       // power zone boundaries (% of FTP)
}

/** Power source detection result */
export type PowerSource = "stryd" | "garmin" | "none";

export interface PowerContext {
  source: PowerSource;                // detected primary power source
  ftp: number;                        // FTP in the detected source's scale
  rolling_ftp: number | null;         // rolling eFTP if available
  correction_factor: number;          // multiplier to convert from Garmin→Stryd scale (1.0 if Stryd, ~0.87 if Garmin, N/A if none)
  confidence: "high" | "low";         // high if source confirmed, low if inferred
  warnings: string[];
}

/** The six workout categories the engine can recommend */
export type WorkoutCategory = "rest" | "recovery" | "base" | "tempo" | "intervals" | "long";

/** Terrain guidance */
export type TerrainPreference = "flat" | "rolling" | "hilly" | "trail" | "any";

/** A single segment of a structured workout */
export interface WorkoutSegment {
  name: string;                       // e.g. "Warm-up", "Main Set", "Cool-down"
  duration_secs: number;
  target_description: string;         // human-readable, e.g. "Z2 power 160–186W"
  target_hr_zone?: number;            // 1-5
  target_power_low?: number;          // watts (in athlete's power source scale)
  target_power_high?: number;         // watts
  target_pace_secs_low?: number;      // secs/km or secs/100m
  target_pace_secs_high?: number;
  repeats?: number;                   // for intervals: number of reps
  work_duration_secs?: number;        // for intervals: work segment duration
  rest_duration_secs?: number;        // for intervals: rest segment duration
}

/** Complete workout suggestion returned by the engine */
export interface WorkoutSuggestion {
  sport: "Run" | "Swim";
  category: WorkoutCategory;
  title: string;                      // e.g. "Easy Aerobic Run" or "Threshold Intervals"
  rationale: string;                  // why this workout was chosen
  total_duration_secs: number;
  estimated_load: number;             // expected training load (in athlete's power source scale)
  segments: WorkoutSegment[];
  readiness_score: number;            // 0-100 computed readiness
  sport_selection_reason: string;     // why this sport was chosen over the other
  terrain: TerrainPreference;         // terrain guidance for the session
  terrain_rationale: string;          // why this terrain was recommended
  power_context: PowerContext;        // which power source was used for targets
  warnings: string[];                 // e.g. "HRV below baseline — consider extra rest"
}
```

#### `src/engine/power-source.ts`

**Purpose:** Detect which running power ecosystem the athlete uses and ensure all
zone derivations, load calculations, and workout targets are expressed in that
ecosystem's scale.

**Background:** Garmin watches with Stryd foot pods record two independent power
streams into the FIT file:
- Garmin native power (wrist-based accelerometer model) — typically stored as
  lowercase `power` in the FIT record field
- Stryd power (foot pod IMU model) — typically stored as a CIQ developer field,
  surfaced in intervals.icu as uppercase `Power`

Garmin native power reads approximately 13–30% higher than Stryd for the same
effort. The exact offset varies by pace (larger at higher speeds) and terrain
(larger on hills). A single linear correction factor is an approximation.

intervals.icu defaults to Garmin native power unless the user manually selects
the Stryd field via Actions → Settings → Power Field on an activity. The
`power_field` property on the activity indicates which was used.

**Detection algorithm:**

```typescript
function detectPowerSource(activities: ActivitySummary[]): PowerContext
```

1. **Check recent activities for Stryd streams.** Look at the most recent 5 run
   activities. For each, check `stream_types` for Stryd-specific fields:
   `["StrydLSS", "StrydFormPower", "StrydILR"]`. If any are present, the athlete
   owns a Stryd.

2. **Check which power field is active.** Look at the most recent run activity's
   `power_field`. If it is `"Power"` (capital P), Stryd is the active power
   source for intervals.icu analysis. If it is `"power"` (lowercase), Garmin
   native is active.

3. **Determine FTP reference.**
   - If Stryd is the active source: use `icu_rolling_ftp` (or `icu_ftp` if
     rolling is null) directly — it's already in Stryd's scale.
   - If Garmin is the active source but Stryd streams exist (athlete forgot to
     switch): apply correction factor. `stryd_ftp = garmin_ftp * 0.87`. Emit
     warning: `"Power field is set to Garmin native but Stryd is connected.
     Zone targets converted using estimated 0.87 correction factor. Consider
     switching to Stryd as primary power field in intervals.icu."`.
   - If no Stryd streams exist: use Garmin FTP directly. All targets expressed
     in Garmin power.
   - If no power data at all: set source to `"none"`, prescribe by HR only.

4. **Fallback for individual activities without Stryd.** When computing load
   from historical activities, if a specific activity lacks Stryd streams
   (forgotten pod, dead battery), use `hr_load` for that activity instead of
   `power_load`. Emit warning: `"Activity {id} on {date} lacks Stryd data;
   HR-based load used."`.

**Correction factor calibration:**

The default Garmin→Stryd correction factor is `0.87` (derived from 203/229 =
0.886 from the 2026-03-24 run, rounded conservatively). This factor is applied
as a simple multiplier to all Garmin-derived power values when converting to
Stryd-equivalent.

Future enhancement: compute the correction factor dynamically from dual-stream
activities where both Garmin and Stryd data are present. Average the per-activity
ratio `stryd_avg_power / garmin_avg_power` across the last 10 dual-stream runs.

**Constants:**

```typescript
const STRYD_STREAM_MARKERS = ["StrydLSS", "StrydFormPower", "StrydILR"] as const;
const STRYD_POWER_FIELD = "Power";   // capital P — Stryd CIQ developer field
const GARMIN_POWER_FIELD = "power";  // lowercase — Garmin native
const DEFAULT_GARMIN_TO_STRYD_FACTOR = 0.87;
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
   - For load computation: use `hr_load` when `power_load` is null or when the
     activity lacks the athlete's preferred power source (per `PowerContext`).
     This ensures consistent load accounting across activities with and without
     Stryd data.
   - Sum load for last 7 days → sport-specific acute load
   - Sum load for last 14 days / 2 → sport-specific chronic load proxy

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

**"Hard session" definition:** Any activity with load > 0.7 × sport CTL (using
the load value appropriate to the `PowerContext` — `hr_load` if power source is
inconsistent), OR `perceived_exertion >= 7`.

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

#### `src/engine/terrain-selector.ts`

Determines terrain guidance for running workouts.

**Algorithm:**

1. For `recovery` and `base` categories: always recommend `"flat"`. Rationale:
   elevation-driven power spikes push intensity above the aerobic ceiling. The
   2026-03-24 run demonstrated this — a trail run prescribed as Z2 accumulated
   45% Z3 power zone time and 12% Z4 due to 92m elevation gain despite HR
   compliance.

2. For `tempo`: recommend `"flat"` or `"rolling"` depending on whether the
   athlete has recent trail/hilly runs. If the last 3 runs all had
   `total_elevation_gain < 30m`, suggest `"rolling"` for variety. Otherwise
   `"flat"`.

3. For `intervals`: always `"flat"`. Interval power targets require consistent
   terrain to execute accurately.

4. For `long`: recommend `"rolling"` or `"trail"` if the athlete regularly runs
   trails (>50% of runs in 14 days are `TrailRun`). Otherwise `"flat"`.

Return: `{ terrain: TerrainPreference, rationale: string }`.

#### `src/engine/workout-builder.ts`

Generates structured `WorkoutSegment[]` for each category × sport combination.

**Power zone derivation for running:**

Use `PowerContext.ftp` (already corrected for power source) as the reference.
Derive zones as percentages of FTP:
- Z1 recovery: < 55% FTP
- Z2 endurance: 55–75% FTP
- Z3 tempo/threshold: 76–90% FTP
- Z4 VO2max: 91–105% FTP
- Z5 sprint: > 105% FTP

If `PowerContext.source === "none"`, omit power targets entirely and use HR zones
only.

**Running workouts:**

| Category | Structure |
|----------|-----------|
| `recovery` | 5min walk → 20-25min Z1 power (< 55% FTP) / HR Z1. HR cap: bottom of Z2. → 5min walk |
| `base` | 10min progressive warm-up (walk→Z1→Z2) → 25-40min Z2 power (55-75% FTP) / HR Z1-low Z2. HR cap: top of Z1. → 5min cool-down |
| `tempo` | 10min warm-up → 2×(8-12min Z3 power (76-90% FTP) / HR Z2-Z3, 3min Z1 recovery) → 5min cool-down |
| `intervals` | 10min warm-up → 5-8×(2-3min Z4 power (91-105% FTP) / HR Z3-Z4, 2min Z1 jog) → 10min cool-down |
| `long` | 10min warm-up → 50-80min Z2 power (with optional 10min Z3 pickup at two-thirds) → 10min cool-down |

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
| `recovery` | 200m easy free → 4×50m drill/swim on :15 rest → 400m pull Z1 → 200m cool-down |
| `base` | 300m warm-up (100 free/100 kick/100 pull) → 6×200m Z2 on :20 rest → 200m cool-down |
| `tempo` | 300m warm-up → 4×200m Z3 descending on :30 rest → 4×50m Z4 on :20 rest → 200m cool-down |
| `intervals` | 300m warm-up → 8×100m Z4 on :15 rest → 200m easy → 4×50m sprint on :30 rest → 200m cool-down |
| `long` | 400m warm-up → 2000-3000m continuous Z2 (broken into 400m sets with :10 rest) → 200m cool-down |

**Duration scaling:** All durations are scaled by `current_ctl / 50`, clamped to
[0.6, 1.5]. An athlete with CTL 25 gets 60% of the default duration. An athlete
with CTL 75 gets the full duration.

**Estimated load:** Use a rough heuristic:
`estimated_load = duration_minutes * intensity_factor`
Where intensity_factor is: recovery=0.5, base=0.7, tempo=1.0, intervals=1.2, long=0.8.
When power source is Stryd, this should approximate the `hr_load` value
(validated against the 2026-03-24 run where HR load of 39 matched expectations).

**Dual-target prescription:** Every running workout segment should include BOTH
power and HR targets. The power target is primary (what the athlete executes
against on the Stryd app). The HR target is a safety cap — if HR exceeds the cap,
reduce power regardless of the power target. This pattern was validated in the
2026-03-24 run where HR compliance (129 avg, 143 max, all Z1) confirmed
appropriate effort despite power zone classification discrepancies.

#### `src/engine/suggest.ts`

Top-level orchestrator.

```typescript
async function suggestWorkout(
  client: IntervalsClient
): Promise<WorkoutSuggestion>
```

**Steps:**

1. Fetch in parallel:
   - `GET /athlete/{id}/activities?oldest=<14d ago>&newest=<today>&fields=id,start_date_local,type,moving_time,distance,icu_training_load,icu_atl,icu_ctl,average_heartrate,max_heartrate,icu_hr_zone_times,perceived_exertion,power_load,hr_load,icu_weighted_avg_watts,icu_average_watts,icu_ftp,icu_rolling_ftp,power_field,stream_types,device_name`
   - `GET /athlete/{id}/wellness?oldest=<7d ago>&newest=<today>`
   - `GET /athlete/{id}/sport-settings/Run`
   - `GET /athlete/{id}/sport-settings/Swim`

2. Call `detectPowerSource(activities)` → `PowerContext`
3. Call `computeReadiness(wellnessRecords, activities)` → readiness_score + warnings
4. Call `selectSport(activities, powerContext)` → sport + reason
5. Call `selectWorkoutCategory(readiness_score, activities, sport, powerContext)` → category
6. Call `selectTerrain(category, activities)` → terrain + terrain_rationale
7. Call `buildWorkout(category, sport, sportSettings, readiness_score, ctl, powerContext)` → segments
8. Assemble and return `WorkoutSuggestion`

### `src/tools/suggest.ts`

New MCP tool registration file.

```typescript
export function registerSuggestTools(server: McpServer, client: IntervalsClient): void {
  server.tool(
    "suggest_workout",
    "Generate a personalised daily workout suggestion based on recent training load, " +
    "wellness data, and recovery status. Analyses 14 days of activities and 7 days of " +
    "wellness data to recommend a running or swimming workout with structured warm-up, " +
    "main set, and cool-down. Detects power source (Stryd vs Garmin native) and " +
    "expresses all targets in the correct scale. Does not create a calendar event — " +
    "use create_event separately to add the workout to your calendar.",
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

### `tests/engine/power-source.test.ts`

Test cases:

1. **Stryd active, capital P field**: Activity has `power_field: "Power"` and
   Stryd stream markers present → source `"stryd"`, correction factor `1.0`,
   confidence `"high"`.
2. **Garmin active, Stryd available**: Activity has `power_field: "power"` but
   Stryd streams present → source `"stryd"`, correction factor `0.87` applied
   to FTP, confidence `"low"`, warning emitted about switching power field.
3. **Garmin only, no Stryd**: Activity has `power_field: "power"`, no Stryd
   stream markers → source `"garmin"`, correction factor `1.0`, confidence
   `"high"`.
4. **No power at all**: Activity has no power fields → source `"none"`,
   HR-only prescription.
5. **Mixed history**: 3 recent activities with Stryd, 2 without (forgotten pod) →
   source `"stryd"`, warnings for the 2 activities using HR-based load fallback.
6. **FTP selection**: When Stryd active, uses `icu_rolling_ftp` if available,
   falls back to `icu_ftp` if null.

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
6. **Mixed power sources in history**: Activities with and without Stryd use
   appropriate load values (power_load vs hr_load).

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

### `tests/engine/terrain-selector.test.ts`

Test cases:

1. Base category → `"flat"`.
2. Recovery category → `"flat"`.
3. Intervals category → `"flat"`.
4. Long category, >50% trail runs in 14 days → `"trail"`.
5. Long category, <50% trail runs → `"flat"`.
6. Tempo category, all recent runs flat → `"rolling"` for variety.

### `tests/engine/workout-builder.test.ts`

Test cases:

1. **Run recovery, Stryd power**: Produces 3 segments, power targets in Stryd
   scale (< 55% of Stryd FTP), total ≤ 35min. HR cap included.
2. **Run base, Stryd power**: Power targets 55-75% Stryd FTP. HR cap at top Z1.
3. **Run intervals, Garmin power (no Stryd)**: Power targets in Garmin scale.
   No correction factor applied.
4. **Run base, no power at all**: HR-only targets, no power fields in segments.
5. **Swim base**: Structured set with distances in metres, CSS-derived paces.
6. **Duration scaling**: CTL 25 produces ~60% duration of CTL 75.
7. **Estimated load**: Within ±20% of expected heuristic value.
8. **Dual targets always present for running**: Every run segment has both power
   range and HR cap (unless source is `"none"`).

### `tests/engine/suggest.test.ts`

Integration test with mocked `IntervalsClient`:

1. Mock all four API calls with realistic fixture data.
2. Verify the full pipeline produces a valid `WorkoutSuggestion` with all
   required fields populated, including `terrain` and `power_context`.
3. Verify sport_selection_reason is non-empty.
4. Verify segments array is non-empty and durations sum to total_duration_secs.
5. Verify power_context.source is populated and FTP is in correct scale.
6. Verify terrain is populated for running workouts.

---

## 3. Fixture data

Create `tests/fixtures/` with:

- `activities-14d.json` — 14 days of mixed Run + Swim activities (8-12 entries)
  with realistic training loads (40-120), HR zone times, perceived exertion,
  `power_load`, `hr_load`, `power_field`, and `stream_types`. Include at least:
  - 2 runs with Stryd streams (`power_field: "Power"`, Stryd markers in stream_types)
  - 1 run without Stryd (forgotten pod — `power_field: "power"`, no Stryd markers)
  - 2 swim activities
  - 1 weight training activity (non-sport, has HR but no power)
- `wellness-7d.json` — 7 days of wellness records with resting HR (~46-52bpm),
  HRV (~55-70ms), sleep (6-8h), sleep scores, and some null fields.
- `sport-settings-run.json` — Run sport settings with threshold_pace, HR zones,
  power zones. FTP ~248W (Stryd scale).
- `sport-settings-swim.json` — Swim sport settings with threshold_pace (CSS),
  HR zones.
- `activity-dual-power.json` — A single activity with both Garmin (229W avg) and
  Stryd (203W avg) power data, used for correction factor validation.

Use the actual intervals.icu API response shapes. The 2026-03-24 run activity
(id `i134468264`) is a good reference for field names and realistic values.

---

## 4. Implementation sequence

Execute in this order. Run `/test` after each step.

1. Create `src/engine/types.ts` with all type definitions.
2. Create `tests/fixtures/` with mock data files.
3. Implement `src/engine/power-source.ts` + `tests/engine/power-source.test.ts`.
4. Implement `src/engine/readiness.ts` + `tests/engine/readiness.test.ts`.
5. Implement `src/engine/sport-selector.ts` + `tests/engine/sport-selector.test.ts`.
6. Implement `src/engine/workout-selector.ts` + `tests/engine/workout-selector.test.ts`.
7. Implement `src/engine/terrain-selector.ts` + `tests/engine/terrain-selector.test.ts`.
8. Implement `src/engine/workout-builder.ts` + `tests/engine/workout-builder.test.ts`.
9. Implement `src/engine/suggest.ts` + `tests/engine/suggest.test.ts`.
10. Create `src/tools/suggest.ts` and register in `src/index.ts`.
11. Update `CHANGELOG.md` with the new feature.
12. Update `README.md` MCP tools table with `suggest_workout`.
13. Run `/test` for final validation.

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
- **Power source awareness throughout.** Every function that consumes or produces
  power values must accept a `PowerContext` and express targets in the correct
  scale. No function should assume a specific power source.

---

## 6. Garmin DSW algorithm reference

The implementation mirrors Garmin's Firstbeat-powered Daily Suggested Workout
system with these adaptations:

| Garmin input | Exercitator equivalent | Source |
|-------------|----------------------|--------|
| Training Load | `hr_load` or `power_load` (source-aware) | activities endpoint |
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

**Key difference from Garmin:** Garmin uses its own native power exclusively.
This implementation detects and adapts to Stryd power, which uses a different
biomechanical model producing lower absolute values. All zone boundaries and
load estimates are expressed in whichever power ecosystem the athlete uses.

---

## 7. Lessons from the 2026-03-24 run

This section documents findings from the first test run of a manually-created
workout prescription, to inform the engine's design.

### Power source mismatch

- **Symptom:** Workout prescribed Z2 power as 160–219W. Athlete ran with Stryd
  at 203W average (within band). intervals.icu reported 229W average / 234W NP,
  and computed `power_load` of 55 against a prescribed 35–40.
- **Root cause:** intervals.icu defaulted to Garmin native power (`power_field:
  "power"`) rather than Stryd (`"Power"`). Garmin power was ~13% higher.
- **Fix:** `power-source.ts` detects the active power field and corrects zone
  derivations accordingly. `hr_load` (39) validated the prescription was correct.

### Zone classification inflation

- **Symptom:** Power zone distribution showed 45% Z3, 12% Z4 despite HR being
  97% in zone 1.
- **Root cause:** Two compounding factors: (1) Garmin power was used for zone
  calculation, inflating all values; (2) trail terrain with 92m elevation gain
  caused power spikes on climbs regardless of cardiac effort.
- **Fix:** Dual-target prescription (power primary + HR safety cap) and terrain
  guidance as a first-class field.

### Structured workout format

- **Symptom:** The intervals.icu workout graph was empty. Suunto push failed
  with `"Invalid 'guide.steps': collection has less items than the allowed
  minimum (1)"`.
- **Root cause:** The workout was created via `create_event` with a text-only
  `description` field. The `workout_doc.steps` array was empty.
- **Fix:** Out of scope for `suggest_workout` (which is read-only) but noted as
  a requirement for future `push_workout` tool: must emit intervals.icu
  structured workout step format, not just text.

---

## 8. Future enhancements (out of scope for v1)

- **VO2 max trending**: Use power curve data over time to detect fitness
  trajectory and adjust periodisation.
- **Event-targeted periodisation**: If a race event exists on the intervals.icu
  calendar, shift the workout mix toward race-specific preparation.
- **Workout execution scoring**: After the suggested workout is completed,
  compare actual zone times to prescribed zones and compute adherence.
- **Cycling support**: Add cycling as a third sport option with power-based
  workout prescription.
- **Structured workout push**: A `push_workout` tool that converts
  `WorkoutSuggestion.segments` into intervals.icu `workout_doc.steps` format
  and creates a calendar event with a populated workout graph. Requires
  understanding the intervals.icu workout step schema.
- **Multi-day lookahead**: Generate a 3-5 day workout schedule rather than just
  today's session.
- **Dynamic correction factor**: Compute the Garmin→Stryd power correction
  factor from dual-stream activities rather than using the static 0.87 default.
- **Biomechanical stream analysis (v2)**: Consume Stryd LSS/ILR and Garmin
  GCT/VO streams to inform prescription:
  - Declining LSS over a run → muscular fatigue → inform recovery prescriptions
  - Elevated ILR after a break → injury risk → gate volume increases
  - GCT/VO efficiency metrics → form-focused drill prescriptions
