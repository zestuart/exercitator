# Excubitor migration note — Exercitator API 0.2.0

**Date**: 2026-05-27
**Server side**: deployed with `version: "0.2.0"` (`src/index.ts`).
**Spec**: `phase2/exercitator-http-api-spec.md` §5.3.3 (`GET /workouts/suggested`) and §5.8 (`GET /dashboard`).

## What changed

The `SuggestedResponse` shape gained a new status value and a new optional block:

```diff
 interface SuggestedResponse {
   generated_at: string;
   user_id: string;
   date: string;
   tz: string;
-  status: "ready";
+  status: "ready" | "already_trained";
   suggestion: SuggestedWorkoutBody;   // always present
+  rest_message?: RestMessageBlock;    // present iff status === "already_trained"
 }

+interface RestMessageBlock {
+  trained_sport: "Run" | "Swim";
+  trained_activity_id: string;        // e.g. "i151968721" (intervals.icu id)
+  trained_activity_type: string;      // e.g. "Run", "TrailRun", "VirtualSwim"
+  trained_at: string;                 // local time, no Z suffix: "2026-05-27T07:51:34"
+  alternate_sport: "Run" | "Swim" | null;  // opposite sport, or null if also trained today
+  invocation: string;                 // server-rendered Quies opening line (or plain text for non-deity profiles)
+}
```

The `DashboardResponse.suggested` field inherits the same change because it embeds a `SuggestedResponse`.

`suggestion.segments` is `[]` when status is `already_trained`. `suggestion.category` is `"rest"`. `suggestion.total_duration_s` and `estimated_load` are `0`. All other fields stay populated (sport, power_context, readiness_score, terrain, etc.) so the readiness panel renders unchanged.

## Why

Server side: if the user has already done the requested sport today (any activity, no TSS threshold), the engine short-circuits the prescription pipeline. Previously this hit the Stryd-recommendation fallback path and showed an engine-built recovery jog with a confusing "Stryd unavailable: stride_rejected_on_recovery" chip. Now the card explicitly says "you've already trained this sport today — rest, or swap".

## Client work

1. **Branch on `status`**. Anywhere Excubitor exhaustively switches on `status === "ready"`, add an `already_trained` arm. If you currently force-unwrap or assume `status === "ready"`, that's a crash bug as of 0.2.0.

2. **Render the suppression card**.
   - Hide segments (or skip rendering the segment list — `segments` is `[]` anyway).
   - Show `rest_message.invocation` as the card body. The server has already chosen between Quies (deity profile) and plain text (Pam) based on the user's profile flag.
   - When `rest_message.alternate_sport` is non-null AND the user's profile has that sport configured, show a "Swap to {sport}" CTA that navigates to that sport's tab. When null, hide the CTA (rest-only).
   - Keep the readiness panel visible (the `suggestion` block carries `readiness_score`, `power_context`, etc.).

3. **Trained-activity provenance**. `rest_message.trained_at` is local time (no Z). Use `rest_message.trained_activity_id` to deep-link to the activity detail page (`/workouts/iv-<id>` already exists — strip the `i` prefix if your client expects raw intervals.icu ids).

4. **Caching**. `Cache-Control: private, max-age=300` still applies. The suppression status persists for the user's local day, so once you've fetched `already_trained` you can confidently render the suppression card without re-fetching every foreground.

## Wire shape example

```json
{
  "generated_at": "2026-05-27T22:00:00Z",
  "user_id": "ze",
  "date": "2026-05-27",
  "tz": "America/Los_Angeles",
  "status": "already_trained",
  "suggestion": {
    "sport": "Run",
    "category": "rest",
    "title": "Run already complete today",
    "rationale": "Already trained Run today (Run). Rest, or swap to Swim.",
    "total_duration_s": 0,
    "estimated_load": 0,
    "readiness_score": 57,
    "sport_selection_reason": "Forced: Run",
    "terrain": "any",
    "terrain_rationale": "Suppressed — already trained today",
    "power_context": { "source": "stryd_direct", "ftp": 286, "confidence": "high" },
    "warnings": [],
    "injury_warning": null,
    "segments": []
  },
  "rest_message": {
    "trained_sport": "Run",
    "trained_activity_id": "i151968721",
    "trained_activity_type": "Run",
    "trained_at": "2026-05-27T07:51:34",
    "alternate_sport": "Swim",
    "invocation": "Before Quies, goddess of repose, the day's work is set down. Diana releases you. Seek Amphitrite, or seek nothing at all."
  }
}
```

## Backwards compatibility

If Excubitor is shipped with a 0.1.x-only model that doesn't know about `already_trained`, a future server response with that status will likely either:
- Crash on enum decoding (Swift `Codable` with strict `enum Status: String, Codable`), or
- Treat the `suggestion` as a normal ready prescription with zero segments and the literal title "Run already complete today" — degraded but non-fatal.

Bump the iOS app's deserialiser to recognise the new status before the next App Store / TestFlight cut. The server falls back to the old behaviour only by reverting `src/index.ts` to `0.1.0` and re-deploying.

## Not yet shipped

- DSW emission for suppressed cards is deferred (Promus side needs a `source = "suppressed"` schema). Replay-from-Promus does not yet record the suppression branch — the day's "what was shown" history skips suppressed entries. Pick this up when extending Promus #167.
