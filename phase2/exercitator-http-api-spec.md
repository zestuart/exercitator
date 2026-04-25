# Exercitator HTTP API — Service Specification

**Version**: 0.2 (2026-04-24)
**Status**: draft — supersedes v0.1 (2026-04-23)
**Purpose**: Define the HTTP surface Exercitator exposes for native clients (primarily Excubitor iOS). Exercitator remains an MCP server for LLM-facing consumers; this document adds a parallel REST API so phones and watches can read training state without spinning up an MCP client.

**v0.2 deltas from v0.1**: see §13.

**Authoritative references**:
- NOMENCLATOR entry: `EXERCITATOR` (MCP server: intervals.icu training analytics)
- Promus service spec: `/Users/ze/Documents/claude/promus/docs/backend-spec.md` — auth, body limits, timestamps, error shape, deployment conventions mirror promus.
- Existing codebase: `/Users/ze/conductor/workspaces/exercitator/islamabad/CLAUDE.md`. Where this spec disagreed with the codebase, the codebase wins.

---

## 1. Overview

Exercitator ingests analytics from intervals.icu and computes the athlete's training state: critical power (CP) from Stryd, readiness score, biomechanical injury warnings (Vigil), scheduled and prescribed workouts, and compliance against past prescriptions. The MCP surface (`src/tools/`) exposes these to LLMs. The Praescriptor surface (`src/web/`) renders them as HTML for tailnet-hosted browsers. This new REST surface exposes the same facts to native clients so the Excubitor iOS Exercise tab (`Exercitatio`) can display them without round-tripping through an LLM or scraping HTML.

**Host**: Arca Ingens (QNAP NAS), inside the existing `exercitator-mcp` container (single binary, shared data model).
**Runtime**: Node.js + TypeScript — same as the existing MCP server. Config keys use no language-specific prefix (no `RUST_LOG`).
**Deployment**: tailnet-only via a new Tailscale sidecar mirroring Praescriptor's pattern. Hostname `exercitator-api` → `exercitator-api.tail7ab379.ts.net`. The existing public MCP funnel is unchanged.
**Clients**: Excubitor iOS (primary), watchOS (v2.5, forwarded via iOS companion).

### 1.1 Multi-user model

Exercitator already supports multiple athletes (`ze`, `pam`) with independent intervals.icu and Stryd credentials. The HTTP API mirrors Praescriptor's URL-scoped multi-user model: every per-athlete endpoint lives under `/api/users/:userId/...`. The single-athlete v0.1 model has been removed.

User registry is the existing `src/web/users.ts`. New endpoints reuse the same `IntervalsClient` and `StrydClient` maps.

### 1.2 Architectural boundary

Exercitator **reads** from:
- intervals.icu (primary data source)
- Stryd Power Center (CP, FIT files for Vigil baselines)

Exercitator **writes** to:
- intervals.icu wellness records (`update_wellness`) — used today by the MCP surface and by the Vigil pipeline (severity ≥ 2 → `injury` field). The HTTP API exposes a read-only subset by default; opt-in writes are listed in §5.7.
- intervals.icu calendar (events, planned workouts) — used by Praescriptor's "send to intervals.icu" button. **Deferred**: not exposed via the HTTP API in v0.2.
- Stryd calendar — used by Praescriptor's "push to Stryd" button. **Deferred** (see §5.6).
- Local SQLite (`data/exercitator.db`) — caches, Vigil metrics/baselines, Stryd enrichment tracking, compliance.

(v0.1's claim that Exercitator does not write to intervals.icu was incorrect.)

Excubitor's Exercise tab pulls aggregate training state from this API and cross-references heart-rate/recovery signals from `GET /api/dashboard` on Promus.

---

## 2. Authentication

Bearer token in `Authorization: Bearer <key>`. Keys loaded from `EXERCITATOR_API_KEYS` (comma-separated) or `EXERCITATOR_API_KEYS_FILE` (Docker secret). Constant-time compare on every request.

**Key naming convention**: each key is bound to a single `(client, userId)` pair, written `<client>:<userId>:<token>`.

```
excubitor-ios:ze:Z9k...rand
excubitor-ios:pam:Q4p...rand
excubitor-watchos:ze:7vM...rand
```

The middleware extracts the userId from the matched key and asserts it equals the `:userId` segment of the request path. Mismatch → 403.

This avoids a "device on tailnet trusted" model degrading to "any key reads any user". Tailscale already constrains who can connect; bearer scoping constrains what each device can read.

**Unauthenticated**: `GET /api/health` only.

---

## 3. Request limits and conventions

| Property | Value | Rationale |
|---|---|---|
| Request body limit | 1 MiB | All bodies are small JSON; no bulk upload path |
| Per-request timeout | 10 s | Upstream intervals.icu can be slow; 10 s permits a single cache-miss round trip |
| Default `Content-Type` | `application/json; charset=utf-8` | All responses |
| Timestamps | RFC 3339 (`2026-04-23T18:20:00Z`) | No bulk time-series |
| Local dates | `YYYY-MM-DD` | Matches MCP date params and intervals.icu |
| Units | Metric, SI. Power in watts, distance in metres, duration in seconds, mass in kg, pace in seconds-per-100m for swim, seconds-per-km for run | Matches the codebase |
| `Accept-Language` | Ignored | API is English-only |
| Cache headers | `Cache-Control: private, max-age=300` on `/status` and `/workouts/suggested` | Reduce redundant calls while Excubitor polls |
| Timezone resolution | `tz` query param overrides; otherwise the athlete's intervals.icu profile TZ; otherwise UTC | Mirrors Praescriptor's resolver in `src/web/routes.ts` |

---

## 4. Error response shape

```json
{ "error": "upstream unavailable" }
```

Status codes:

| Code | Meaning |
|---|---|
| 200 | Success |
| 400 | Malformed request (bad date, unknown query param, missing required field) |
| 401 | Missing or invalid bearer token |
| 403 | Bearer is valid but bound to a different userId than the path |
| 404 | Resource not found (unknown userId, unknown workout id) |
| 409 | Prescription is awaiting input (cross-training RPE) — see `details.awaiting_input` |
| 502 | Upstream intervals.icu / Stryd error |
| 503 | Service unavailable (cold start, cache warming, user has no API key configured) |
| 504 | Upstream timeout |

When relevant, error responses include `details`:

```json
{
  "error": "awaiting cross-training RPE",
  "details": {
    "awaiting_input": {
      "reason": "cross_training_rpe",
      "activity_id": "iv-9876544",
      "activity_name": "Strength Session",
      "activity_type": "WeightTraining",
      "prompt": "How hard was that strength session? (1–10)"
    }
  }
}
```

---

## 5. Endpoints

All per-user endpoints live under `/api/users/:userId/...`. The userId set is the registry in `src/web/users.ts` (`ze`, `pam`).

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
  "version": "0.1.0",
  "users_configured": ["ze", "pam"]
}
```

### 5.2 Training status

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/users/:userId/status` | Current readiness, CP/FTP, fitness/fatigue/form, recent load, optional injury warning |

This is the payload Excubitor's **Now** (`Nunc`) tab shows alongside biometric hero numbers, and the header of the **Exercise** (`Exercitatio`) tab.

**Response**:
```json
{
  "generated_at": "2026-04-23T18:20:00Z",
  "user_id": "ze",
  "athlete_id": "i12345",
  "readiness": {
    "score": 86,
    "tier": "ready",
    "advisory": "green",
    "components": {
      "hrv": "ok",
      "sleep": "ok",
      "soreness": "ok",
      "fatigue": "ok"
    }
  },
  "injury_warning": {
    "severity": 0,
    "status": "inactive",
    "summary": null,
    "flags": []
  },
  "critical_power": {
    "watts": 312,
    "source": "stryd_direct",
    "updated_at": "2026-04-20T00:00:00Z",
    "confidence": "high"
  },
  "training_load": {
    "fitness_ctl": 72.4,
    "fatigue_atl": 54.1,
    "form_tsb": 18.3,
    "weekly_tss": 412,
    "trend_7d": "rising"
  },
  "last_workout": {
    "id": "iv-9876543",
    "started_at": "2026-04-22T06:15:00Z",
    "name": "Threshold 3×10'",
    "type": "Run",
    "duration_s": 3720,
    "tss": 68,
    "intensity_factor": 0.88
  }
}
```

Field semantics:

| Field | Type | Notes |
|---|---|---|
| `readiness.score` | int 0–100 \| null | Composite from `src/engine/readiness.ts`. `null` if insufficient wellness history |
| `readiness.tier` | enum: `ready`, `caution`, `recover`, `unknown` | Banded by score thresholds matching `workout-selector.ts` (long gate 60, HRV guard 30, etc.) |
| `readiness.advisory` | enum: `green`, `amber`, `red`, `grey` | Display colour hint |
| `readiness.components` | per-component status | Surfaces why the score is what it is. Each: `ok`, `low`, `unknown` |
| `injury_warning` | Vigil summary | From `src/engine/vigil/`. `severity: 0` and `status: inactive` when no alert |
| `injury_warning.severity` | int 0–3 | 0 = none, 1 = building, 2 = active (Niggle), 3 = active (Poor) |
| `injury_warning.flags[]` | metric deviations | `metric`, `z_score`, `weight`, `value_7d`, `value_30d` |
| `critical_power.source` | enum | See §6 |
| `critical_power.confidence` | enum: `high`, `medium`, `low` | `low` when CP is older than 90 days or fallback path |
| `training_load.trend_7d` | enum: `rising`, `flat`, `falling` | Rolling 7-day CTL slope |
| `last_workout.intensity_factor` | float 0–2 | Decimal IF, **not** percent. (intervals.icu's `icu_intensity` is percent — divided by 100 here) |

Nullable unless marked otherwise. Excubitor renders `null` as `—`.

### 5.3 Scheduled and completed workouts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/users/:userId/workouts/today` | Today's scheduled and completed workouts |
| `GET` | `/api/users/:userId/workouts/suggested` | Engine-generated prescriptions, optionally per sport |
| `GET` | `/api/users/:userId/workouts/:id` | Workout detail (steps, targets, structure) |

#### `GET /api/users/:userId/workouts/today`

**Query**:
- `tz` (optional) — IANA TZ identifier. Default: athlete profile TZ; otherwise UTC.

**Response** — see §5.2/v0.1 shape, unchanged except for the path prefix and that `target` is polymorphic (see §5.3.4 below).

#### `GET /api/users/:userId/workouts/suggested`

This wraps the existing DSW engine (`src/engine/suggest.ts`). v0.1's claim that "v0.1 just exposes scheduled workouts" was wrong — the engine is the suggestion source today.

**Query**:
- `sport` (optional) — `Run` \| `Swim` \| `auto` (default `auto`). When `auto`, the engine's sport selector decides. When explicit, the engine generates for that sport regardless of selector preference (used by Excubitor's per-tab views).
- `tz` (optional) — as above.

**Response**:
```json
{
  "generated_at": "2026-04-23T18:20:00Z",
  "user_id": "ze",
  "date": "2026-04-23",
  "tz": "Europe/London",
  "status": "ready",
  "suggestion": {
    "sport": "Run",
    "category": "tempo",
    "title": "Tempo 3×10' @ 285W",
    "rationale": "CTL rising, TSB 18.3, no recent staleness",
    "total_duration_s": 3720,
    "estimated_load": 68,
    "readiness_score": 86,
    "sport_selection_reason": "Run load deficit -42 vs Swim -18",
    "terrain": "rolling",
    "terrain_rationale": "Recent flat sessions; rolling welcomed",
    "power_context": {
      "source": "stryd_direct",
      "ftp": 312,
      "confidence": "high"
    },
    "warnings": [],
    "injury_warning": null,
    "segments": [
      {
        "name": "Warm-up",
        "duration_s": 600,
        "target": { "kind": "power", "low_w": 200, "high_w": 235 },
        "target_hr_zone": 1,
        "target_description": "Easy 200–235 W"
      },
      {
        "name": "Tempo",
        "duration_s": 600,
        "target": { "kind": "power", "low_w": 275, "high_w": 295 },
        "target_hr_zone": 3,
        "target_description": "Tempo 275–295 W",
        "repeats": 3,
        "work_duration_s": 600,
        "rest_duration_s": 120
      }
    ]
  }
}
```

When the engine is blocked on cross-training RPE (see `WorkoutSuggestion.status === "awaiting_input"` in `src/engine/types.ts`), the response is **HTTP 409** with the error envelope from §4. Clients submit RPE via §5.5 and re-poll.

#### `GET /api/users/:userId/workouts/:id`

Returns the full structured workout — steps, targets, source. Polymorphic targets per §5.3.4.

`id` may be:
- `iv-<intervals_id>` — fetched from intervals.icu
- `prescribed-<userId>-<date>-<sport>` — a synthetic id covering the day's engine suggestion (cached server-side). Stable for the calendar day in the user's timezone.

#### 5.3.4 Polymorphic target shape

Run uses power; swim uses pace + HR. Generic shape:

```json
{ "kind": "power", "low_w": 280, "high_w": 300 }
{ "kind": "pace", "stroke": "free", "low_s_per_100m": 105, "high_s_per_100m": 110 }
{ "kind": "hr",   "zone": 3, "low_bpm": 145, "high_bpm": 160 }
```

A segment may carry one primary `target` plus an optional `target_hr_zone` cap, mirroring the existing `WorkoutSegment` interface in `src/engine/types.ts`.

### 5.4 Compliance

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/users/:userId/compliance/summary` | Aggregated weekly + monthly compliance trends |
| `GET` | `/api/users/:userId/compliance/detail` | Per-prescription detail for a date range |

Wraps the existing MCP tools `get_compliance_summary` and `get_compliance_detail` (`src/tools/compliance.ts`). Same data, native-client-friendly shape (no human-prose summaries; just numbers).

**`GET /api/users/:userId/compliance/summary` query**:
- `weeks` (optional, 1–26, default 4) — how many weekly buckets
- `months` (optional, 1–12, default 3) — how many monthly buckets

**`GET /api/users/:userId/compliance/detail` query**:
- `from` (optional, `YYYY-MM-DD`, default today − 14)
- `to` (optional, `YYYY-MM-DD`, default today)

Response shape mirrors the MCP tool outputs verbatim (see `src/compliance/aggregate.ts` for fields).

### 5.5 Cross-training RPE submission

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/users/:userId/cross-training/:activityId/rpe` | Submit a session RPE to unblock prescription |

Calls into the existing `submit_cross_training_rpe` MCP tool logic.

**Body**:
```json
{ "rpe": 6 }
```

`rpe` is integer 1–10. Server stores it against the activity, recomputes strain, and on success the next `/workouts/suggested` call no longer returns 409.

**Response**: 200 with the updated strain classification:
```json
{
  "activity_id": "iv-9876544",
  "rpe": 6,
  "strain_tier": "moderate",
  "applied_to_today": true
}
```

### 5.6 Push to Stryd / push to intervals calendar

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/users/:userId/workouts/:id/push-to-stryd` | Queue a workout onto the Stryd watchface |
| `POST` | `/api/users/:userId/workouts/:id/push-to-intervals` | Queue onto intervals.icu calendar |

Both are **deferred** to v0.3 and return `501 Not Implemented`. The corresponding logic exists in `src/web/send-stryd.ts` and `src/web/send.ts` and can be lifted directly when needed; the deferral is to keep v0.2 read-leaning.

### 5.7 Wellness writes (opt-in)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/users/:userId/wellness/today` | Update today's wellness fields (subjective only) |

Body accepts a subset of intervals.icu wellness fields: `soreness`, `fatigue`, `stress`, `motivation`, `mood`, `sleep_quality`, `notes`. HRV/sleep/RHR remain Promus's domain and are rejected if posted here. Disabled when `EXERCITATOR_ALLOW_WELLNESS_WRITE != "true"`. **Default: disabled in v0.2.**

### 5.8 Dashboard (convenience)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/users/:userId/dashboard` | `/status` + `/workouts/today` + `/workouts/suggested` in one call |

Provided so Excubitor's Exercise tab can do one request instead of three. Response keys: `status`, `today`, `suggested`. If `suggested` would be 409, the field is `null` and a top-level `awaiting_input` block is set instead.

---

## 6. Power source / FTP resolution

The `critical_power.source` enum is enriched to expose the ecosystem distinction the engine already makes:

| Value | When |
|---|---|
| `stryd_direct` | `STRYD_*` env vars set; CP fetched from Stryd `/cp/history`. **Authoritative.** |
| `stryd_intervals` | Stryd CIQ or native Stryd activity recently uploaded to intervals.icu; FTP from `icu_rolling_ftp` |
| `intervals_inferred` | Garmin native or no Stryd; FTP from intervals.icu's running power model |
| `none` | No power data — running prescriptions emit HR-only targets and `confidence: "low"` |

**Resolution order** (matches `src/engine/power-source.ts`):
1. `stryd_direct` (Stryd creds present, athlete uses Stryd)
2. `stryd_intervals` (most recent activity has Stryd power field)
3. `intervals_inferred` (`icu_rolling_ftp` from athlete settings)
4. `none`

(v0.1's "intervals.icu first, Stryd as stretch goal" was inverted.)

---

## 7. Configuration

All secrets follow the `{VAR}` / `{VAR}_FILE` convention (Docker secrets):

| Variable | `_FILE` form | Required | Notes |
|---|---|---|---|
| `EXERCITATOR_API_BIND_ADDR` | — | no | Default `0.0.0.0:8643`. Must not collide with MCP (`8642`) or Praescriptor (`3847`) |
| `EXERCITATOR_API_KEYS` | `EXERCITATOR_API_KEYS_FILE` | yes | Comma-separated `<client>:<userId>:<token>` triples |
| `INTERVALS_ICU_API_KEY` | — | yes (for `ze`) | Existing var — reused |
| `INTERVALS_ICU_API_KEY_PAM` | — | no | Existing var — reused |
| `STRYD_EMAIL` / `STRYD_PASSWORD` | — | no | Existing — reused |
| `STRYD_EMAIL_PAM` / `STRYD_PASSWORD_PAM` | — | no | Existing — reused |
| `EXERCITATOR_API_CACHE_TTL_S` | — | no | Per-user response cache TTL, default 300 |
| `EXERCITATOR_API_VIGIL_MIN_HISTORY_DAYS` | — | no | Below this, `injury_warning.status = unknown`, default 7 |
| `EXERCITATOR_ALLOW_WELLNESS_WRITE` | — | no | `true` to enable §5.7. Default `false` |
| `LOG_LEVEL` | — | no | `error` \| `warn` \| `info` \| `debug` |

(No `RUST_LOG`; this is Node.)

---

## 8. Tailscale exposure

A new sidecar mirroring the Praescriptor pattern. Tailnet-only — no funnel.

```
tailscale-exercitator-api  (tailscale/tailscale:latest, userspace mode)
  hostname:    exercitator-api
  serve:       :443 HTTPS → http://exercitator:8643
  state volume: exercitator-api-tailscale-state (external)
```

Per the existing memory rule, the sidecar hostname (`exercitator-api`) must not match any Docker container_name. The new container_name is `exercitator-api-ts` (different from hostname).

Existing volumes are unchanged. The new external volume is created out-of-band (`docker volume create exercitator-api-tailscale-state`) before first deploy, like the others.

Auth key minted reusable, preauthorised, ephemeral=false; supplied via host `.env`.

---

## 9. Polling cadence (client guidance for Excubitor)

| Endpoint | Cadence | Trigger |
|---|---|---|
| `/api/users/:userId/status` | On app foreground; on Exercise tab entry; every 15 min while app is foreground | User-facing |
| `/api/users/:userId/workouts/today` | Once per foreground; again after any completed workout event in Promus | User-facing |
| `/api/users/:userId/workouts/suggested` | Once per foreground; cached 10 min client-side | User-facing |
| `/api/users/:userId/dashboard` | Preferred over the three above when the Exercise tab is the entry point | User-facing |
| `/api/users/:userId/compliance/summary` | On Exercise tab "history" sub-view; cached 30 min client-side | User-facing |
| `/api/health` | Diagnostic only | — |

Background fetch must not poll. If a foreground refresh returns 503 or times out, display the last cached payload with a "stale since HH:MM" label.

---

## 10. Versioning

No versioned URL prefix in v0.1/v0.2. When a breaking change is needed, introduce `/api/v2/...` with the existing `/api/...` remaining live for at least one client release cycle.

---

## 11. Testing

Per project convention (see `/test`): Vitest + lint + typecheck. Each route gets a unit test with mocked `IntervalsClient` and `StrydClient`. Integration smoke test runs against a `:memory:` SQLite (`EXERCITATOR_DB_PATH=:memory:`) with fixture wellness/activity data. Bearer-scope assertions tested explicitly (key-for-`ze` cannot read `pam`).

---

## 12. Open questions

1. **Pam's data privacy**: cross-tenant access is blocked by bearer scoping (§2). Does Excubitor ever need a single key with both users' data (e.g. partner view)? If so, introduce a `multi-user:<token>` key class. **Default for v0.2: no.**
2. **Stryd CP test detection**: whether to auto-recompute CP when an intervals.icu activity looks like a CP test, or only when the user manually updates. **Default: read what intervals.icu / Stryd say, no auto-compute.**
3. **Excubitor sport tabs**: does the iOS client want one combined `auto` suggestion or per-sport tabs? The `?sport=` param supports both — clients pick.

---

## 13. v0.2 changes from v0.1

- **Multi-user routing**: all per-user endpoints moved under `/api/users/:userId/...`. Single-`athlete_id` config removed.
- **Vigil naming**: `vigil.*` renamed to `readiness.*` (the engine's readiness score). The actual Vigil (biomechanical injury warnings) is a separate `injury_warning` block. v0.1 conflated the two.
- **CP source order**: `stryd_direct` is the authoritative source when credentials are set, not a stretch goal. The fallback chain reflects `src/engine/power-source.ts`.
- **Suggestion engine**: `/workouts/suggested` exposes the existing DSW engine (`src/engine/suggest.ts`) directly, not a v0.2 add.
- **Polymorphic targets**: segments carry `{ kind: "power" | "pace" | "hr", ... }` so swim is a first-class output.
- **Cross-training RPE submission** (`POST /cross-training/:activityId/rpe`): unblocks prescriptions that return 409 on `awaiting_input`.
- **Compliance endpoints**: new `/compliance/summary` and `/compliance/detail`, wrapping existing MCP tools.
- **Architectural boundary**: corrected — Exercitator does write to intervals.icu (wellness, calendar). The HTTP API stays read-leaning; writes are opt-in or deferred.
- **Runtime / port**: explicit Node + TS, port 8643 (no collision with 8642 / 3847). No `RUST_LOG`.
- **Tailscale state volume**: hyphenated (`exercitator-api-tailscale-state`), matching existing naming.
- **Auth model**: bearer keys are scoped `<client>:<userId>:<token>`; middleware asserts userId match.
- **Bearer scope test** + **userId mismatch (403)** added to error matrix.
