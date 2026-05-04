# Exercitator HTTP API — Service Specification

**Version**: 0.1 (2026-04-23)
**Status**: superseded — retained as historical scaffolding only

> **SUPERSEDED.** Canonical wire contract is now `phase2/exercitator-http-api-spec.md` (v0.2, deployed 2026-04-24) plus the v0.3 delta in `phase3/exercitator-http-api-v0.3-delta.md` (deployed 2026-05-03 as commit `bf1393b`). See also `phase3/exercitator-http-api-v0.3-amendment-resolution-2026-05-03.md` for the `push-to-stryd` response-shape clarification. This v0.1 draft predates push-to-stryd, form-text, and the typed field tables; do not implement against it.
**Purpose**: Define the HTTP surface Exercitator exposes for native clients (primarily Excubitor iOS). Exercitator remains an MCP server for LLM-facing consumers; this document adds a parallel REST API so phones and watches can read training state without spinning up an MCP client.

**Authoritative references**:
- NOMENCLATOR entry: `EXERCITATOR` (MCP server: intervals.icu training analytics)
- Promus service spec: `/Users/ze/Documents/claude/promus/docs/backend-spec.md` — this spec mirrors promus's conventions for auth, body limits, timestamps, error shape, and deployment.

---

## 1. Overview

Exercitator ingests analytics from intervals.icu and computes Zë's current training state: critical power (CP) from Stryd, Vigil readiness status, scheduled workouts, and suggested workouts based on recent training load. The MCP surface (`tools/`) exposes these to LLMs. This REST surface exposes the same facts to Excubitor so the Exercise tab (`Exercitatio`) can display them without round-tripping through an LLM.

**Host**: Cogitator (Mac Mini), containerised Docker service alongside Promus.
**Runtime**: to be decided by executor — either extend the existing Exercitator MCP server with an HTTP handler (preferred — single binary, shared data model) or add a dedicated HTTP daemon that reads the same upstream intervals.icu cache.
**Deployment**: Tailscale-only access via a sidecar container, mirroring Promus. Hostname `exercitator` → `exercitator.tail7ab379.ts.net`.
**Clients**: Excubitor iOS (primary), watchOS (v2.5, forwarded via iOS companion).

### 1.1 Architectural boundary

Exercitator **reads** from:
- intervals.icu (primary data source, same credentials as MCP surface)
- Stryd Power Center (CP history, if accessible without a user session; otherwise cached via intervals.icu's Stryd linkage)

Exercitator **does not**:
- Write to intervals.icu
- Store heart-rate or sleep data (Promus owns that domain)
- Expose raw FIT files (intervals.icu does that)

Excubitor's Exercise tab pulls aggregate training state from this API and cross-references heart-rate/recovery signals from `GET /api/dashboard` on Promus.

---

## 2. Authentication

Bearer token in `Authorization: Bearer <key>`. Keys loaded from `EXERCITATOR_API_KEYS` (comma-separated) or `EXERCITATOR_API_KEYS_FILE` (Docker secret). Constant-time compare on every request. One key per client recommended — `excubitor-ios`, `excubitor-watchos` (v2.5), `palaestra-ios` (if it ever needs read access).

**Unauthenticated**: `GET /api/health` only.

---

## 3. Request limits and conventions

| Property | Value | Rationale |
|---|---|---|
| Request body limit | 1 MiB | All bodies are small JSON; no bulk upload path |
| Per-request timeout | 10 s | Upstream intervals.icu can be slow; 10 s permits a single cache-miss round trip |
| Default `Content-Type` | `application/json; charset=utf-8` | All responses |
| Timestamps | RFC 3339 (`2026-04-23T18:20:00Z`) | No bulk time-series, so promus's epoch-seconds optimisation is unnecessary |
| Units | Metric, SI. Power in watts, distance in metres, duration in seconds, mass in kg | Matches Zë's preferences and intervals.icu's native units |
| `Accept-Language` | Ignored | API is English-only |
| Cache headers | `Cache-Control: private, max-age=300` on `/api/status` and `/api/workouts/suggested` | Reduce redundant calls while Excubitor polls |

---

## 4. Error response shape

Matches promus's `AppError` shape for client uniformity:

```json
{ "error": "upstream unavailable" }
```

Status codes:

| Code | Meaning |
|---|---|
| 200 | Success |
| 400 | Malformed request |
| 401 | Missing or invalid bearer token |
| 404 | Resource not found (unknown workout id) |
| 502 | Upstream intervals.icu / Stryd error |
| 503 | Service unavailable (cold start, cache warming) |
| 504 | Upstream timeout |

---

## 5. Endpoints

### 5.1 Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Service health + upstream reachability |

**Response**:
```json
{
  "ok": true,
  "intervals_reachable": true,
  "stryd_reachable": true,
  "cache_age_s": 87,
  "version": "0.1.0"
}
```

### 5.2 Training status (the Vigil payload)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/status` | Current Vigil status, CP, fitness/fatigue/form, recent load |

This is the payload Excubitor's **Now** (`Nunc`) tab shows alongside biometric hero numbers, and the header of the **Exercise** (`Exercitatio`) tab.

**Response**:
```json
{
  "generated_at": "2026-04-23T18:20:00Z",
  "athlete_id": "i12345",
  "vigil": {
    "status": "ready",
    "score": 86,
    "advisory": "green"
  },
  "critical_power": {
    "watts": 312,
    "source": "stryd",
    "updated_at": "2026-04-20T00:00:00Z",
    "confidence": "high"
  },
  "training_load": {
    "fitness_ctl": 72.4,
    "fatigue_atl": 54.1,
    "form_tsb": 18.3,
    "weekly_tss": 412,
    "7d_trend": "rising"
  },
  "last_workout": {
    "id": "iv-9876543",
    "started_at": "2026-04-22T06:15:00Z",
    "name": "Threshold 3×10'",
    "duration_s": 3720,
    "tss": 68,
    "intensity_factor": 0.88
  }
}
```

Field semantics:

| Field | Type | Notes |
|---|---|---|
| `vigil.status` | enum: `ready`, `amber`, `recover`, `unknown` | Exercitator's readiness verdict. `unknown` if < 7 days of data |
| `vigil.score` | int 0–100 | Composite score; clients should prefer `status` for display |
| `vigil.advisory` | enum: `green`, `amber`, `red`, `grey` | Visual colour hint — maps to the wake-palette accent ring on the Now tab |
| `critical_power.confidence` | enum: `high`, `medium`, `low` | `low` when CP hasn't been re-tested in > 60 days |
| `training_load.7d_trend` | enum: `rising`, `flat`, `falling` | Rolling 7-day CTL slope |

All fields are nullable unless marked otherwise. `null` is rendered as `—` in Excubitor.

### 5.3 Scheduled workouts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workouts/today` | Today's scheduled and completed workouts |
| `GET` | `/api/workouts/suggested` | Upcoming suggested workouts, ranked |
| `GET` | `/api/workouts/{id}` | Workout detail (steps, targets, structure) |

#### `GET /api/workouts/today`

**Query**:
- `tz` (optional) — IANA TZ identifier, e.g. `Europe/London`. Default: UTC. Controls which calendar day counts as "today".

**Response**:
```json
{
  "date": "2026-04-23",
  "tz": "Europe/London",
  "scheduled": [
    {
      "id": "iv-sched-4411",
      "name": "Tempo 45'",
      "type": "run",
      "planned_duration_s": 2700,
      "planned_tss": 55,
      "target_power_w": [265, 285],
      "structured": true,
      "stryd_pushed": false
    }
  ],
  "completed": [
    {
      "id": "iv-9876544",
      "name": "Tempo 45'",
      "type": "run",
      "started_at": "2026-04-23T06:42:00Z",
      "duration_s": 2685,
      "tss": 54,
      "intensity_factor": 0.82,
      "avg_power_w": 271,
      "planned_id": "iv-sched-4411"
    }
  ]
}
```

#### `GET /api/workouts/suggested`

**Query**:
- `count` (optional, 1–14, default 5) — max suggestions to return
- `horizon_days` (optional, 1–14, default 7) — look this many days ahead

**Response**:
```json
{
  "generated_at": "2026-04-23T18:20:00Z",
  "horizon_days": 7,
  "suggestions": [
    {
      "day_offset": 0,
      "priority": "optimum",
      "workout": {
        "id": "iv-sugg-a",
        "name": "Threshold 4×8'",
        "type": "run",
        "planned_duration_s": 3600,
        "planned_tss": 72,
        "target_power_w": [298, 316],
        "rationale": "CTL rising, recent TSB 18.3 — threshold tolerable today"
      }
    },
    {
      "day_offset": 0,
      "priority": "alternate",
      "workout": {
        "id": "iv-sugg-b",
        "name": "Easy 60'",
        "type": "run",
        "planned_duration_s": 3600,
        "planned_tss": 42,
        "target_power_w": [200, 235],
        "rationale": "Low-risk option if Vigil downgrades to amber"
      }
    }
  ]
}
```

`priority` values: `optimum` (top pick), `alternate` (backup), `deload` (explicitly lighter). Excubitor shows `optimum` by default, expands to show `alternate`/`deload` on tap.

#### `GET /api/workouts/{id}`

**Response** — full workout definition including structured steps:
```json
{
  "id": "iv-sugg-a",
  "name": "Threshold 4×8'",
  "type": "run",
  "planned_duration_s": 3600,
  "planned_tss": 72,
  "target_power_w": [298, 316],
  "structured": true,
  "steps": [
    { "kind": "warmup", "duration_s": 900, "target_power_w": [200, 235] },
    { "kind": "interval", "duration_s": 480, "target_power_w": [298, 316], "repeat": 4, "recovery_s": 180, "recovery_power_w": [180, 210] },
    { "kind": "cooldown", "duration_s": 600, "target_power_w": [180, 210] }
  ],
  "source": "suggested",
  "created_at": "2026-04-23T18:20:00Z",
  "stryd_pushable": true
}
```

### 5.4 Push a workout to Stryd

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/workouts/{id}/push-to-stryd` | Queue a workout onto the Stryd watchface for the next run |

Deferred to v0.2. Excubitor uses this in the watchOS push (v2.5 per original brief). v0.1 returns `501 Not Implemented`.

### 5.5 Dashboard payload (convenience)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/dashboard` | Aggregate of `/status` + `/workouts/today` + 5-day suggested in one call |

Provided so Excubitor's Exercise tab can do one request instead of three. Response is the concatenation of the three payloads under keys `status`, `today`, `suggested`.

---

## 6. Stryd integration notes

Critical power comes from intervals.icu's Stryd linkage when available (users who have connected their Stryd account to intervals.icu). Direct Stryd API access is a stretch goal — the public Stryd API has historically been unstable.

**Fallback chain for `critical_power.watts`**:
1. intervals.icu athlete settings `power_curve` → CP from last recorded test within 90 days
2. intervals.icu Stryd linkage → `running_cp` field if present
3. Most recent threshold-test activity → infer CP as NP during the last 30-min sustained effort
4. If none available: `null` with `confidence: "low"` and `source: "stale"`

---

## 7. Configuration

All secrets follow the `{VAR}` / `{VAR}_FILE` convention from promus:

| Variable | `_FILE` form | Required | Notes |
|---|---|---|---|
| `EXERCITATOR_BIND_ADDR` | — | no | Default `0.0.0.0:8081` |
| `EXERCITATOR_API_KEYS` | `EXERCITATOR_API_KEYS_FILE` | yes | Comma-separated bearer tokens |
| `EXERCITATOR_INTERVALS_ATHLETE_ID` | — | yes | intervals.icu athlete id |
| `EXERCITATOR_INTERVALS_API_KEY` | `EXERCITATOR_INTERVALS_API_KEY_FILE` | yes | intervals.icu API key (username is literal string `API_KEY`) |
| `EXERCITATOR_CACHE_TTL_S` | — | no | Upstream cache TTL, default 300 |
| `EXERCITATOR_VIGIL_MIN_HISTORY_DAYS` | — | no | Below this, `vigil.status = unknown`, default 7 |
| `RUST_LOG` / `LOG_LEVEL` | — | no | Matches runtime-language convention |

---

## 8. Tailscale exposure

Same sidecar pattern as promus:

```
tailscale-exercitator  (tailscale/tailscale:latest, userspace mode)
  hostname:    exercitator
  serve:       :443 HTTPS → http://exercitator:8081
  state volume: exercitator_tailscale-state
```

Auth key minted as reusable, preauthorised, ephemeral=false; supplied via host `.env`.

---

## 9. Polling cadence (client guidance for Excubitor)

| Endpoint | Cadence | Trigger |
|---|---|---|
| `/api/status` | On app foreground; on Exercise tab entry; every 15 min while app is foreground | User-facing |
| `/api/workouts/today` | Once per foreground; again after any completed workout event in Promus | User-facing |
| `/api/workouts/suggested` | Once per foreground; cached 10 min client-side | User-facing |
| `/api/health` | Never in production — diagnostic only | — |

Background fetch must not poll (Excubitor has no push path from Exercitator; v2 push notifications go via APNs from a separate push service). If a foreground refresh returns `503` or times out, display the last cached payload with a "stale since HH:MM" label.

---

## 10. Versioning

No versioned URL prefix in v0.1. When a breaking change is needed, introduce `/api/v2/...` with the existing `/api/...` remaining live for at least one client release cycle.

---

## 11. Open questions (for Exercitator implementer)

1. **Runtime language**: extend existing MCP server (whatever language Exercitator is currently written in) or add a sidecar? This spec is implementation-agnostic.
2. **Vigil formula**: not specified here because it's Exercitator's internal logic. The API contract is `status` + `score` + `advisory`; formula is free to evolve.
3. **Stryd CP test detection**: whether to auto-recompute CP when an intervals.icu activity looks like a CP test, or only when the user manually updates. Default: read what intervals.icu has, no auto-compute.
4. **Suggested workout provenance**: these come from either intervals.icu's scheduled workouts or an Exercitator-internal suggestion engine. v0.1 just reads scheduled workouts; v0.2 can add generation.

---

## 12. Change log

### 2026-04-23 — v0.1
- Initial draft. Written as a companion to `excubitor-ui-plan.md` to unblock Excubitor's Exercise tab work.
- Defers `/push-to-stryd` to v0.2.
- Defers in-server workout suggestion engine to v0.2; v0.1 just exposes intervals.icu scheduled workouts.
