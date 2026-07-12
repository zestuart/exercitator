# garmin-bridge

A tiny bearer-gated FastAPI service over the [`garminconnect`](https://pypi.org/project/garminconnect/)
/ `garth` client. It lets the Exercitator backend read **Garmin Connect recovery
telemetry** (Body Battery, overnight HRV, sleep) and **original activity FITs** the
same way it reads Promus — normalised into WHOOP-shaped DTOs so `fetchHealthTelemetry`
treats Garmin and WHOOP identically.

Lifted from `../blueToothDisco/tools/output/body_battery/` (the proven co-wear-trial
client). Tailnet-only (no funnel). Isolated in its own service because **Garmin has no
stable public API** — `garth`/`garminconnect` break when Garmin rotates endpoints, and
that fragility must not live in the main backend.

## Endpoints

All except `/health` require `Authorization: Bearer $GARMIN_BRIDGE_API_KEY`.

| Route | Returns | Mirrors |
|-------|---------|---------|
| `GET /health` | `{ok, garmin_reachable, account?}` | exercitator `/health` |
| `GET /body_battery/current` | `{value: 0-100, level: high\|medium\|low}` | Promus Vigor Vitae `{value, level}` |
| `GET /hrv_nightly?days=N` | `[{wake_day_utc, rmssd_median_ms}]` | Promus `getWhoopHrvNightly` |
| `GET /sleep_nightly?start&end` | `[{wake_date, duration_s}]` | Promus `getWhoopSleep` |
| `GET /training_readiness?date` | `{date, score, level}` | (bonus) |
| `GET /activities?start&end` | `[{id, name, sport, start_local, start_gmt, duration_s}]` | — |
| `GET /activity/{id}/fit` | raw `.fit` bytes (`application/octet-stream`) | — |

On an expired/revoked/missing token, protected routes return **503** with
`{reason: "garmin_reauth_required"}` — re-run the login (below).

## Token bootstrap (one-time, interactive)

Garmin login needs email + password + MFA, so it cannot run in the headless
container. Mint the token once on a trusted machine, then copy it into the
mounted volume:

```bash
cd garmin-bridge
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
GARMIN_TOKENSTORE=./token python3 garmin_login.py     # prompts email/password/MFA
# → ./token now holds the garth OAuth token (oauth1/oauth2 json)

# Copy into the Cogitator volume the bridge reads (GARMIN_TOKENSTORE=/tokens):
scp -r ./token/* dominus@cogitator.tail7ab379.ts.net:/tmp/garmin-token/
ssh dominus@cogitator.tail7ab379.ts.net 'zsh -ic "docker run --rm -v garmin-token-state:/t -v /tmp/garmin-token:/src alpine sh -c \"cp -r /src/. /t/ && chmod -R 700 /t\"" && rm -rf /tmp/garmin-token'
```

`garth` silently refreshes the short-lived OAuth2 bearer on each call; the OAuth1
token lives ~1 year. Re-bootstrap only when the bridge reports
`garmin_reauth_required` (token revoked in Garmin account settings, or expired).

## Local run

```bash
GARMIN_BRIDGE_API_KEY=dev GARMIN_TOKENSTORE=./token \
  uvicorn app:app --host 0.0.0.0 --port 8655
curl -s localhost:8655/health
curl -s -H "Authorization: Bearer dev" localhost:8655/body_battery/current
```
