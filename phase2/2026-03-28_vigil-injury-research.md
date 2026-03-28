# Stryd Metrics for Injury Detection — Research Summary

**Filed**: 2026-03-28
**Project**: Exercitator / Praescriptor
**Feature**: Vigil (injury warning system)

---

## Core finding

Population-level biomechanical asymmetry and absolute stiffness values do NOT
predict running injury risk. The largest prospective study (Malisoux et al.
2024, n=836, 6-month follow-up) found no association between gait asymmetry
and injury. Some asymmetry was *protective* (flight time asymmetry HR 0.80).
Davis & Gruber (2021, n=49, 12-month follow-up) found leg and joint stiffness
unrelated to injury incidence. A 2025 military cadet study (n=674) found
wearable sensor biomechanical variables non-predictive; only sex and prior
injury history were significant.

**Actionable approach**: intra-individual deviation from personal baseline,
using multi-metric composite scoring. When several metrics shift simultaneously
relative to the athlete's own 30-day rolling average, the system flags it.

---

## Available Stryd metrics via intervals.icu streams

| Stream | Metric | Injury relevance |
|--------|--------|-----------------|
| `StrydLSS` | Leg Spring Stiffness | Trend decrease = reduced elastic energy return |
| `StrydFormPower` | Form Power | Trend increase = rising metabolic cost |
| `StrydILR` | Impact Loading Rate | Trend increase = higher impact per step |
| GCT (derived) | Ground Contact Time | Trend increase = fatigue/compensation |
| Power + HR | Power:HR ratio drift | Trend increase = cardiovascular overreaching |
| Duo (future) | L/R splits of above | Change in asymmetry = unilateral compensation |

**Not useful for alerting**: Cadence (too pace-dependent), absolute vertical
oscillation (too terrain-dependent), absolute stiffness values (no population
threshold validated).

---

## Design decisions for Vigil

- **30-day + 7-day dual window**: 30d provides stable baseline, 7d detects
  acute shifts. Z-score deviation model.
- **Composite-only alerting**: ≥2 metrics must deviate >1.5σ for severity 1
  (watch), ≥2 at >2.0σ for severity 2 (caution + downshift), ≥3 at >2.0σ or
  any >3.0σ for severity 3 (alert + force base).
- **Bilateral boost**: If Duo asymmetry metrics are among flagged metrics,
  severity boosted by 1.
- **Protective downshift**: Severity ≥2 auto-reduces prescription intensity
  by one category. Severity 3 forces base.
- **Wellness write**: Severity ≥2 writes to intervals.icu `injury` field
  (proportional: sev 2→1, sev 3→2).
- **Storage**: SQLite for baselines + filesystem cache for stream data.
- **Schema**: Pre-designed for Duo bilateral columns (nullable until Duo
  active).

---

## Key references

- Malisoux et al. (2024). BMJ Open Sport Exerc Med 10(1):e001787. n=836.
  Asymmetry not predictive; some asymmetry protective.
- Davis & Gruber (2021). Orthop J Sports Med 9(5). Leg/joint stiffness
  unrelated to injury.
- Encarnación-Martínez et al. (2025). Sports Med Open 11(1):107.
  Fatigue-induced kinematic changes cluster by functional group.
- Garcia-Pinillos et al. (2020). PMC7404478. Stryd GCT and LSS validated
  against force platforms.
- Nummela et al. (2008). Fatigue biomechanics — GCT increase as fatigue marker.
- Lamberts et al. (2011). HR:Power drift as overreaching indicator.
- Plews et al. (2013). HRV decline >15% = significant fatigue.
- PMC9105988 systematic review: shoe-mounted sensors overestimate peak
  accelerations vs shank-mounted; ILR from foot pods = relative trend only.

---

## Limitations documented in spec

- Not injury diagnosis — deviation detection only
- False positives expected (new shoes, terrain changes, intentional form work)
- Stryd is IMU-based, not force-plate-based
- Shoe-mounted ILR less reliable than shank-mounted for absolute loading rates
- Asymmetry change flagging, not asymmetry existence
