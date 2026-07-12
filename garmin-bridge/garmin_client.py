"""Thin, defensive wrapper around garminconnect for the bridge service.

Garmin Connect has no stable public API — garth/garminconnect break when Garmin
rotates endpoints or response shapes. This wrapper isolates that fragility: it
normalises Garmin's messy responses into the SAME small DTO shapes the WHOOP
health feed already exposes, so the Exercitator side treats Garmin and WHOOP
identically:

  - body_battery_current() -> {"value": int 0-100, "level": "high|medium|low"}
        (mirrors Promus Vigor Vitae's {value, level})
  - hrv_nightly(days)      -> [{"wake_day_utc": "YYYY-MM-DD",
                                "rmssd_median_ms": float | None}, ...]
        (mirrors Promus getWhoopHrvNightly rows)
  - sleep_nightly(a, b)    -> [{"wake_date": "YYYY-MM-DD",
                                "duration_s": int | None}, ...]
        (mirrors Promus getWhoopSleep rows)

Field extraction is intentionally defensive (multiple candidate keys, wrapped in
try/except) because the exact Garmin JSON shape is only knowable against a live
token. Validate the first live pull against the co-wear reference before trusting
the numbers.

Auth: resume from a garth OAuth token cached at GARMIN_TOKENSTORE (minted once,
out of band, by garmin_login.py). A 401 / auth error raises GarminReauthError so
the service can surface `garmin_reauth_required` rather than 500.
"""

from __future__ import annotations

import datetime as dt
import io
import os
import threading
import zipfile
from typing import Any, Optional

from garminconnect import Garmin

TOKENSTORE = os.environ.get("GARMIN_TOKENSTORE", os.path.expanduser("~/.garminconnect"))

# garminconnect is not thread-safe; uvicorn may run >1 worker thread for a
# blocking route. Serialise all Garmin calls behind one lock.
_LOCK = threading.Lock()
_G: Optional[Garmin] = None


class GarminReauthError(RuntimeError):
    """The cached token is missing/expired/revoked — re-run garmin_login.py."""


def _client() -> Garmin:
    global _G
    if _G is not None:
        return _G
    if not os.path.isdir(TOKENSTORE):
        raise GarminReauthError(f"no cached token at {TOKENSTORE}")
    g = Garmin()
    try:
        g.login(TOKENSTORE)  # resume from cached token, no password
    except Exception as exc:  # noqa: BLE001 — garminconnect raises a zoo of types
        raise GarminReauthError(f"token login failed: {exc}") from exc
    _G = g
    return g


def _call(fn, *args):
    """Run a Garmin call under the lock, mapping auth failures to reauth."""
    with _LOCK:
        try:
            return fn(_client(), *args)
        except GarminReauthError:
            raise
        except Exception as exc:  # noqa: BLE001
            msg = str(exc).lower()
            if "401" in msg or "auth" in msg or "unauthor" in msg or "token" in msg:
                # Drop the cached client so the next call re-attempts a fresh login.
                global _G
                _G = None
                raise GarminReauthError(str(exc)) from exc
            raise


def _daterange(a: dt.date, b: dt.date):
    d = a
    while d <= b:
        yield d
        d += dt.timedelta(days=1)


# Per-day endpoints iterate the range making one upstream Garmin call each, so an
# unbounded span would flood Garmin (rate-limit / DoS) and block the single worker.
# The only caller is exercitator with a 7-day window; clamp defensively regardless.
MAX_RANGE_DAYS = 90

# Zip-bomb / oversized-FIT guard for activity_fit (matches the TS client's cap).
MAX_FIT_BYTES = 16 * 1024 * 1024


def _bounded_range(start: str, end: str) -> tuple[dt.date, dt.date]:
    a = dt.date.fromisoformat(start)
    b = dt.date.fromisoformat(end)
    span = (b - a).days
    if span < 0 or span > MAX_RANGE_DAYS:
        raise ValueError(f"date range must be 0..{MAX_RANGE_DAYS} days (got {span})")
    return a, b


def health() -> dict[str, Any]:
    """Cheap auth probe. Never raises for a mere data gap — only for reauth."""
    try:
        name = _call(lambda g: g.get_full_name())
        return {"ok": True, "garmin_reachable": True, "account": name}
    except GarminReauthError as exc:
        return {"ok": False, "garmin_reachable": False, "reason": "garmin_reauth_required", "detail": str(exc)}


def _bb_level(value: int) -> str:
    # Garmin Body Battery is a bare 0-100 with no categorical band; derive one to
    # fill the {value, level} shape Vigor Vitae uses. Thresholds are a convention,
    # not a Garmin-published mapping.
    if value >= 67:
        return "high"
    if value >= 34:
        return "medium"
    return "low"


def body_battery_current() -> dict[str, Any]:
    """Latest Body Battery level (0-100) as the acute recovery signal."""
    today = dt.date.today()
    start = today - dt.timedelta(days=1)  # include yesterday so early-morning has data
    rows = _call(lambda g: g.get_body_battery(start.isoformat(), today.isoformat())) or []

    latest_ts = -1
    latest_val: Optional[int] = None
    for day in rows:
        arr = (day or {}).get("bodyBatteryValuesArray") or []
        for entry in arr:
            # Common shape: [epoch_ms, "MEASURED"|"CHARGING"..., level_int]
            if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                continue
            ts = entry[0] if isinstance(entry[0], (int, float)) else -1
            lvl = next(
                (x for x in entry[1:] if isinstance(x, int) and 0 <= x <= 100),
                None,
            )
            if lvl is not None and ts >= latest_ts:
                latest_ts, latest_val = ts, lvl

    if latest_val is None:
        return {"value": None, "level": "unknown"}
    return {"value": latest_val, "level": _bb_level(latest_val)}


def _extract_rmssd(hrv: Any) -> Optional[float]:
    if not isinstance(hrv, dict):
        return None
    summary = hrv.get("hrvSummary") or {}
    for key in ("lastNightAvg", "lastNight5MinHigh", "weeklyAvg"):
        v = summary.get(key)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def hrv_nightly(days: int) -> list[dict[str, Any]]:
    """Per-day overnight HRV (RMSSD-like ms), mirroring getWhoopHrvNightly rows."""
    days = max(1, min(days, 30))
    end = dt.date.today()
    start = end - dt.timedelta(days=days - 1)
    out: list[dict[str, Any]] = []
    for d in _daterange(start, end):
        ds = d.isoformat()
        try:
            hrv = _call(lambda g, ds=ds: g.get_hrv_data(ds))
        except GarminReauthError:
            raise
        except Exception:  # noqa: BLE001 — a single missing day is not fatal
            hrv = None
        out.append({"wake_day_utc": ds, "rmssd_median_ms": _extract_rmssd(hrv)})
    return out


def _extract_sleep_secs(sleep: Any) -> Optional[int]:
    if not isinstance(sleep, dict):
        return None
    dto = sleep.get("dailySleepDTO") or {}
    for key in ("sleepTimeSeconds", "sleepTimeSecondsTotal"):
        v = dto.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return int(v)
    v = sleep.get("sleepTimeSeconds")
    return int(v) if isinstance(v, (int, float)) and v > 0 else None


def sleep_nightly(start: str, end: str) -> list[dict[str, Any]]:
    """Per-day sleep duration (s), mirroring getWhoopSleep rows."""
    a, b = _bounded_range(start, end)
    out: list[dict[str, Any]] = []
    for d in _daterange(a, b):
        ds = d.isoformat()
        try:
            sleep = _call(lambda g, ds=ds: g.get_sleep_data(ds))
        except GarminReauthError:
            raise
        except Exception:  # noqa: BLE001
            sleep = None
        out.append({"wake_date": ds, "duration_s": _extract_sleep_secs(sleep)})
    return out


def training_readiness(date: str) -> dict[str, Any]:
    tr = _call(lambda g: g.get_training_readiness(date))
    row = tr[0] if isinstance(tr, list) and tr else (tr if isinstance(tr, dict) else {})
    return {
        "date": date,
        "score": row.get("score"),
        "level": row.get("level"),
    }


def activities(date_from: str, date_to: str) -> list[dict[str, Any]]:
    _bounded_range(date_from, date_to)  # reject an abusive span before hitting Garmin
    acts = _call(lambda g: g.get_activities_by_date(date_from, date_to)) or []
    out = []
    for a in acts:
        out.append(
            {
                "id": a.get("activityId"),
                "name": a.get("activityName"),
                "sport": (a.get("activityType") or {}).get("typeKey", "unknown"),
                "start_local": a.get("startTimeLocal"),
                "start_gmt": a.get("startTimeGMT"),
                "duration_s": a.get("duration"),
            }
        )
    return out


def activity_fit(activity_id: int) -> bytes:
    """Original activity FIT bytes (unzipped from Garmin's ORIGINAL zip)."""
    data = _call(
        lambda g: g.download_activity(activity_id, dl_fmt=Garmin.ActivityDownloadFormat.ORIGINAL)
    )
    zf = zipfile.ZipFile(io.BytesIO(data))
    fits = [n for n in zf.namelist() if n.lower().endswith(".fit")]
    if not fits:
        raise FileNotFoundError(f"no .fit inside ORIGINAL zip for activity {activity_id}")
    # Zip-bomb guard: check the declared uncompressed size before decompressing into
    # memory, so a hostile archive can't OOM the single-worker container.
    info = zf.getinfo(fits[0])
    if info.file_size > MAX_FIT_BYTES:
        raise ValueError(
            f"FIT for activity {activity_id} too large "
            f"({info.file_size} bytes, limit {MAX_FIT_BYTES})"
        )
    return zf.read(fits[0])
