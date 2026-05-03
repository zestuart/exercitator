# Exercitator HTTP API — v0.3 Delta

**Parent spec**: `phase2/exercitator-http-api-spec.md` (v0.2)
**Status**: shipped 2026-05-03 (Cogitator deploy, both endpoints live on `exercitator-api.tail7ab379.ts.net`). Pending merge into the parent spec.
**Drafted**: 2026-05-03 against `claude-opus-4-7[1m]`
**Driver**: Nunc (Excubitor iOS) needs the same two buttons Praescriptor already ships — *Push today's run to Stryd*, and *Copy today's swim as FORM-goggles text*. Both functions exist in the codebase; v0.3 extends them onto the bearer-scoped HTTP API surface so the iPhone client can call them directly.

This delta lists the changes from v0.2. It is meant to be merged into the parent spec; until then, treat the parent spec as authoritative for everything not redefined here.

---

## 1. Summary of changes

| § | Change | Direction |
|---|---|---|
| 5.6 | Un-defer `POST /api/users/:userId/push-to-stryd`. Wraps existing `sendToStryd` (`src/web/send-stryd.ts`). | 501 → 200 / 400 / 409 / 503 |
| 5.6a | Defer `push-to-intervals` to v0.4. Underlying function (`sendToIntervals`) already exists; deferred only because Nunc has no UI for it yet. | No change |
| 5.8 | New: `GET /api/users/:userId/form-text` → `text/plain` produced by existing `buildFormDescription` (`src/web/form-format.ts`). Swim only. | Additive |

No path-level breaking changes. Existing v0.2 clients continue to work unchanged.

---

## 2. Detailed changes

### 2.1 §5.6 — `POST /api/users/:userId/push-to-stryd`

#### 2.1.1 Behaviour

Bearer-scoped wrapper around `sendToStryd` (`src/web/send-stryd.ts`) — the same function Praescriptor's "Push to Stryd" button has been calling. The HTTP API path differs only in auth (bearer instead of tailnet-implicit) and in URL prefix (`/api/users/:userId/...`).

Stryd workouts are run-only, so there is no `sport` parameter — the endpoint always pushes today's running prescription. If the engine selected Swim today, the user has no run sport, or the user has no Stryd creds configured, the endpoint returns a 4xx (see §2.1.4).

The endpoint regenerates today's prescription server-side via `generatePrescriptions(...)` — the same call Praescriptor's button uses. The client does not need to send a workout id; "today's run for this user" is the implicit selector.

#### 2.1.2 Request

```http
POST /api/users/:userId/push-to-stryd?force=true&tz=Europe/London
Authorization: Bearer <client>:<userId>:<token>
```

Query parameters:

- `force` (optional, default `false`) — bust per-day dedup. Use after a 409 when the user explicitly confirms "send again".
- `tz` (optional) — IANA timezone. Resolves via the standard chain (query → athlete profile → UTC), per v0.2 §3.

Body: empty.

#### 2.1.3 Response

**200 OK** — pushed. Same shape as Praescriptor's existing endpoint, lifted verbatim:

```json
{
  "success": true,
  "workout_id": "abc123",
  "calendar_id": "cal456",
  "stress": 68,
  "duration_mins": 62,
  "distance_m": 12000
}
```

`workout_id` is Stryd's id for the queued workout; `calendar_id` is Stryd's calendar-entry id. Excubitor does not need to retain either — they exist for parity with Praescriptor and for human debugging.

**409 Conflict** — already pushed today (per-day dedup, see §2.1.5):

```json
{
  "success": false,
  "duplicate": true,
  "workout_id": "abc123",
  "calendar_id": "cal456",
  "message": "Already sent to Stryd today — send again?"
}
```

#### 2.1.4 Status codes

| Code | Meaning |
|---|---|
| `200` | Pushed. Body as above. |
| `400` | User has no `Run` sport configured, **or** no run prescription was generated for today (e.g. engine selected Swim), **or** user has no Stryd creds configured. Body carries an `error` string explaining which. |
| `401` | Bearer missing / malformed. |
| `403` | Bearer userId mismatch with path userId. |
| `409` | Already pushed today. Body returns the original push's metadata; `success: false`, `duplicate: true`. Retry with `?force=true` to override. |
| `502` | Upstream Stryd error (login failure, create/schedule failed). |

`501` is removed from this endpoint.

> **Note on 400 vs 503**: v0.2 §4 reserves `503` for "service unavailable / cache warming / no API key configured". Praescriptor's existing handler returns `400` for "Stryd not configured for this user" (`src/web/routes.ts:314`). v0.3 keeps that — the API matches Praescriptor's behaviour. If we ever want to distinguish "Stryd permanently absent" from "no run today", we add a discriminator field to the body rather than splitting the status code.

#### 2.1.5 Dedup model

Identical to Praescriptor's existing button: per `(userId, date, sport='Run', target='stryd')`, persisted to the `send_events` table (`src/db.ts:160`) via `persistSendEvent` / `getSendEvent` (`src/compliance/persist.ts`). Once-per-calendar-day, with `?force=true` as the explicit override. No client-supplied idempotency keys, no time bucket.

This matters for symmetry: a user who taps "Push to Stryd" on Praescriptor and then taps the same button in Nunc will see 409 from the second surface, with a clean retry path via `force=true`. Both surfaces share state — they cannot diverge.

When `force=true` is supplied and a previous push exists, `sendToStryd` deletes the prior Stryd calendar entry before creating the new one (best-effort; failure to delete does not block the new push). This is existing behaviour, documented here so Nunc knows what `force` actually does.

---

### 2.2 §5.7 — `POST /api/users/:userId/push-to-intervals`

Unchanged. Continues to return `501 Not Implemented`. The underlying function (`sendToIntervals` in `src/web/send.ts`) already exists and is wired into Praescriptor at `POST /:userId/api/send/{run,swim}`. Exposing it via the API is the same pattern as §2.1; deferred to v0.4 only because Nunc has no calendar-push UI today.

---

### 2.3 §5.8 — `GET /api/users/:userId/form-text` (new)

#### 2.3.1 Purpose

Returns today's swim prescription as FORM-goggles Script plain text, ready for `UIPasteboard.general.setValue(_, forPasteboardType: .plainText)`. Mirrors Praescriptor's "Copy FORM Text" button (which currently composes the same text in JS from data already inlined in the page).

#### 2.3.2 Request

```http
GET /api/users/:userId/form-text?tz=Europe/London
Authorization: Bearer <client>:<userId>:<token>
Accept: text/plain
```

Query parameters:

- `tz` (optional) — as in §2.1.2.

Sport is implicit: FORM goggles are swim-only, so the endpoint always returns swim text. If the engine selected Run today, returns 404 (see §2.3.4).

#### 2.3.3 Response

```http
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8

Warm-Up
4 x 100 FR Easy 10 sec rest
4 x 100 K Easy 10 sec rest

Main
8 x 100 FR Strong 20 sec rest

Warm-Down
200 FR Easy
```

`LF`-delimited plain text. No JSON envelope — keeps the client's clipboard write a one-liner.

#### 2.3.4 Status codes

| Code | Meaning |
|---|---|
| `200` | Body is the FORM script. |
| `400` | User has no `Swim` sport configured. |
| `401` / `403` | Per v0.2 §4. |
| `404` | No swim suggestion for today (engine selected Run, or no prescription generated). |
| `502` | Upstream intervals.icu / engine error. |

#### 2.3.5 Implementation note

The handler runs `generatePrescriptions(...)` (same call as Praescriptor and as §2.1's push-to-stryd) and pipes the swim suggestion through `buildFormDescription` from `src/web/form-format.ts`. Single source of truth for the FORM format — Praescriptor's button and Nunc's button render the same text from the same code path.

> **DECISION**: server-side endpoint rather than porting `form-format.ts` to Swift. Rationale: format authority. If the FORM parser tightens or the abbreviation table changes (`FR`, `K`, `BR`, `IM`, `Easy`/`Mod`/`Strong`/…), both surfaces update from one server deploy. Cost: one HTTP round-trip on copy. Acceptable — copy is a deliberate user gesture, not a hot path.

---

## 3. Out of scope (explicit)

- **Cancel a queued Stryd push** — no `DELETE /push-to-stryd`. The next push with `?force=true` replaces (existing `sendToStryd` deletes the prior calendar entry before creating the new one).
- **Run FORM equivalent** — there is no FORM-goggles for running; the swim-only restriction on `/form-text` is intentional.
- **Multi-sport bundle push** — `POST /push-to-stryd` always pushes today's run. Brick days hit it once for run; the swim half goes via `/form-text` (Stryd doesn't run swim workouts).
- **Push-to-intervals exposure** — function exists; deferred to v0.4.
- **`stryd_pushable` flag on the suggestion DTO** — not added. Excubitor enables the button when `suggestion.sport === "Run"`; the endpoint's 400/502 responses surface configuration and runtime errors. A pre-flight flag would only mirror state the client already has, and would need to be recomputed on every suggestion fetch.
- **`source` discriminator on the response** — there is only one push path (`StrydClient.createWorkout` + `scheduleWorkout`). intervals.icu's Stryd integration is read-only and cannot be used to push planned workouts back out to the foot pod, so a multi-source enum has nothing to discriminate.

---

## 4. Migration / rollout

- Single deploy; no flag.
- v0.2 clients (currently shipping Excubitor v0.2) are unaffected — they ignore the new endpoints.
- v1.1 Excubitor (the Nunc UI feature work that triggered this delta) calls both new endpoints.
- The `501 → 200/400/409/502` transition on `push-to-stryd` is additive in client-impact terms — no v0.2 client expected 501 to be permanent (the v0.2 spec called it "deferred").

---

## 5. Excubitor client guidance (informative, not normative)

Calling out the obvious so Nunc UX matches Praescriptor:

- **Push-to-Stryd button**
  - Show only when `dashboard.suggested.suggestion.sport === "Run"` (or equivalent `/workouts/suggested?sport=Run` returns 200).
  - On `200` → toast "Pushed to Stryd watchface".
  - On `409` → confirmation sheet "Already sent to Stryd today — push again?"; on confirm, retry with `?force=true`.
  - On `400` with `error` matching `/Stryd not configured/` → disable in Settings (this is a permanent per-account state).
  - On `400` with `error` matching `/no run prescription/` → disable for the day.
  - On `502` / network failure → "Stryd unreachable — try again".
- **Copy FORM Text button**
  - Show only when `dashboard.suggested.suggestion.sport === "Swim"` (or `/form-text` returns 200 — the client may probe).
  - GET, copy body to `UIPasteboard.general`, brief toast.
  - On `404` → hide; engine picked the other sport.

---

## 6. Test additions

- Bearer scoping on `push-to-stryd` (cross-user → 403). Same harness as v0.2 §5.4.
- Per-day dedup contract — push twice on the same calendar day → second returns 409 with `duplicate: true`; push with `?force=true` → 200 and the prior calendar entry is removed.
- 400 fixtures: (a) user without Stryd creds; (b) user with Stryd but engine selected Swim today; (c) user with no Run sport configured.
- 404 fixture for `form-text`: engine selected Run today.
- `form-text` `Content-Type: text/plain; charset=utf-8`.
- Both endpoints respect `tz` resolution (cookie / profile / UTC chain matches `/workouts/suggested`).

---

## 7. Changelog

### 2026-05-03 — v0.3 delta drafted

- Un-defer `push-to-stryd` from v0.2 §5.6; endpoint wraps existing `sendToStryd`.
- Add `GET /form-text` (swim-only); endpoint wraps existing `buildFormDescription`.
- Defer `push-to-intervals` to v0.4 (function exists; not yet exposed).
- Drop the proposed `stryd_pushable` flag, `Idempotency-Key` header, 60 s dedup window, `source` enum, `:id` path parameter, and `intervals.icu` source fallback — none required for parity with Praescriptor's existing buttons.
