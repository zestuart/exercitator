# Memo: `push-to-stryd` v0.3 amendment — resolution

**To**: Excubitor team
**From**: Exercitator team
**Date**: 2026-05-03
**Re**: `phase3/exercitator-http-api-v0.3-amendment-proposal-2026-05-03.md`
**Status**: deployed — commit `bf1393b` live on `exercitator-api.tail7ab379.ts.net`

---

## TL;DR

- Server fix shipped. Both 200 and 409 responses for `POST /api/users/:userId/push-to-stryd` now emit `workout_id` and `calendar_id` as JSON numbers. Spec §2.1.3 corrected with a typed field table.
- The `calendar_id` drift Excubitor M11.6.1 surfaced was the visible half of a deeper bug: the 200 path emitted `workout_id` as a number, the 409 path emitted it as a string. M11.6.2 with `Int?` for `calendar_id` only would have decoded 200 cleanly and re-thrown the same `typeMismatch` on the 409 retry path — at `workout_id` instead. Same class of bug, new field.
- Type both ids as `Int?` (or `Int64?` for headroom). Type `stress` as `Double?`, not `Int?`. `duration_mins` and `distance_m` may stay `Int?` — server guarantees rounded.

---

## 1. What changed server-side

- `src/web/send-stryd.ts:38` (the 409 path) coerces `workout_id` from the SQLite-stored string back to a number on the response boundary: `existing.externalId ? Number(existing.externalId) : null`. The storage column stays TEXT — `external_id` is generic across compliance targets (`stryd`, `intervals`, future). The coercion is at the wire edge only.
- `calendar_id` was already consistent on both paths (`meta.calendarId` round-trips through `JSON.parse(externalMeta)` as a number) — no change required.
- Praescriptor browser button (`src/web/render.ts:1248-1304`) confirmed unaffected: it reads only `success`, `duplicate`, `message`, and `error`. No browser change shipped.

## 2. Verification answers — your §3 questions

| Q | Field | Truth | Source |
|---|---|---|---|
| 1 | `workout_id` | **number, integer** | `StrydClient.createWorkout(): Promise<number>` — `src/stryd/client.ts:236-251` |
| 2 | `calendar_id` | **number, integer** | `StrydCalendarEntry.id: number` — `src/stryd/client.ts:69` |
| 3 | `stress` | **number, may be fractional** — server forwards Stryd's value unchanged, no `Math.round`. Decode as `Double`, not `Int`. | `src/web/send-stryd.ts:89` |
| 4 | `duration_mins` / `distance_m` | **number, integer guaranteed** — server applies `Math.round` on both | `src/web/send-stryd.ts:90-91` |
| 5 | 409 body | Same shape as 200 plus `duplicate: true` and `message: string`. Now type-consistent with 200 from `bf1393b` onwards. | `src/web/send-stryd.ts:35-42` |

## 3. Type contract (canonical, post-`bf1393b`)

| Field | JSON type | 200 | 409 | Notes |
|---|---|:-:|:-:|---|
| `success` | bool | `true` | `false` | |
| `workout_id` | number \| null | ✓ | ✓ | integer |
| `calendar_id` | number \| null | ✓ | ✓ | integer |
| `stress` | number \| null | ✓ | ✓ | **may be fractional** |
| `duration_mins` | number \| null | ✓ | — | integer (server rounds) |
| `distance_m` | number \| null | ✓ | — | integer (server rounds) |
| `duplicate` | bool \| null | — | `true` | |
| `message` | string \| null | — | ✓ | |
| `error` | string \| null | — | — | present only on 4xx/5xx error bodies |

The full typed table also lives in the spec at `phase3/exercitator-http-api-v0.3-delta.md` §2.1.3.

## 4. The deeper bug your proposal didn't catch

The visible failure was decoder typeMismatch on `calendar_id` in the 200 response. Investigation showed:

- 200 path: `workout_id: workoutId` — direct from `StrydClient.createWorkout` (number).
- Storage write: `persistSendEvent(..., String(workoutId), ...)` — coerced to string for the generic TEXT `external_id` column (`src/web/send-stryd.ts:77`).
- 409 path read-back: `workout_id: existing.externalId` — emitted the stringified value with no reverse coercion (`:38`).

Why M11.6.1 surfaced `calendar_id` first rather than `workout_id`: Swift's `JSONDecoder` walks the target struct's `Codable` keys in declaration order, not JSON wire order. `ExercitatorStrydPushResponse` evidently lists `calendar_id` before `workout_id`, so the decoder threw on `calendar_id` and never tried `workout_id`. Both fields were broken on the 200 path; the proposal's M11.6.2 plan (`calendar_id: Int?`) would have decoded 200 cleanly and then surfaced the identical typeMismatch on `workout_id` the moment a 409 round-trip ran through the same decoder.

The 409 path was doubly broken: `workout_id` was string in production (storage round-trip) where it should have been number. That's now fixed at the response boundary.

## 5. M11.6.2 — recommended types

```swift
struct ExercitatorStrydPushResponse: Codable {
    let success: Bool
    let workoutId: Int?       // Int64? if you want big-int headroom
    let calendarId: Int?      // Int64? for parity
    let stress: Double?       // NOT Int — Stryd may yield fractional TSS
    let durationMins: Int?    // server-rounded
    let distanceM: Int?       // server-rounded
    let duplicate: Bool?      // 409 only
    let message: String?      // 409 only
    let error: String?        // 4xx/5xx error bodies

    enum CodingKeys: String, CodingKey {
        case success, stress, duplicate, message, error
        case workoutId = "workout_id"
        case calendarId = "calendar_id"
        case durationMins = "duration_mins"
        case distanceM = "distance_m"
    }
}
```

The same struct decodes both 200 and 409 from `bf1393b` onwards. No status-code-specific decoder needed.

## 6. Live verification you can run

```bash
# Health (no auth):
curl -s https://exercitator-api.tail7ab379.ts.net/api/health
# → 200

# Wire shape sanity (replace <bearer> with your Excubitor key):
curl -s -X POST \
  -H "Authorization: Bearer <bearer>" \
  https://exercitator-api.tail7ab379.ts.net/api/users/ze/push-to-stryd | jq .
```

Tap Push-to-Stryd in Nunc twice on the same calendar day:
- First tap: 200 with both ids numeric.
- Second tap: 409 with both ids numeric, `duplicate: true`, `message` populated.
- Third tap with `?force=true`: 200 again; the server deletes the prior calendar entry on Stryd before scheduling the new one.

If your decoder still throws on either path against the live server, the bug is on the iOS side — the wire is now type-consistent.

## 7. Server changes (audit trail)

- Commit: `bf1393b` — `fix(api): push-to-stryd 409 emits workout_id as number, matching 200`
- Files touched: `src/web/send-stryd.ts` (1 line + comment), `tests/web/send-stryd.test.ts` (new — pins type contract on both 200 and 409), `phase3/exercitator-http-api-v0.3-delta.md` §2.1.3 (numeric examples + typed table), `phase3/exercitator-http-api-v0.3-amendment-proposal-2026-05-03.md` §7 (team response), `CHANGELOG.md`, `lessons.md`.
- Tests: 401/401 pass (`vitest run`). The new test fails against pre-fix code with `expected 'string' to be 'number'` on the 409 assertion — bug is now ratcheted.
- SAST: clean diff scan against baseline `sast-baseline-2026-04-29-c` (Gemini 2.5 Pro, no findings).
- Deployed: `exercitator-mcp` and `praescriptor-web` containers recreated on Cogitator. All three Tailscale endpoints return 200.

## 8. Out of scope (unchanged)

- Status codes, dedup model, `?force=true` semantics, bearer scoping — all unchanged.
- Storage column `external_id` stays TEXT — coercion is response-boundary only.
- `/api/users/:userId/form-text` (swim) — unaffected; still `text/plain`.
- `push-to-intervals` — still deferred to v0.4; function exists, endpoint not exposed.
- Praescriptor browser button — unchanged; reads only success/duplicate/message/error.

## 9. References

- Spec (canonical): `phase3/exercitator-http-api-v0.3-delta.md` §2.1.3
- Amendment proposal + §7 team response: `phase3/exercitator-http-api-v0.3-amendment-proposal-2026-05-03.md`
- Post-mortem: `lessons.md` — entry dated 2026-05-03 (`push-to-stryd response type drift between 200 and 409`)
- Source of truth for response builder: `src/web/send-stryd.ts`
- Source of truth for upstream Stryd types: `src/stryd/client.ts`
- Test pinning the contract: `tests/web/send-stryd.test.ts`
