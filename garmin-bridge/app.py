"""Garmin bridge — a tiny bearer-gated REST surface over the garth/garminconnect
client, so the Exercitator backend can read Garmin recovery telemetry + activity
FITs the same way it reads Promus. Tailnet-only; no funnel.

Run: uvicorn app:app --host 0.0.0.0 --port 8655
Auth: every route except /health requires `Authorization: Bearer $GARMIN_BRIDGE_API_KEY`.
Token: resume from a garth token at $GARMIN_TOKENSTORE (mint once via garmin_login.py).
"""

from __future__ import annotations

import hmac
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Response

import garmin_client as gc

API_KEY = os.environ.get("GARMIN_BRIDGE_API_KEY", "")

app = FastAPI(title="garmin-bridge", version="0.1.0")


def require_bearer(authorization: str = Header(default="")) -> None:
    if not API_KEY:
        # Fail closed: an unset key means the service is misconfigured, not open.
        raise HTTPException(status_code=503, detail="bridge API key not configured")
    prefix = "Bearer "
    token = authorization[len(prefix):] if authorization.startswith(prefix) else ""
    # Constant-time compare to avoid leaking the key via timing.
    if not token or not hmac.compare_digest(token, API_KEY):
        raise HTTPException(status_code=401, detail="unauthorized")


def _reauth(exc: gc.GarminReauthError) -> HTTPException:
    return HTTPException(status_code=503, detail={"reason": "garmin_reauth_required", "detail": str(exc)})


@app.get("/health")
def health() -> dict:
    # Pure liveness — does NOT touch Garmin (so the 60s Docker healthcheck can't
    # hammer Garmin or trip rate limits). Use /health/garmin for a reachability probe.
    return {"ok": True}


@app.get("/health/garmin", dependencies=[Depends(require_bearer)])
def health_garmin() -> dict:
    # Bearer-gated: makes a live Garmin call, so leaving it open would let a
    # tailnet caller flood Garmin (rate-limit / block). For debugging / confirming
    # the mounted token — NOT the container healthcheck (that hits bare /health).
    return gc.health()


@app.get("/body_battery/current", dependencies=[Depends(require_bearer)])
def body_battery_current() -> dict:
    try:
        return gc.body_battery_current()
    except gc.GarminReauthError as exc:
        raise _reauth(exc)


@app.get("/hrv_nightly", dependencies=[Depends(require_bearer)])
def hrv_nightly(days: int = 7) -> list[dict]:
    try:
        return gc.hrv_nightly(days)
    except gc.GarminReauthError as exc:
        raise _reauth(exc)


@app.get("/sleep_nightly", dependencies=[Depends(require_bearer)])
def sleep_nightly(start: str, end: str) -> list[dict]:
    try:
        return gc.sleep_nightly(start, end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except gc.GarminReauthError as exc:
        raise _reauth(exc)


@app.get("/training_readiness", dependencies=[Depends(require_bearer)])
def training_readiness(date: str) -> dict:
    try:
        return gc.training_readiness(date)
    except gc.GarminReauthError as exc:
        raise _reauth(exc)


@app.get("/activities", dependencies=[Depends(require_bearer)])
def activities(start: str, end: str) -> list[dict]:
    try:
        return gc.activities(start, end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except gc.GarminReauthError as exc:
        raise _reauth(exc)


@app.get("/activity/{activity_id}/fit", dependencies=[Depends(require_bearer)])
def activity_fit(activity_id: int) -> Response:
    try:
        raw = gc.activity_fit(activity_id)
    except gc.GarminReauthError as exc:
        raise _reauth(exc)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=raw, media_type="application/octet-stream")
