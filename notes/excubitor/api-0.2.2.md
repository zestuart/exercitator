# Excubitor migration note — Exercitator API 0.2.2

**Date**: 2026-06-03
**Server side**: deployed with `version: "0.2.2"` (`src/index.ts`).
**Spec**: `phase2/exercitator-http-api-spec.md` §5.3.3.
**Prior**: `api-0.2.1.md` (`invocation` block).

## What changed

Two things, both visible in the Exercitatio tab:

1. **New `status: "health_unavailable"`** — the engine refuses to prescribe when the athlete's overnight WHOOP telemetry (the Sleep + HRV readiness source) is missing for today or Promus is unreachable.
2. **Readiness is now whole-athlete** — the displayed `readiness.score` / `readiness_score` no longer filters recency to a single sport. A recent ride or swim now tempers the number. No shape change; a value-semantics change.

```diff
 interface SuggestedResponse {
   generated_at: string;
   user_id: string;
   date: string;
   tz: string;
-  status: "ready" | "already_trained";
+  status: "ready" | "already_trained" | "health_unavailable";
   suggestion: SuggestedWorkoutBody;
   rest_message?: RestMessageBlock;          // 0.2.0
   invocation?: InvocationBlock;             // 0.2.1 — present iff status === "ready"
+  health_unavailable?: HealthUnavailableBlock;  // 0.2.2 — present iff status === "health_unavailable"
 }

+interface HealthUnavailableBlock {
+  reason: string;    // machine slug, e.g. "whoop_today_missing", "promus_unreachable", "promus_http_502"
+  message: string;   // user-facing sentence, safe to display verbatim
+}
```

`DashboardResponse` gains a top-level `health_unavailable` field (mirroring `awaiting_input`):

```diff
 interface DashboardResponse {
   status: StatusResponse;
   today: TodayResponse;
   suggested: SuggestedResponse | null;
   awaiting_input: { … } | null;
+  health_unavailable: HealthUnavailableBlock | null;  // 0.2.2
 }
```

## HTTP status codes for the standalone `/workouts/suggested` endpoint

The blocked states each map to a different HTTP code — branch on the code first, then the body:

| Engine state | HTTP | Body |
|---|---|---|
| `ready` | 200 | `SuggestedResponse` with `status: "ready"` |
| `already_trained` | 200 | `SuggestedResponse` with `status: "already_trained"` + `rest_message` |
| `awaiting_input` (cross-training RPE) | 409 | error envelope + `awaiting_input` block |
| **`health_unavailable`** (0.2.2) | **503** | error envelope + `health_unavailable` block |

503 example:

```json
{
  "error": "health telemetry unavailable",
  "health_unavailable": {
    "reason": "whoop_today_missing",
    "message": "WHOOP has not synced last night's sleep yet. Open the WHOOP app to sync, then refresh."
  }
}
```

On `/dashboard` (always HTTP 200) the same condition is surfaced as `suggested: null` with the top-level `health_unavailable` block populated — analogous to how `awaiting_input` already works.

## Why

- **`health_unavailable`**: ze's Sleep + HRV readiness components moved from intervals.icu wellness to the in-house Promus WHOOP strap feed (an intervals Oura-sync artefact once logged an 18-minute "night" that silently suppressed a real prescription — see `lessons.md` 2026-06-03). The policy is to **hard-fail loudly** rather than prescribe from degraded inputs. In practice this fires in the morning before the strap has synced last night; the `message` tells the user what to do.
- **Whole-athlete readiness**: the Exercitatio tab guides running, swimming, and cycling. A Run-specific recency made the number disagree with cross-sport recovery. Now one number reflects total fatigue across all sports, identical on the Praescriptor header, the `suggested` block's `readiness_score`, the `/status` block, and the `/dashboard` block.

## What the fields carry

- **`health_unavailable.reason`** — a stable machine slug for telemetry/branching. Known values: `whoop_today_missing`, `promus_unreachable`, `promus_http_<code>`, `promus_error`, `promus_not_configured`. Treat unknown slugs as a generic "health data unavailable".
- **`health_unavailable.message`** — a complete, user-safe sentence. Render verbatim; do not parse.

The `readiness.components.{hrv,sleep}` badges (`ok` / `low` / `unknown`) on `/status` + `/dashboard` are now sourced from the same WHOOP data as the score, so they no longer read `"unknown"` while the score is populated.

## Client work

1. **Add the `health_unavailable` status case.** When `/workouts/suggested` returns **503** (or `/dashboard` carries a non-null `health_unavailable`), render a blocked card showing `message` and prompting a WHOOP sync + refresh. Do not treat it as a generic server error / retry storm — it is an expected daily state, not a fault.
2. **Readiness number may read lower than before** for multi-sport days. No code change required; just be aware the value now reflects cross-sport recency.
3. **Strict decoders**: allow the new optional `health_unavailable` field on `SuggestedResponse` and the new `status` enum value.

## Backwards compatibility

Additive on the wire shape. The one behavioural break is for clients that **exhaustively switch** on the prior `status` union (`ready` | `already_trained`) — they must add the `health_unavailable` arm or fall through to a default. The 503 on `/workouts/suggested` is new; clients that previously assumed only 200/409 must handle it.

## Server-side notes

- Staleness policy is strict by design: a WHOOP night for **today's** local wake date must be present. The knob lives in `fetchHealthTelemetry` (`src/engine/suggest.ts`) if it needs relaxing to "transport error OR stale > 2 days".
- Pam is unaffected (`healthSource` unset → intervals.icu wellness as before; never hard-fails on WHOOP).
- `/status` and `/dashboard` are informational and do **not** hard-fail — they report readiness from the most recent available night even when today's is missing.
