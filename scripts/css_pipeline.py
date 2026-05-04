"""Reproduce Suunto poolSwimThreshold from intervals.icu activity list.

Reads the JSON dump produced by the Exercitator list_activities tool, applies
the protocol from
/Users/ze/Documents/claude/suunto/vertical2/analysis-morning/protocol_pool_swim_threshold.md,
and writes pool_swim_threshold.json matching protocol section 7.
"""
import json
import struct
import sys
import datetime as dt
import pathlib

INPUT_PATH = sys.argv[1] if len(sys.argv) > 1 else "activities.json"
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "pool_swim_threshold.json"
REF = (
    dt.datetime.fromisoformat(sys.argv[3].replace("Z", "+00:00"))
    if len(sys.argv) > 3
    else dt.datetime.now(dt.timezone.utc)
)
OLDEST_FLOOR = (
    dt.datetime.fromisoformat(sys.argv[4]).replace(tzinfo=dt.timezone.utc)
    if len(sys.argv) > 4
    else None
)

ACTIVITY_ID = 21
WINDOW_DAYS = 365
MIN_DURATION_S = 600
LIMIT = 30
TAKE = 20
TRIM = 10

window_start = REF - dt.timedelta(days=WINDOW_DAYS)

raw = json.loads(pathlib.Path(INPUT_PATH).read_text())
print(f"Loaded {len(raw)} swim rows", file=sys.stderr)

candidates = []
skipped = []

for a in raw:
    aid = a.get("id")
    name = a.get("name") or ""
    start_iso = a.get("start_date")
    if not start_iso:
        skipped.append({"file": aid, "reason": "missing_start_date"})
        continue
    start = dt.datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
    if start < window_start:
        skipped.append({"file": aid, "reason": "outside_window"})
        continue
    if OLDEST_FLOOR and start < OLDEST_FLOOR:
        skipped.append({"file": aid, "reason": "before_oldest_floor"})
        continue
    sport_type = a.get("type")
    if sport_type != "Swim":
        skipped.append({"file": aid, "reason": f"type_{sport_type}"})
        continue
    pool_length = a.get("pool_length")
    if not pool_length or pool_length <= 0:
        skipped.append({"file": aid, "reason": "no_pool_length_ambiguous"})
        continue
    moving = a.get("moving_time") or 0
    if moving < MIN_DURATION_S:
        skipped.append({"file": aid, "reason": "duration_below_600s"})
        continue
    avg = a.get("average_speed")
    if not avg or avg <= 0:
        dist = a.get("distance") or 0
        if dist <= 0 or moving <= 0:
            skipped.append({"file": aid, "reason": "no_avg_speed"})
            continue
        avg = dist / moving
    candidates.append({
        "id": aid,
        "name": name,
        "start_date": start,
        "moving_time": moving,
        "distance": a.get("distance"),
        "avg_speed": float(avg),
        "pool_length": pool_length,
    })

print(f"Qualified: {len(candidates)}", file=sys.stderr)

# Dedup by (start_date, moving_time, distance) per protocol section 9.
seen = set()
deduped = []
for c in candidates:
    key = (c["start_date"].isoformat(timespec="seconds"), c["moving_time"], c["distance"])
    if key in seen:
        skipped.append({"file": c["id"], "reason": "duplicate"})
        continue
    seen.add(key)
    deduped.append(c)

# Sort by start_date DESC, take first 30, take first 20 (chronological).
deduped.sort(key=lambda c: c["start_date"], reverse=True)
after_limit = deduped[:LIMIT]
after_take = after_limit[:TAKE]

speeds = [c["avg_speed"] for c in after_take]

# Trim min/max only if strictly greater than 10 elements.
if len(speeds) > TRIM:
    sorted_speeds = sorted(speeds)
    after_trim = sorted_speeds[1:-1]
else:
    after_trim = list(speeds)

if after_trim:
    threshold = sum(after_trim) / len(after_trim)
else:
    threshold = None

# Float32 little-endian hex.
hex_le = struct.pack("<f", threshold).hex() if threshold is not None else None

# Pace per 100 m, formatted HH:MM:SS.cc.
def fmt_pace(speed_ms):
    if not speed_ms or speed_ms <= 0:
        return None
    secs = 100 / speed_ms
    h = int(secs // 3600)
    m = int((secs % 3600) // 60)
    s_full = secs - 3600 * h - 60 * m
    return f"{h:02d}:{m:02d}:{s_full:05.2f}"

pace_per_100m = fmt_pace(threshold)

# Validation per section 8.
warnings = []
if threshold is not None and not (0.20 < threshold < 2.50):
    warnings.append(f"threshold_{threshold}_outside_plausible_range")

# Cross-check avg_speed against distance/moving_time on every candidate.
for c in candidates:
    if c["distance"] and c["moving_time"]:
        derived = c["distance"] / c["moving_time"]
        if c["avg_speed"] > 0:
            div = abs(derived - c["avg_speed"]) / c["avg_speed"]
            if div > 0.05:
                warnings.append(
                    f"divergence_{c['id']}_{div:.3f}"
                )

# Confidence note.
n = len(candidates)
if n >= 15:
    confidence = "high"
elif n >= 5:
    confidence = "medium"
elif n >= 1:
    confidence = "low"
else:
    confidence = "none"

# Always emit the unsynced-filter warning per section 9.
skipped.append({"file": "_meta_", "reason": "warning_no_unsynced_filter"})

result = {
    "sport": "pool_swim",
    "activity_id": ACTIVITY_ID,
    "reference_instant_iso": REF.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    "window_start_iso": window_start.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    "fit_files_scanned": len(raw),
    "candidates_qualified": len(candidates),
    "after_limit_30": len(after_limit),
    "after_take_20": len(after_take),
    "after_trim": len(after_trim),
    "threshold_ms_double": threshold,
    "threshold_ms_float32_hex": hex_le,
    "threshold_pace_per_100m": pace_per_100m,
    "confidence": confidence,
    "warnings": warnings,
    "selected_sessions": [
        {
            "id": c["id"],
            "start_date": c["start_date"].isoformat().replace("+00:00", "Z"),
            "name": c["name"],
            "moving_time": c["moving_time"],
            "distance": c["distance"],
            "avg_speed": c["avg_speed"],
        }
        for c in after_take
    ],
    "skipped": skipped,
}

pathlib.Path(OUTPUT_PATH).write_text(json.dumps(result, indent=2))
print(json.dumps(
    {k: v for k, v in result.items() if k not in ("selected_sessions", "skipped")},
    indent=2,
))
