#!/usr/bin/env python3
"""Analyse research data pulled from Promus + intervals.icu."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROMUS = json.load(open("/tmp/research-promus-sessions.json"))
IV_ACTS = json.load(open("/tmp/research-iv-activities.json"))
IV_WELL = json.load(open("/tmp/research-iv-wellness.json"))


# ---------------------------------------------------------------------------
# 1. Promus summary
# ---------------------------------------------------------------------------
def parse_utc(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def section(title: str) -> None:
    print()
    print("=" * 78)
    print(title)
    print("=" * 78)


section("PROMUS — strength sessions (last 90 days)")
print(f"Total sessions: {len(PROMUS)}")

ex_counter: Counter[str] = Counter()
for sess in PROMUS:
    for st in sess.get("sets", []):
        ex_counter[st["exercise"]] += 1

print("\nDistinct exercises (by set count, all sessions):")
for name, n in ex_counter.most_common():
    print(f"  {n:4d}  {name}")

print("\nPer-session breakdown:")
durations_min: list[float] = []
for s in sorted(PROMUS, key=lambda x: x["started_utc"]):
    start = parse_utc(s["started_utc"])
    end = parse_utc(s["ended_utc"])
    dur_min = (end - start).total_seconds() / 60.0
    durations_min.append(dur_min)
    unique_ex = sorted({st["exercise"] for st in s.get("sets", [])})
    rpe = s.get("rpe")
    print(
        f"  {s['session_id'][:8]}  "
        f"start={start.isoformat()}  "
        f"end={end.isoformat()}  "
        f"dur={dur_min:5.1f}min  "
        f"sets={len(s.get('sets', [])):3d}  "
        f"rpe={rpe!s:>5}  "
        f"ex={unique_ex}"
    )

rpe_set = sum(1 for s in PROMUS if s.get("rpe") is not None)
print(f"\nRPE present: {rpe_set} / {len(PROMUS)} ({rpe_set / max(1, len(PROMUS)):.0%})")

# 5-bin histogram of durations
if durations_min:
    lo, hi = min(durations_min), max(durations_min)
    bins = 5
    width = (hi - lo) / bins if hi > lo else 1.0
    counts = [0] * bins
    for d in durations_min:
        idx = min(bins - 1, int((d - lo) / width)) if width > 0 else 0
        counts[idx] += 1
    print("\nDuration histogram (minutes):")
    for i, c in enumerate(counts):
        edge_lo = lo + i * width
        edge_hi = edge_lo + width
        print(f"  [{edge_lo:5.1f}, {edge_hi:5.1f})  {'#' * c}  ({c})")

# ---------------------------------------------------------------------------
# 2. intervals.icu activities (60 days)
# ---------------------------------------------------------------------------
section("INTERVALS.ICU — activities (last 60 days)")
print(f"Total activities: {len(IV_ACTS)}")

type_counter: Counter[str] = Counter(a.get("type", "?") for a in IV_ACTS)
print("\nCount by type:")
for t, n in type_counter.most_common():
    print(f"  {n:3d}  {t}")

# WeightTraining detail
wt_acts = [a for a in IV_ACTS if a.get("type") == "WeightTraining"]
print(f"\nWeightTraining activities: {len(wt_acts)}")
for a in sorted(wt_acts, key=lambda x: x.get("start_date_local", "")):
    print(
        f"  id={a['id']}  "
        f"start_local={a.get('start_date_local')}  "
        f"moving={a.get('moving_time')}s  "
        f"load={a.get('icu_training_load')}  "
        f"intensity={a.get('icu_intensity')}  "
        f"hr_zones={a.get('icu_hr_zone_times')}  "
        f"rpe={a.get('perceived_exertion')}  "
        f"feel={a.get('feel')}  "
        f"session_rpe={a.get('session_rpe')}  "
        f"device={a.get('device_name')!r}  "
        f"source={a.get('source')!r}  "
        f"external_id={a.get('external_id')!r}"
    )

# Run hard-session classification per the engine heuristic
run_types = {"Run", "TrailRun", "VirtualRun", "Treadmill"}
runs = [a for a in IV_ACTS if a.get("type") in run_types]
print(f"\nRuns: {len(runs)}")


def is_hard(a: dict) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    intensity = a.get("icu_intensity") or 0.0
    if intensity > 85:
        reasons.append(f"intensity={intensity:.1f}>85")
    pe = a.get("perceived_exertion")
    if pe is not None and pe >= 7:
        reasons.append(f"rpe={pe}>=7")
    zones = a.get("icu_hr_zone_times") or []
    moving = a.get("moving_time") or 0
    # icu_hr_zone_times is 7 buckets (Z1..Z7). Z4+ = indices 3..
    z4plus = sum(zones[3:]) if len(zones) >= 4 else 0
    if moving > 0 and z4plus / moving > 0.25:
        reasons.append(f"Z4+ {z4plus / moving:.0%}>25%")
    return (bool(reasons), reasons)


hard_count = 0
for a in runs:
    hard, reasons = is_hard(a)
    if hard:
        hard_count += 1
        print(
            f"  HARD  id={a['id']}  {a.get('start_date_local')}  "
            f"reasons={reasons}"
        )
print(f"\nHard runs (engine heuristic): {hard_count} / {len(runs)}")

# ---------------------------------------------------------------------------
# 3. Wellness timeline (60 days)
# ---------------------------------------------------------------------------
section("INTERVALS.ICU — wellness timeline")
print(f"Wellness records: {len(IV_WELL)}")
if IV_WELL:
    print(
        f"{'date':12} {'ctl':>6} {'atl':>6} {'sleepSc':>7} {'hrv':>6}"
    )
    for w in sorted(IV_WELL, key=lambda x: x.get("id", "")):
        date = w.get("id", "")
        ctl = w.get("ctl")
        atl = w.get("atl")
        sleep = w.get("sleepScore")
        hrv = w.get("hrv")
        print(
            f"{date:12} "
            f"{ctl if ctl is not None else '-':>6} "
            f"{atl if atl is not None else '-':>6} "
            f"{sleep if sleep is not None else '-':>7} "
            f"{hrv if hrv is not None else '-':>6}"
        )

# ---------------------------------------------------------------------------
# 4. Cross-correlation (WeightTraining ↔ Promus)
# ---------------------------------------------------------------------------
section("CROSS-CORRELATION — intervals WeightTraining ↔ Promus")

# intervals.icu start_date_local is local time without TZ; the API also returns
# a separate 'start_date' that is UTC. Use that for matching.
def to_utc(a: dict) -> datetime | None:
    raw = a.get("start_date")
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(raw).astimezone(timezone.utc)
    except ValueError:
        return None


promus_starts = [
    (parse_utc(s["started_utc"]).astimezone(timezone.utc), s) for s in PROMUS
]

matches: list[tuple[dict, dict, float]] = []
matched_promus: set[str] = set()
unmatched_iv: list[dict] = []

for a in wt_acts:
    iv_utc = to_utc(a)
    if not iv_utc:
        unmatched_iv.append(a)
        continue
    best: tuple[dict, float] | None = None
    for p_utc, p in promus_starts:
        delta_min = abs((iv_utc - p_utc).total_seconds()) / 60.0
        if delta_min <= 10 and (best is None or delta_min < best[1]):
            best = (p, delta_min)
    if best:
        matches.append((a, best[0], best[1]))
        matched_promus.add(best[0]["session_id"])
    else:
        unmatched_iv.append(a)

print(f"Matches within 10 min: {len(matches)}")
for iv, p, delta in matches:
    sets = p.get("sets", [])
    ex_in_session: Counter[str] = Counter(st["exercise"] for st in sets)
    top5 = ex_in_session.most_common(5)
    print(
        f"  iv={iv['id']}  promus={p['session_id'][:8]}  "
        f"delta={delta:.1f}min  sets={len(sets)}  "
        f"top5={top5}"
    )

print(f"\nUnmatched intervals.icu WeightTraining ({len(unmatched_iv)}):")
for a in unmatched_iv:
    print(
        f"  iv={a['id']}  {a.get('start_date_local')}  "
        f"source={a.get('source')!r}  external_id={a.get('external_id')!r}"
    )

unmatched_promus = [s for s in PROMUS if s["session_id"] not in matched_promus]
print(f"\nUnmatched Promus sessions ({len(unmatched_promus)}):")
for s in unmatched_promus:
    print(
        f"  promus={s['session_id'][:8]}  start_utc={s['started_utc']}  "
        f"sets={len(s.get('sets', []))}"
    )

# ---------------------------------------------------------------------------
# 5. Cadence + engine-fire stats (for the summary doc)
# ---------------------------------------------------------------------------
section("CROSS-TRAINING CADENCE + ENGINE-FIRE FREQUENCY")
# Use Promus sessions as the ground truth for cross-training cadence over 90d.
window_start = datetime(2026, 2, 12, tzinfo=timezone.utc)
window_end = datetime(2026, 5, 13, tzinfo=timezone.utc)
weeks = (window_end - window_start).days / 7.0
print(
    f"90-day window: {window_start.date()} → {window_end.date()} "
    f"({weeks:.1f} weeks)"
)
print(f"Promus sessions: {len(PROMUS)} → {len(PROMUS) / weeks:.2f} / week")

starts_sorted = sorted(
    [parse_utc(s["started_utc"]).astimezone(timezone.utc) for s in PROMUS]
)
gaps_days = [
    (starts_sorted[i] - starts_sorted[i - 1]).total_seconds() / 86400.0
    for i in range(1, len(starts_sorted))
]
if gaps_days:
    print(
        f"Gap (days) between sessions: "
        f"min={min(gaps_days):.1f} max={max(gaps_days):.1f} "
        f"mean={sum(gaps_days) / len(gaps_days):.1f}"
    )
    print(f"All gaps: {[round(g, 1) for g in gaps_days]}")

# Engine fire frequency over 60-day Run prescription window if RPE were
# available. Engine rule: cross-training hard-session guard fires if a
# moderate-or-hard weight session occurred in last 2 days. Same-day cap also
# fires for same-day sessions. We assume all observed Promus sessions would
# classify as "moderate" or above (set count > 5 and duration > 15 min => not
# trivial) for this counterfactual.

prescription_days: list[datetime] = []
d = datetime(2026, 3, 13, tzinfo=timezone.utc)
end = datetime(2026, 5, 13, tzinfo=timezone.utc)
while d <= end:
    prescription_days.append(d)
    d += timedelta(days=1)

promus_dates = {
    parse_utc(s["started_utc"]).astimezone(timezone.utc).date()
    for s in PROMUS
}
fires_2day = 0
for day in prescription_days:
    for back in range(0, 3):  # today, -1d, -2d
        if (day.date() - timedelta(days=back)) in promus_dates:
            fires_2day += 1
            break
print(
    f"\nPrescription days: {len(prescription_days)}; "
    f"days where engine 2-day rule WOULD fire if RPE present: "
    f"{fires_2day} ({fires_2day / len(prescription_days):.0%})"
)
