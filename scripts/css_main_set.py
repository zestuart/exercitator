"""Recompute CSS using only the main-set block from interval_summary.

Heuristic: parse each session's interval_summary, identify the longest block
(by N*D total metres) as the main set, take that block's pace, and compute
the mean across sessions.

Format: "Nx Dm M:SS" where M:SS is pace per 100 m (verified against
session.average_speed: weighted mean of block paces matches to within rounding).
"""
import json
import re
import sys
import pathlib

INPUT = sys.argv[1]
OLDEST_FLOOR = sys.argv[2] if len(sys.argv) > 2 else None  # YYYY-MM-DD

PATTERN = re.compile(r"(\d+)x\s+(\d+)m\s+(\d+):(\d+)")

raw = json.loads(pathlib.Path(INPUT).read_text())

results = []
for a in raw:
    if a.get("type") != "Swim":
        continue
    if not a.get("pool_length"):
        continue
    if (a.get("moving_time") or 0) < 600:
        continue
    if OLDEST_FLOOR and a.get("start_date", "")[:10] < OLDEST_FLOOR:
        continue

    summary = a.get("interval_summary") or []
    if not summary:
        continue

    blocks = []
    for entry in summary:
        m = PATTERN.match(entry)
        if not m:
            continue
        n = int(m.group(1))
        d = int(m.group(2))
        sec = int(m.group(3)) * 60 + int(m.group(4))
        if d == 0 or sec == 0:
            continue
        speed = 100.0 / sec  # pace per 100m → m/s
        total_m = n * d
        blocks.append({
            "raw": entry,
            "reps": n,
            "rep_distance": d,
            "total_distance": total_m,
            "pace_per_100": sec,
            "speed_ms": speed,
        })

    if not blocks:
        continue

    # Main set = block with greatest total distance.
    main = max(blocks, key=lambda b: b["total_distance"])
    # Warm-up = first block; cooldown = last block (excluding main).
    warm = blocks[0]
    cool = blocks[-1]

    # Sanity: weighted mean of all blocks vs session avg_speed.
    total_d = sum(b["total_distance"] for b in blocks)
    weighted = sum(b["total_distance"] * b["speed_ms"] for b in blocks) / total_d
    session_avg = a.get("average_speed") or 0

    results.append({
        "id": a["id"],
        "date": a["start_date"][:10],
        "name": a.get("name"),
        "session_avg_ms": session_avg,
        "blocks": blocks,
        "warm": warm,
        "main": main,
        "cool": cool,
        "weighted_check": weighted,
    })

results.sort(key=lambda r: r["date"], reverse=True)

print(f"=== {len(results)} sessions ===\n")
for r in results:
    print(f"{r['date']}  {r['name']}")
    for b in r["blocks"]:
        marker = "  "
        if b is r["main"]:
            marker = "M "
        elif b is r["warm"]:
            marker = "W "
        elif b is r["cool"]:
            marker = "C "
        m, s = divmod(b["pace_per_100"], 60)
        print(f"  {marker}{b['raw']:<14} {b['total_distance']:>4}m  {b['speed_ms']:.4f} m/s  ({m}:{s:02d}/100m)")
    print(f"  session avg: {r['session_avg_ms']:.4f}  (weighted check: {r['weighted_check']:.4f})")
    m_ms = r["main"]["speed_ms"]
    pm, ps = divmod(int(round(100.0 / m_ms)), 60)
    print(f"  → MAIN-only: {m_ms:.4f} m/s  ({pm}:{ps:02d}/100m)\n")

main_speeds = [r["main"]["speed_ms"] for r in results]
mean_main = sum(main_speeds) / len(main_speeds)
pm, ps = divmod(100.0 / mean_main, 60)
print(f"=== Mean of main-set pace across {len(results)} sessions ===")
print(f"  CSS_main = {mean_main:.4f} m/s  ({int(pm)}:{ps:05.2f}/100m)")
print(f"  vs CSS_whole-session (0.8937 m/s = 1:51.90)")
print(f"  delta: +{(mean_main - 0.8937)*1000:.1f} mm/s  ({100/0.8937 - 100/mean_main:+.2f} s/100m faster)")
