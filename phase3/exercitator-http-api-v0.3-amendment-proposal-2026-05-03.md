# Exercitator HTTP API v0.3 — Amendment Proposal (calendar_id type drift)

**Status**: draft proposal — awaiting Exercitator team confirmation against `src/web/send-stryd.ts` source.
**Drafted**: 2026-05-03 by Zë / Claude on the Excubitor side.
**Parent**: `phase3/exercitator-http-api-v0.3-delta.md`.
**Scope**: response schema for `POST /api/users/:userId/push-to-stryd` (v0.3 §2.1.3) only. No path / status-code changes.

---

## 1. Background

Excubitor M11 shipped against the v0.3 spec on 2026-05-03 and reached hardware sign-off (M11.6). The first live Push-to-Stryd tap on Handkomputer surfaced the following diagnostic via the M11.6.1 error-surfacing hotfix:

```
pushToStryd unexpected: DecodingError.typeMismatch
  expected value of type String
  Path: calendar_id
  Debug description: Expected to decode String but found number instead.
```

The server returned `calendar_id` as a JSON number; the Excubitor client decoded it as `String?` per v0.3 §2.1.3 example, which shows `"calendar_id": "cal456"`.

End-to-end behaviour: Stryd watch app **did receive the workout** (server-side push pipeline succeeded). The iPhone showed a generic error toast because the response body could not be decoded. The dedup row was still written (verified indirectly: the second tap hit the same code path on the server, but iOS couldn't read the 409 body either, so neither tap surfaced the confirmation sheet).

The drift is cosmetic in observable behaviour but blocking for any client that strictly types the response.

---

## 2. Proposed correction

### 2.1 §2.1.3 — Response example

Change the JSON example at v0.3 §2.1.3 from:

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

to (proposed; **subject to source verification**, see §3):

```json
{
  "success": true,
  "workout_id": "abc123",
  "calendar_id": 12345,
  "stress": 68,
  "duration_mins": 62,
  "distance_m": 12000
}
```

`calendar_id` becomes a JSON number (integer). `workout_id` stays as a string per the existing example, **pending confirmation that Stryd's actual response uses a string for this field** (see §3).

Apply the same correction to the §2.1.3 409-conflict body example:

```json
{
  "success": false,
  "duplicate": true,
  "workout_id": "abc123",
  "calendar_id": 12345,
  "message": "Already sent to Stryd today — send again?"
}
```

### 2.2 §2.1.3 — Field type table (new)

The current §2.1.3 shows only the example, not a typed table. Recommend adding one for unambiguity:

| Field | JSON type | Notes |
|---|---|---|
| `success` | bool | `true` on 200; `false` on 409. |
| `workout_id` | string \| null | Stryd's workout id. Present on 200 and 409. **[verify against `StrydClient.createWorkout` return]** |
| `calendar_id` | number \| null | Stryd's calendar-entry id. Numeric integer per Stryd's API surface. **[corrected from `string` in original spec]** |
| `stress` | number \| null | TSS for the prescribed workout. Integer in observed responses; document as `number` to allow float futures. |
| `duration_mins` | number \| null | Integer. |
| `distance_m` | number \| null | Integer. |
| `duplicate` | bool \| null | Present only on 409 conflict bodies. |
| `message` | string \| null | Present only on 409 conflict bodies. |

> Excubitor does not retain `workout_id` or `calendar_id` (per v0.3 §2.1.3 — "for parity with Praescriptor and for human debugging"); the type is load-bearing only because the decoder must parse the field successfully even when ignored.

---

## 3. Verification questions for the Exercitator team

Please confirm against `src/web/send-stryd.ts` (and Praescriptor's existing browser-side decoder of the same response, if it has explicit typing):

1. **`workout_id`** — string or number in `StrydClient.createWorkout`'s actual return? The browser button has been parsing this in JS, which is loose-typed; the iOS error didn't reach this field, so we have no negative evidence either way. Worth pinning.
2. **`calendar_id`** — confirmed numeric by the iOS error. Is this an integer in all observed cases, or does Stryd ever return a string-encoded numeric ID (some APIs do this for IDs that exceed `Number.MAX_SAFE_INTEGER`)?
3. **`stress`** — integer or float? Stryd's TSS computation may yield decimals; the spec example shows `68` (integer). If float is possible, the spec table should say `number` not `integer`.
4. **`duration_mins` / `distance_m`** — same float-vs-integer question. Distance especially might be metres-to-the-fraction in Stryd's data model.
5. **409 body fields** — same shape as 200 plus `duplicate` / `message`? Or any deltas?

If any field above turns out to differ in type from this proposal, the spec table in §2.2 wants amending before iOS implements its decoder fix.

---

## 4. Action plan

If the team confirms §2 / §3 substantively as drafted:

1. **Exercitator side** — apply the §2.1 / §2.2 corrections to `phase3/exercitator-http-api-v0.3-delta.md`. Single docs commit, no code change. The server-side response is already what this amendment describes — only the spec was wrong.
2. **Excubitor side** — ship M11.6.2 (small follow-up to M11.5):
   - Change `ExercitatorStrydPushResponse.calendar_id: String?` → `Int?`.
   - Audit `workout_id`, `stress`, `duration_mins`, `distance_m` against the corrected spec; widen types where needed (likely `stress: Double?` if the spec confirms float-possible).
   - Re-test on Handkomputer.

If the team disagrees and prefers to **reshape the server response to match the original spec** (i.e. coerce `calendar_id` to a string before sending), that's a server-side change in `src/web/send-stryd.ts`'s response builder. The iOS side then needs no change. Either is acceptable from Excubitor's perspective — the spec being a single source of truth is what matters.

---

## 5. Out of scope

- **Behaviour changes.** Status codes, dedup model (per-day, `?force=true` override), bearer scoping — all unchanged.
- **`workout_id` / `calendar_id` retention on Excubitor.** Excubitor still does not retain either; only the parsing constraint matters.
- **Other v0.3 endpoints.** `/form-text` returns `text/plain` and is unaffected.
- **Praescriptor browser button.** It currently parses JS-loose-typed; this amendment doesn't require changes there, but a future TypeScript tightening pass should consume the same v0.3 spec.

---

## 6. Changelog

### 2026-05-03 — Amendment proposal drafted

- Bug discovered during Excubitor M11.6 hardware sign-off: `calendar_id` is numeric, spec example said string.
- Propose response-shape correction in §2.1.3 plus a typed-table addition for unambiguity.
- Open verification questions for `workout_id`, `stress`, `duration_mins`, `distance_m`, and the 409 body shape (§3).

---

## 7. Exercitator team response — 2026-05-03

Source-of-truth review against `src/web/send-stryd.ts`, `src/stryd/client.ts`, `src/api/handlers/push-to-stryd.ts`, and Praescriptor's browser button (`src/web/render.ts:1248-1304`). Each Q from §3 confirmed below, plus a server-side type-drift bug the proposal didn't surface.

### 7.1 Answers to §3 verification questions

1. **`workout_id` — number, not string.** `StrydClient.createWorkout(): Promise<number>` (`src/stryd/client.ts:236`); the 200 path forwards the value as-is. The original v0.3 spec example showed `"abc123"` — that example was wrong on this field too, not just on `calendar_id`. Spec corrected in §2.1.3 to `12345` (numeric).
2. **`calendar_id` — number (integer).** Confirmed against `StrydCalendarEntry.id: number` (`src/stryd/client.ts:69`). The iOS error was diagnostically correct — server emits a JSON number; the spec example was the drift.
3. **`stress` — `number`, not guaranteed integer.** Stryd's TSS computation yields decimals in some cases. Document as `number | null`, not `integer`. Treat the spec's previous integer example (`68`) as illustrative only.
4. **`duration_mins` / `distance_m` — guaranteed integers.** `Math.round` applied at the boundary in `src/web/send-stryd.ts` before the response is built, so the wire type is always integer for both fields.
5. **409 body — same shape as 200 plus `duplicate` / `message`.** Modulo the type-drift bug in §7.2.

### 7.2 200/409 type-drift bug Excubitor's proposal didn't catch

The 200 and 409 paths construct the response from different sources:

- **200 path** — direct values returned from `StrydClient.createWorkout` (`src/web/send-stryd.ts:77`-ish, depending on the variant) and `scheduleWorkout`. `workout_id` is a JS `number`, `calendar_id` is a JS `number`. JSON-serialised → JSON numbers.
- **409 path** — values rebuilt from the SQLite `send_events` row. The storage write coerces the workout id with `String(workoutId)` at `src/web/send-stryd.ts:77` to fit the generic TEXT `external_id` column. The response read-back at `src/web/send-stryd.ts:38` then surfaces `existing.externalId` unchanged → JSON string. `calendar_id` happens to round-trip through `JSON.parse` of a stored payload and stays numeric, so only `workout_id` drifted.

Net effect: 200 emits `workout_id: number`, 409 emits `workout_id: string`. Excubitor's M11.6.1 surfaced only the `calendar_id` mismatch because that's the field the iOS decoder hit first; the planned M11.6.2 (`calendar_id: Int?`) would have decoded the 200 happy path successfully and then thrown the same `typeMismatch` on the very next 409, this time on `workout_id`. The proposal would have shipped a second hotfix two days later.

### 7.3 Resolution

Two-part fix, server-side:

1. **Coerce on read-back at the response boundary.** `src/web/send-stryd.ts:38` becomes `workout_id: existing.externalId ? Number(existing.externalId) : null`. Storage layer keeps its TEXT column; only the response edge converts.
2. **Spec §2.1.3 corrected** as proposed in §2 of this amendment, with the typed field table written against truth-of-source rather than the original spec example. Both `workout_id` and `calendar_id` are numeric on both 200 and 409.

A regression test on the 200/409 contract is added in the same change so future re-stringification fails loudly.

**Why this over the proposal's §4 alternative ("coerce server response to string")**:

- **Stryd wire types are numeric.** The upstream API returns `number` for both fields, so the natural data-flow direction is numeric end-to-end. Stringifying at the response boundary would invent a representation that has to be undone again the moment any downstream wants to compare ids or order events.
- **Single source of truth.** The 200 path already emits numbers. Aligning 409 to 200 changes one line (`Number(...)`); aligning 200 to 409 would mean stringifying an authoritative numeric value at the edge plus updating the spec to the synthetic shape — strictly more code and strictly more drift surface.
- **No Praescriptor breakage.** Verified by reading `src/web/render.ts:1248-1304`: the browser button only inspects `success`, `duplicate`, `message`, and `error`. It never touches `workout_id` or `calendar_id`, so changing the 409 path's type for those two fields is invisible to Praescriptor.

### 7.4 Action confirmed for Excubitor (M11.6.2)

- Type both `workout_id` and `calendar_id` as `Int?` in `ExercitatorStrydPushResponse`. `Int64?` if you want headroom against future Stryd id growth — Swift's `JSONDecoder` widens silently from `Int` to `Int64` on the same wire format, so this is purely a forward-compat hedge.
- `stress` should be `Double?`, not `Int?`. The spec previously implied integer; truth-of-source is `number` (potentially fractional).
- `duration_mins` and `distance_m` may stay `Int?` — server guarantees rounded.
- Both 200 and 409 bodies are safe to decode through the same struct from v0.3 onwards.
