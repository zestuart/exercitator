"""Length-by-length CSS extraction with stroke-aware drill detection.

Pipeline per activity:
  1. Read streams (time, distance, velocity_smooth, cadence, heartrate).
  2. Walk the distance stream and emit a length whenever cumulative distance
     crosses a multiple of pool_length. For each length collect:
       - duration (s)
       - pace per 100m (s)
       - avg cadence (spm) over the length
       - avg HR (bpm)
  3. Classify each length:
       - REST  : pace > 200s/100m  (stationary at wall, just safety net)
       - DRILL : cadence < 30 spm OR pace > 145 s/100m with cadence < 38 spm
       - FREE  : everything else
  4. Cluster contiguous FREE lengths into sets (gap = REST or DRILL or
     time-gap > 30 s).
  5. Main set = the longest FREE cluster by length count.
  6. Per-session main-set pace = total main-set distance / total main-set
     time.
  7. CSS = arithmetic mean of per-session main-set pace across all sessions.

Inputs: list of (activity_id, pool_length, streams_path) tuples.
"""
import json
import sys
import pathlib
from statistics import mean

REST_PACE_THRESHOLD = 200.0   # s/100m — anything slower = at wall
DRILL_CADENCE_HARD = 30.0     # below this = clear drill (kick)
DRILL_PACE_THRESHOLD = 145.0  # s/100m
DRILL_CADENCE_SOFT = 38.0     # below this with slow pace = pull/scull
SET_GAP_S = 30.0              # gap > 30 s between length ends = set boundary

def load_streams(streams_path: pathlib.Path):
    raw = streams_path.read_text()
    parsed = json.loads(raw)
    # Some persisted outputs are wrapped: [{"type":"text","text":"<json>"}]
    if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict) and parsed[0].get("type") == "text" and "text" in parsed[0]:
        return json.loads(parsed[0]["text"])
    return parsed


def lengths_from_streams(streams_path: pathlib.Path, pool_length: int):
    streams = load_streams(streams_path)
    s = {st["type"]: st["data"] for st in streams}
    t = s["time"]
    d = s["distance"]
    v = s.get("velocity_smooth", [])
    c = s.get("cadence", [])
    h = s.get("heartrate", [])
    n = len(t)

    lengths = []
    boundary_dist = pool_length
    last_idx = 0
    for i in range(n):
        if d[i] >= boundary_dist - 0.01:
            # length completed at index i
            seg_t = t[last_idx:i + 1]
            seg_c = c[last_idx:i + 1] if c else []
            seg_h = h[last_idx:i + 1] if h else []
            seg_v = v[last_idx:i + 1] if v else []
            duration = t[i] - t[last_idx]
            if duration <= 0:
                last_idx = i
                boundary_dist += pool_length
                continue
            pace_per_100 = (duration / pool_length) * 100.0
            avg_cad = mean(seg_c) if seg_c else 0
            avg_hr = mean(seg_h) if seg_h else 0
            avg_v = mean(seg_v) if seg_v else 0
            lengths.append({
                "idx": len(lengths) + 1,
                "t_start": t[last_idx],
                "t_end": t[i],
                "duration": duration,
                "pace_per_100": pace_per_100,
                "avg_cadence": avg_cad,
                "avg_hr": avg_hr,
                "avg_velocity": avg_v,
            })
            last_idx = i
            boundary_dist += pool_length
    return lengths

def classify(L):
    p = L["pace_per_100"]
    c = L["avg_cadence"]
    if p > REST_PACE_THRESHOLD:
        return "REST"
    if c < DRILL_CADENCE_HARD:
        return "DRILL"
    if p > DRILL_PACE_THRESHOLD and c < DRILL_CADENCE_SOFT:
        return "DRILL"
    return "FREE"

def main_set_pace(lengths, pool_length):
    """Main effort = FREE lengths with HR >= median HR of all FREE lengths.

    This naturally excludes warm-up FREE (lower HR before warmed up) and
    includes every rep of a multi-rep main set (which stays elevated even
    across the short rests between reps).
    """
    for L in lengths:
        L["class"] = classify(L)
    free = [L for L in lengths if L["class"] == "FREE"]
    if not free:
        return None, [], []

    hrs = sorted(L["avg_hr"] for L in free if L["avg_hr"] > 0)
    if hrs:
        median_hr = hrs[len(hrs) // 2]
    else:
        median_hr = 0

    main = [L for L in free if L["avg_hr"] >= median_hr] if median_hr else free
    if not main:
        return None, [], free

    total_d = len(main) * pool_length
    total_t = sum(x["duration"] for x in main)
    pace = (total_t / total_d) * 100.0
    return pace, main, free

def analyse(activity_id, pool_length, path, name="", date="", session_avg=None):
    p = pathlib.Path(path)
    if not p.exists():
        return None
    lengths = lengths_from_streams(p, pool_length)
    pace_main, main, free = main_set_pace(lengths, pool_length) if lengths else (None, [], [])

    cls_counts = {"FREE": 0, "DRILL": 0, "REST": 0}
    for L in lengths:
        cls_counts[L["class"]] += 1

    # All-FREE pace (drills/rest excluded, warm-up free included)
    if free:
        d_free = len(free) * pool_length
        t_free = sum(x["duration"] for x in free)
        pace_free = (t_free / d_free) * 100.0
        speed_free = 100.0 / pace_free
    else:
        pace_free = speed_free = None

    return {
        "id": activity_id,
        "date": date,
        "name": name,
        "session_avg_ms": session_avg,
        "lengths_count": len(lengths),
        "class_counts": cls_counts,
        "free_lengths": len(free),
        "free_distance_m": len(free) * pool_length if free else 0,
        "free_pace_per_100": pace_free,
        "free_speed_ms": speed_free,
        "main_effort_lengths": len(main) if main else 0,
        "main_effort_distance_m": (len(main) * pool_length) if main else 0,
        "main_effort_pace_per_100": pace_main,
        "main_effort_speed_ms": (100.0 / pace_main) if pace_main else None,
        "main": main,
        "free": free,
        "lengths": lengths,
    }

if __name__ == "__main__":
    # Usage: css_lengths.py manifest.json
    # manifest.json: [{"id":..., "pool_length":25, "path":..., "date":..., "name":..., "session_avg":...}]
    manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
    out_path = sys.argv[2] if len(sys.argv) > 2 else "css_lengths_result.json"

    results = []
    for entry in manifest:
        r = analyse(
            entry["id"],
            entry["pool_length"],
            entry["path"],
            entry.get("name", ""),
            entry.get("date", ""),
            entry.get("session_avg"),
        )
        if r:
            results.append(r)

    print(f"=== {len(results)} sessions analysed ===\n")
    print(f"{'Date':12} {'Lengths':<22} {'AllFree m/s':<13} {'AllFree /100':<14} {'MainEff m/s':<13} {'MainEff /100':<14} {'Session m/s':<12}")
    for r in results:
        cls = r["class_counts"]
        cls_str = f"F{cls['FREE']}/D{cls['DRILL']}/R{cls['REST']}"
        free_p = "—"
        free_s = "—"
        main_p = "—"
        main_s = "—"
        if r["free_pace_per_100"]:
            m, s = divmod(r["free_pace_per_100"], 60)
            free_p = f"{int(m)}:{s:05.2f}"
            free_s = f"{r['free_speed_ms']:.4f}"
        if r["main_effort_pace_per_100"]:
            m, s = divmod(r["main_effort_pace_per_100"], 60)
            main_p = f"{int(m)}:{s:05.2f}"
            main_s = f"{r['main_effort_speed_ms']:.4f}"
        sess = f"{r['session_avg_ms']:.4f}" if r["session_avg_ms"] else "—"
        print(f"{r['date']:12} {cls_str:<22} {free_s:<13} {free_p:<14} {main_s:<13} {main_p:<14} {sess:<12}")
    print()

    free_speeds = [r["free_speed_ms"] for r in results if r["free_speed_ms"]]
    main_speeds = [r["main_effort_speed_ms"] for r in results if r["main_effort_speed_ms"]]
    if free_speeds:
        m = sum(free_speeds) / len(free_speeds)
        pm, ps = divmod(100.0 / m, 60)
        print(f"CSS_all_free   = {m:.4f} m/s = {int(pm)}:{ps:05.2f}/100m  (drills/rest excluded; n={len(free_speeds)})")
    if main_speeds:
        m = sum(main_speeds) / len(main_speeds)
        pm, ps = divmod(100.0 / m, 60)
        print(f"CSS_main_eff   = {m:.4f} m/s = {int(pm)}:{ps:05.2f}/100m  (drills + warm-up free excluded; n={len(main_speeds)})")
    speeds = main_speeds  # for legacy summary write

    pathlib.Path(out_path).write_text(json.dumps([
        {k: v for k, v in r.items() if k not in ("lengths", "main", "sets")}
        for r in results
    ], indent=2))
    print(f"\nSummary JSON written to {out_path}")
