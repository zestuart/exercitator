# Injury Warning System — Implementation Specification

## Overview

Add a biomechanical injury warning system to Exercitator that detects abnormal
deviations in Stryd running metrics from the athlete's personal baseline,
surfaces alerts across three interfaces (Praescriptor, MCP tool, intervals.icu
wellness), and triggers protective intensity downshifts when alert severity is
high.

**Name**: Vigil (Latin: "watchman" — the system that watches for signs of harm)

**Principle**: Personal baseline deviation, not population thresholds. The
evidence (Malisoux et al. 2024, n=836; Davis & Gruber 2021) does not support
static asymmetry thresholds or absolute stiffness values as injury predictors.
What *does* have support is detecting sudden intra-individual deviation from
established patterns — when multiple metrics shift simultaneously, something
has changed that warrants caution.

---

## 1. Architecture

### 1.1 Data flow

```
Activity completed
  → Stryd sync (primary source for running metrics)
  → Praescriptor page load (or suggest_workout call) triggers pipeline
  → Enrichment pipeline runs (existing)
  → Vigil pipeline runs:
      1. Fetch FIT files from Stryd for recent runs (with local cache)
      2. Parse FIT developer fields → per-activity summary metrics
      3. Update 90-day deep baseline in SQLite (30-day rolling active window)
      4. Compare 7-day acute window against 30-day baseline
      5. Score deviation → alert severity (0–3)
      6. If severity ≥ 2: write to intervals.icu wellness `injury` field
      7. Pass alert to prescription engine for protective downshift
      8. Surface alert in MCP response / Praescriptor UI
```

### 1.2 Data source: Stryd FIT files (primary)

Running metric streams come directly from Stryd FIT files, **not** from the
intervals.icu streams API. This:

- Avoids intervals.icu API rate limits and per-second stream fetch costs
- Gives access to all Stryd developer fields (LSS, Form Power, ILR, Air Power)
- Uses infrastructure already in place for FIT enrichment
- Allows a deep 90-day backfill from Stryd on first run

**FIT parsing**: Use `fit-file-parser` npm package to extract per-second
records and developer fields from Stryd FIT files. The enrichment pipeline
already downloads these files — Vigil hooks into the same flow.

**Backfill strategy**:
- **First run**: Fetch last 90 days of FIT files from Stryd, parse all,
  populate `vigil_metrics`. This gives a robust 30-day baseline from day one
  with 60 days of historical trend data.
- **Incremental**: Each enrichment run also extracts Vigil metrics from the
  downloaded FIT before uploading to intervals.icu.
- **Cache**: Computed metrics are stored in `vigil_metrics`; raw FIT files
  are not cached (re-downloadable from Stryd if needed for recomputation).

### 1.3 New files

```
src/engine/vigil/
  types.ts          — Vigil-specific types
  fit-parser.ts     — FIT file → VigilMetrics extraction
  metrics.ts        — Per-activity metric computation from parsed records
  baseline.ts       — Rolling baseline computation and storage
  scorer.ts         — Deviation scoring and alert generation
  index.ts          — Pipeline orchestrator
src/db.ts           — New tables: vigil_metrics, vigil_baselines
```

### 1.4 Storage

**SQLite** (existing `exercitator-data` volume):

```sql
-- Per-activity metric summaries, computed from FIT developer fields
CREATE TABLE vigil_metrics (
  activity_id    TEXT PRIMARY KEY,       -- Stryd activity ID
  icu_activity_id TEXT,                  -- intervals.icu activity ID (for cross-ref)
  computed_at    TEXT NOT NULL,          -- ISO 8601
  activity_date  TEXT NOT NULL,          -- ISO 8601 date
  sport          TEXT NOT NULL,          -- "Run", "TrailRun", etc.
  surface_type   TEXT,                   -- from Stryd post-run report
  -- Unilateral metrics (single pod)
  avg_gct_ms     REAL,
  avg_lss        REAL,                  -- kN/m (stiffness/kg from Stryd)
  avg_form_power REAL,                  -- watts
  avg_ilr        REAL,                  -- impact loading rate
  avg_vo_cm      REAL,                  -- vertical oscillation
  avg_cadence    REAL,                  -- spm
  form_power_ratio REAL,               -- form_power / total_power
  gct_drift_pct  REAL,                  -- % change first→last quartile
  power_hr_drift REAL,                  -- % drift in power:HR ratio
  -- Stryd post-run subjective data
  stryd_rpe      INTEGER,               -- 1-10 from post-run report
  stryd_feel     TEXT,                   -- Terrible/Poor/Normal/Good/Great
  -- Bilateral metrics (Duo — nullable until Duo active)
  l_avg_gct_ms   REAL,
  r_avg_gct_ms   REAL,
  l_avg_lss      REAL,
  r_avg_lss      REAL,
  l_avg_vo_cm    REAL,
  r_avg_vo_cm    REAL,
  l_avg_ilr      REAL,
  r_avg_ilr      REAL,
  gct_asymmetry_pct  REAL,             -- |L-R| / ((L+R)/2) × 100
  lss_asymmetry_pct  REAL,
  vo_asymmetry_pct   REAL,
  ilr_asymmetry_pct  REAL
);

-- Rolling baseline (recomputed daily)
CREATE TABLE vigil_baselines (
  sport          TEXT NOT NULL,
  metric         TEXT NOT NULL,          -- e.g. "avg_gct_ms", "gct_asymmetry_pct"
  computed_at    TEXT NOT NULL,          -- ISO 8601
  mean_30d       REAL NOT NULL,
  stddev_30d     REAL NOT NULL,
  mean_7d        REAL,                  -- acute window
  sample_count_30d INTEGER NOT NULL,
  sample_count_7d  INTEGER,
  PRIMARY KEY (sport, metric)
);
```

**No stream cache table needed** — metrics are computed directly from Stryd
FIT files and stored as summaries. Raw streams are not retained.

---

## 2. Stryd client extensions

### 2.1 Extended activity interface

The Stryd calendar endpoint already returns `rpe`, `feel`, and `surface_type`
fields. Extend `StrydActivity` to capture them:

```typescript
export interface StrydActivity {
  id: number;
  timestamp: number;
  distance: number;
  elapsed_time: number;
  average_power: number;
  // Post-run report fields (already returned by API, not yet captured)
  rpe?: number;              // 1-10, from post-run report
  feel?: string;             // "Terrible" | "Poor" | "Normal" | "Good" | "Great"
  surface_type?: string;     // "Road" | "Trail" | "Track" | "Grass" | "Sand" | "Snow" | "Treadmill"
}
```

### 2.2 Stryd RPE cross-validation

When `stryd_rpe` is available, it can cross-validate the hard session detection
in `workout-selector.ts`. A Stryd RPE ≥ 7 is another signal for `isHardSession()`,
supplementing the existing `perceived_exertion` from intervals.icu.

### 2.3 Future: injury/pain tags

Stryd's post-run report (since April 2025) includes body-part-specific pain
tracking (Achilles, ankle, calf, foot, hamstring, hip, knee, plantar,
quadriceps, shins — bilateral). This data is **not currently accessible via
the known API surface**. The endpoint needs to be reverse-engineered via
mitmproxy on the Stryd iOS app. Tracked as a future investigation item, not
in scope for initial Vigil implementation.

---

## 3. Metrics

### 3.1 Metric extraction from FIT files

Stryd FIT files contain per-second records with developer fields. The following
fields are extracted:

| FIT field                | Metric derived              |
|--------------------------|-----------------------------|
| `Leg Spring Stiffness`   | LSS (kN/m)                  |
| `Form Power`             | Form Power (watts)          |
| `Impact Loading Rate`    | ILR                         |
| `Power` (total)          | Running power (for ratios)  |
| `Ground Time`            | GCT (ms)                    |
| `Cadence`                | Steps per minute            |
| `heart_rate` (standard)  | HR (for drift calculation)  |
| `Vertical Oscillation`   | VO (cm)                     |

For Stryd Duo, additional bilateral fields will be available. The exact field
names are TBD pending Duo integration; the schema accommodates `l_` and `r_`
prefixed columns.

### 3.2 Per-activity summary computation

For each run activity with Stryd FIT data:

```typescript
interface VigilMetrics {
  // Averages (whole activity)
  avgGctMs: number | null;
  avgLss: number | null;
  avgFormPower: number | null;
  avgIlr: number | null;
  avgVoCm: number | null;
  avgCadence: number | null;
  formPowerRatio: number | null;       // avgFormPower / avgPower

  // Within-run drift (first quartile vs last quartile)
  gctDriftPct: number | null;          // positive = GCT increasing (fatigue)
  powerHrDrift: number | null;         // positive = HR rising relative to power

  // Stryd post-run subjective data
  strydRpe: number | null;             // 1-10 from post-run report
  strydFeel: string | null;            // Terrible/Poor/Normal/Good/Great
  surfaceType: string | null;          // Road/Trail/Track/etc.

  // Bilateral (Duo only — null for single pod)
  lAvgGctMs: number | null;
  rAvgGctMs: number | null;
  lAvgLss: number | null;
  rAvgLss: number | null;
  lAvgVoCm: number | null;
  rAvgVoCm: number | null;
  lAvgIlr: number | null;
  rAvgIlr: number | null;
  gctAsymmetryPct: number | null;
  lssAsymmetryPct: number | null;
  voAsymmetryPct: number | null;
  ilrAsymmetryPct: number | null;
}
```

**Drift calculation**:
- Split stream into 4 quartiles by time
- `gctDriftPct = (mean(Q4) - mean(Q1)) / mean(Q1) × 100`
- `powerHrDrift`: compute `HR / Power` ratio in 5-minute windows, then
  `(last_window - first_window) / first_window × 100`

**Asymmetry calculation** (Duo):
- `asymmetry = |L - R| / ((L + R) / 2) × 100`

### 3.3 Metrics excluded from alerting

**Cadence**: Too variable with terrain and pace to produce reliable deviation
signals. Tracked for analysis but not included in composite alert scoring.

**Vertical oscillation (absolute)**: Varies significantly with pace and
gradient. The *ratio* (VO / stride length) is more stable but requires
stride length derivation. Deferred to v2.

---

## 4. Baseline model

### 4.1 Dual-window design

Two windows, recomputed on each pipeline run:

- **30-day rolling baseline**: Exponential moving average of per-activity
  summaries over the last 30 days. Provides the "what is normal for this
  athlete" reference. Requires minimum 5 activities to be considered valid.
  Seeded from the 90-day Stryd backfill on first run.

- **7-day acute window**: Simple mean of the last 7 days of activities.
  Compared against the 30-day baseline to detect sudden shifts.

### 4.2 Metric weights

Not all metrics are equally reliable from a shoe-mounted IMU. Weights reflect
measurement validity and within-subject reliability:

| Metric | Weight | ICC | Rationale |
|--------|--------|-----|-----------|
| GCT | **1.0** | ~0.93 | Best-validated from foot, highest reliability |
| LSS | **1.0** | ~0.90 | Well-validated derived metric (GCT + flight time + mass) |
| Form Power Ratio | **0.8** | ~0.88 | Good reliability, less independent evidence base |
| ILR | **0.5** | ~0.75 | Noisier from foot mount, terrain-sensitive (see §4.3) |
| GCT drift | **1.0** | n/a | Well-established fatigue marker (Nummela et al. 2008) |
| Power:HR drift | **0.8** | n/a | Good signal but requires clean HR data |
| Asymmetry: GCT/LSS/VO (Duo) | **1.0** | n/a | Change detection is the primary value |
| Asymmetry: ILR (Duo) | **0.5** | n/a | Same noise rationale as unilateral ILR |

**ILR at 0.5**: Foot-mounted accelerometers show weaker correlation with
force-platform vertical loading rate (r=0.30–0.55) compared to shank-mounted
(r=0.60–0.85). Within-subject reliability is adequate but clearly inferior to
GCT/LSS. The z-score approach mitigates systematic bias (comparing to self),
but higher noise means more spurious threshold crossings. A weight of 0.5
ensures ILR contributes to the composite only when other metrics are also
deviating — exactly the pattern suggesting real biomechanical change rather
than sensor noise. (Garcia-Pinillos et al. 2020; PMC9105988 systematic review.)

### 4.3 Terrain-matched baselines (future enhancement)

Stryd's `surface_type` from post-run reports and the existing terrain selector
data could enable terrain-stratified baselines (road-to-road, trail-to-trail).
This would reduce ILR noise from surface changes and justify increasing ILR
weight to 0.6–0.7. Not in scope for initial implementation — requires
sufficient tagged activities per terrain type to build meaningful baselines.

### 4.4 Deviation scoring

For each metric `m` with weight `w(m)`:

```
z_score(m) = (mean_7d(m) - mean_30d(m)) / stddev_30d(m)
weighted_z(m) = z_score(m) × w(m)
```

Direction matters:
- GCT: positive z = worse (longer ground contact)
- LSS: negative z = worse (reduced stiffness)
- Form Power Ratio: positive z = worse (more wasted energy)
- ILR: positive z = worse (higher impact)
- GCT drift: positive z = worse (more within-run fatigue)
- Power:HR drift: positive z = worse (more cardiac drift)
- Asymmetry metrics: positive z = worse (increasing imbalance)

All z-scores are mapped to a directional "concern score" where positive =
worse, regardless of the raw metric direction:

```typescript
function concernScore(metric: string, zScore: number, weight: number): number {
  const worseWhenHigher = [
    "avg_gct_ms", "avg_form_power", "form_power_ratio",
    "avg_ilr", "gct_drift_pct", "power_hr_drift",
    "gct_asymmetry_pct", "lss_asymmetry_pct",
    "vo_asymmetry_pct", "ilr_asymmetry_pct",
  ];
  const worseWhenLower = ["avg_lss"];

  let directional: number;
  if (worseWhenHigher.includes(metric)) directional = zScore;
  else if (worseWhenLower.includes(metric)) directional = -zScore;
  else directional = Math.abs(zScore);

  return directional * weight;
}
```

### 4.5 Composite alert

Single-metric deviations are noisy. The composite alert requires multiple
metrics to deviate simultaneously:

```typescript
interface VigilAlert {
  severity: 0 | 1 | 2 | 3;
  flags: VigilFlag[];
  summary: string;            // Human-readable description
  recommendation: string;     // What the engine will do about it
}

interface VigilFlag {
  metric: string;
  zScore: number;
  weightedZ: number;
  concernScore: number;
  weight: number;
  direction: "worsening" | "improving";
  value7d: number;
  value30d: number;
}
```

**Severity thresholds** (using weighted concern scores):

| Severity | Condition | Label | Engine action |
|----------|-----------|-------|---------------|
| 0 | < 2 metrics with weighted concern > 1.5σ | None | Normal prescription |
| 1 | 2+ metrics with weighted concern > 1.5σ | Watch | Normal prescription, advisory note |
| 2 | 2+ metrics with weighted concern > 2.0σ | Caution | Protective downshift (one category) |
| 3 | 3+ metrics with weighted concern > 2.0σ, OR any metric with weighted concern > 3.0σ | Alert | Protective downshift to base, advisory to consider rest |

**Bilateral boost**: If asymmetry metrics are among the flagged metrics, the
severity is boosted by 1 (capped at 3). Rationale: while population-level
asymmetry doesn't predict injury, a *sudden change* in an individual's
asymmetry is more concerning than a change in a symmetric metric, as it
suggests unilateral compensation.

### 4.6 Insufficient data handling

- < 5 activities in 30-day window: baseline is invalid, no alerts generated,
  Praescriptor shows "Vigil: insufficient data (N/5 activities)"
- < 2 activities in 7-day window: acute window is invalid, no alerts generated
- Missing Stryd FIT data for an activity: that activity excluded from baseline
  computation (no partial entries)

---

## 5. Engine integration

### 5.1 Protective downshift

In `src/engine/workout-selector.ts`, after the existing category selection:

```typescript
// Existing: readiness → category selection → hard session guard
// New: Vigil alert guard
if (vigilAlert.severity >= 2) {
  const downshiftMap: Record<string, string> = {
    intervals: "tempo",
    tempo: "base",
    base: "base",    // can't go lower
    recovery: "recovery",
  };
  category = downshiftMap[category] ?? "base";

  if (vigilAlert.severity === 3) {
    category = "base";  // force base regardless
  }
}
```

A `vigilDownshift` flag (similar to `hardSessionGuard`) prevents downstream
rebalancing from overriding the protective downshift.

### 5.2 Stryd RPE as hard session signal

When `stryd_rpe` is available from the previous day's activity, feed it into
`isHardSession()` as an additional signal alongside the existing
`perceived_exertion` from intervals.icu. Stryd RPE ≥ 7 counts as a hard
session indicator.

### 5.3 Prescription annotation

When a Vigil alert is active (severity ≥ 1), the prescription output includes:

```typescript
interface WorkoutPrescription {
  // ... existing fields ...
  vigil?: {
    severity: 0 | 1 | 2 | 3;
    flags: VigilFlag[];
    summary: string;
    recommendation: string;
    baselineWindow: string;    // "30d (N activities)"
    acuteWindow: string;       // "7d (N activities)"
  };
}
```

### 5.4 intervals.icu wellness update

When `severity >= 2`, write to the wellness `injury` field. The field uses a
1–4 scale:

| Value | intervals.icu label | Meaning |
|-------|---------------------|---------|
| 1 | Healthy | No concern |
| 2 | Niggle | Goes away when warmed up |
| 3 | Poor | Tightness/tenderness that persists |
| 4 | Injured | Gait changed or condition worsened |

**Vigil never writes 4 (Injured) automatically.** Automated systems should not
diagnose injury — only flag concern.

| Vigil severity | `injury` value | Label |
|---|---|---|
| 0–1 | No write | — |
| 2 (Caution) | 2 | Niggle |
| 3 (Alert) | 3 | Poor |

```typescript
if (vigilAlert.severity >= 2) {
  await intervalsClient.put(
    `/athlete/${athleteId}/wellness/${todayISO}`,
    { injury: vigilAlert.severity }  // severity 2→2 (Niggle), severity 3→3 (Poor)
  );
}
```

**No double penalty**: The intervals.icu `injury` field is purely informational
— it is not used in CTL/ATL/TSB or any fitness calculations on their side. On
the Exercitator side, `readiness.ts` does not reference `injury`. Writing to
this field provides visibility in the intervals.icu wellness page without
affecting any load or readiness calculations in either system.

---

## 6. Surface layer

### 6.1 Praescriptor UI

Add a "Vigil" section to each run prescription card:

**Severity 0**: No display (clean card).

**Severity 1 (Watch)**:
```
──── Vigil ────
⚠ Watch: GCT trending +8% above baseline, Form Power Ratio elevated
  Prescription unchanged — monitor next 2–3 sessions
```

**Severity 2 (Caution)**:
```
──── Vigil ────
⚠⚠ Caution: GCT +2.3σ, LSS −2.1σ, ILR +0.9σ* above baseline (7d vs 30d)
  * ILR weighted 0.5 — raw z = 1.8σ
  Prescription downshifted: tempo → base
  Wellness updated: injury = Niggle
```

**Severity 3 (Alert)**:
```
──── Vigil ────
⚠⚠⚠ Alert: 4 metrics outside 2σ — possible compensatory pattern
  GCT +2.8σ, LSS −2.4σ, ILR +1.6σ*, GCT asymmetry +2.2σ
  Prescription forced to base — consider rest day
  Wellness updated: injury = Poor
```

Colour: use the existing amber/warning palette from the prescription aesthetic.
Severity 3 uses a red-shifted variant.

### 6.2 MCP tool response (suggest_workout)

The `suggest_workout` response already returns a JSON structure. Add a `vigil`
field:

```json
{
  "sport": "Run",
  "category": "base",
  "vigil": {
    "severity": 2,
    "summary": "Caution: GCT +2.3σ, LSS −2.1σ above 30-day baseline",
    "recommendation": "Intensity downshifted. Monitor form — if discomfort persists, consider professional assessment.",
    "flags": [
      { "metric": "avg_gct_ms", "zScore": 2.3, "weight": 1.0, "weightedZ": 2.3, "value7d": 242, "value30d": 228 },
      { "metric": "avg_lss", "zScore": -2.1, "weight": 1.0, "weightedZ": -2.1, "value7d": 9.2, "value30d": 10.8 },
      { "metric": "avg_ilr", "zScore": 1.8, "weight": 0.5, "weightedZ": 0.9, "value7d": 14.2, "value30d": 12.8 }
    ]
  }
}
```

### 6.3 Praescriptor data source bar

Add Vigil status to the existing data source bar:

```
🏃 12 activities · ⌚ Garmin FR970 · 🔋 Stryd CP 292W · ⚡ Vigil: 2 flags (sev 1)
```

Or when building baseline:
```
⚡ Vigil: baseline building (3/5 activities)
```

Or when no Stryd data:
```
⚡ Vigil: no Stryd data
```

---

## 7. Stryd Duo preparation

### 7.1 Stream detection

When processing FIT developer fields, check for bilateral Stryd fields:

```typescript
const BILATERAL_FIELD_PATTERNS = [
  // Known Duo CIQ field names (to be confirmed with actual Duo data)
  /^Left/, /^Right/,
  /Left.*LSS/, /Right.*LSS/,
  /Left.*GCT/, /Right.*GCT/,
  /Left.*ILR/, /Right.*ILR/,
];

function hasBilateralFields(fieldNames: string[]): boolean {
  return fieldNames.some(fn =>
    BILATERAL_FIELD_PATTERNS.some(pattern => pattern.test(fn))
  );
}
```

### 7.2 Graceful bilateral fallback

If an athlete has some activities with Duo and some without:
- Bilateral baselines are computed only from Duo activities
- Unilateral baselines are computed from all activities
- Alert scoring uses whichever baseline set has sufficient data
- If both are available, bilateral flags get the asymmetry severity boost

### 7.3 First Duo run detection

When the first activity with bilateral fields is detected, log an event and
reset the bilateral baseline counters. The 30-day baseline for bilateral
metrics starts from this point (unilateral baseline is unaffected).

---

## 8. Testing

### 8.1 Unit tests

```
tests/engine/vigil/
  fit-parser.test.ts  — FIT file → metric extraction
  metrics.test.ts     — Per-activity summary computation
  baseline.test.ts    — Rolling baseline computation, edge cases
  scorer.test.ts      — Deviation scoring, composite alert thresholds, weights
  index.test.ts       — Full pipeline with fixture data
```

### 8.2 Fixture data

Create fixtures representing:
- Normal run (all metrics within baseline)
- Fatigued run (elevated GCT drift, power:HR drift)
- Compensatory pattern (GCT + LSS + ILR all deviating)
- Duo run with asymmetry developing
- Insufficient data (< 5 activities in 30 days)
- Mixed pod runs (some Duo, some single)
- ILR-only deviation (should not trigger alert alone due to 0.5 weight)

### 8.3 Integration tests

- Verify protective downshift fires at severity 2
- Verify wellness write occurs at severity 2 but not severity 1
- Verify wellness write uses correct injury values (2=Niggle, 3=Poor, never 4)
- Verify `hardSessionGuard` and `vigilDownshift` don't conflict
- Verify Stryd RPE feeds into `isHardSession()`
- Verify Vigil pipeline gracefully degrades when FIT files are unavailable
- Verify ILR weight dampens false positives (ILR-only deviation stays sev 0)

---

## 9. Implementation phases

### Phase 1: Stryd client extensions + FIT parsing
- Extend `StrydActivity` to capture `rpe`, `feel`, `surface_type`
- Add `fit-file-parser` dependency
- Create `src/engine/vigil/fit-parser.ts` — FIT → per-second records
- Create `src/engine/vigil/types.ts` — all Vigil interfaces
- SQLite schema (tables + migrations)
- 90-day backfill: fetch FIT files from Stryd, parse, populate `vigil_metrics`
- Unit tests for FIT parsing and metric extraction

### Phase 2: Metric computation + baseline model
- Create `src/engine/vigil/metrics.ts` — per-activity summary from parsed FIT
  - Average GCT, LSS, Form Power, ILR, VO, cadence
  - Form Power Ratio (form power / total power)
  - GCT drift (Q1 vs Q4 quartile comparison)
  - Power:HR drift (5-minute windowed ratio)
- Create `src/engine/vigil/baseline.ts`:
  - 30-day rolling mean + stddev per metric per sport
  - 7-day acute window mean
  - Minimum 5 activities for valid 30-day baseline
  - Minimum 2 activities for valid 7-day window
- Unit tests for metric computation and baseline

### Phase 3: Deviation scoring + engine integration
- Create `src/engine/vigil/scorer.ts`:
  - Z-score computation with metric weights
  - Directional concern mapping (GCT↑ = worse, LSS↓ = worse, etc.)
  - Composite alert: severity 0–3
  - Bilateral severity boost
- Create `src/engine/vigil/index.ts` — pipeline orchestrator
- Modify `src/engine/workout-selector.ts`:
  - Protective downshift at severity ≥ 2
  - `vigilDownshift` guard flag
  - Stryd RPE as `isHardSession()` signal
- intervals.icu wellness `injury` field write (2=Niggle, 3=Poor)
- Integration tests

### Phase 4: Surface layer
- Praescriptor UI (Vigil section on prescription cards)
- Data source bar update
- MCP tool response field
- End-to-end testing

### Phase 5: Duo preparation
- Bilateral field detection in FIT files
- Asymmetry metric extraction
- Bilateral baseline computation
- Asymmetry severity boost
- Fixture data for Duo scenarios

### Future: terrain-matched baselines
- Stratify baselines by `surface_type` (road/trail/track)
- Requires sufficient tagged activities per terrain type
- Would justify increasing ILR weight from 0.5 to 0.6–0.7

### Future: Stryd injury/pain tags
- Reverse-engineer Stryd iOS app's post-run pain report endpoint (mitmproxy)
- Body-part-specific pain data: Achilles, ankle, calf, foot, hamstring, hip,
  knee, plantar, quadriceps, shins (bilateral)
- Could provide ground-truth labels for validating Vigil's alert accuracy

---

## 10. Research basis and limitations

### Evidence supporting this approach

- **Intra-individual deviation** is the strongest signal available from
  wearable sensors. Population thresholds do not predict individual injury
  (Malisoux et al. 2024, Wayner et al. 2023).
- **Multi-metric composite scoring** reduces false positives. Any single
  metric can shift for benign reasons (terrain, shoes, fatigue); simultaneous
  multi-metric deviation is more concerning.
- **GCT drift within a run** correlates with fatigue-driven form degradation
  (Nummela et al. 2008).
- **Power:HR decoupling** indicates cardiovascular overreaching (Lamberts
  et al. 2011).
- **Stryd's own framing** for injury detection centres on tracking changes
  from personal baselines, not absolute values.
- **ILR weighting at 0.5** reflects the systematic review (PMC9105988) finding
  that foot-mounted sensors overestimate loading rate variability vs shank-
  mounted, with correlation to force platforms at r=0.30–0.55 (vs r=0.60–0.85
  for shank). Within-subject ICC of ~0.75 is adequate for trend detection but
  inferior to GCT (~0.93) and LSS (~0.90).

### Limitations to communicate to the user

- **This is not injury diagnosis.** It detects biomechanical deviation that
  *may* indicate developing issues. False positives will occur (new shoes,
  different terrain, intentional form changes).
- **Asymmetry is not inherently bad.** The Malisoux 2024 study found some
  asymmetry was *protective*. Vigil only flags *changes* in asymmetry, not
  asymmetry itself.
- **Stryd IMU limitations.** The foot pod estimates metrics from
  accelerometer/gyroscope data, not force plates. GCT and LSS have been
  validated against reference systems (Garcia-Pinillos et al. 2020) but
  absolute values carry measurement uncertainty.
- **Shoe-mounted sensors** measure higher peak accelerations than
  shank-mounted devices and are less correlated with true vertical loading
  rates (systematic review, PMC9105988). ILR from Stryd is treated as a
  relative trend indicator weighted at 0.5 in the composite score, not as
  an absolute biomechanical measurement.
- **Automated wellness writes are conservative.** Vigil never writes
  `injury = 4` (Injured). Maximum automated value is 3 (Poor), and only
  when multiple metrics deviate simultaneously at > 2σ.

### Key references

- Malisoux et al. (2024). BMJ Open Sport Exerc Med. DOI: 10.1136/bmjsem-2023-001787
- Davis & Gruber (2021). Orthop J Sports Med. DOI: 10.1177/23259671211011213
- Nummela et al. (2008). Fatigue biomechanics in distance running.
- Lamberts et al. (2011). Cardiac drift methodology.
- Plews et al. (2013). HRV as fatigue indicator.
- Garcia-Pinillos et al. (2020). Stryd validation study. PMC7404478.
- Sheerin et al. (2022). Wearable tibial loading measurement. PMC9105988.
