# Excubitor migration note — Exercitator API 0.2.1

**Date**: 2026-05-27
**Server side**: deployed with `version: "0.2.1"` (`src/index.ts`).
**Spec**: `phase2/exercitator-http-api-spec.md` §5.3.3.
**Prior**: `api-0.2.0.md` (`already_trained` + `rest_message`).

## What changed

`SuggestedResponse` gains a single new optional top-level field:

```diff
 interface SuggestedResponse {
   generated_at: string;
   user_id: string;
   date: string;
   tz: string;
   status: "ready" | "already_trained";
   suggestion: SuggestedWorkoutBody;
   rest_message?: RestMessageBlock;    // 0.2.0
+  invocation?: InvocationBlock;       // 0.2.1 — present iff status === "ready"
 }

+interface InvocationBlock {
+  opening: string;
+  rationale_header: string;
+  closing: string;
+}
```

The `DashboardResponse.suggested` field inherits the same change because it embeds a `SuggestedResponse`.

## Why

Disharmony noted on 2026-05-27: the suppression card (`status: "already_trained"`) carried server-rendered Quies text via `rest_message.invocation`, but the normal `ready` path carried no liturgical text at all. Native clients (Excubitor) could render a deity-flavoured suppression card but only an unflavoured normal card — Diana, Amphitrite, Minerva, and Apollo only appeared on Praescriptor. 0.2.1 closes that gap.

## What the fields carry

- **`opening`** — patron greeting. For `deities: true` profiles (ze): Diana (Run) or Amphitrite (Swim), generated dynamically against the workout's `category`, `readiness_score`, and `warnings`. For `deities: false` (Pam): plain English ("Today's running prescription, built from your recent training data…").

- **`rationale_header`** — title above the engine's rationale. Deity profiles get "Under Minerva's Counsel"; plain profiles get "Rationale".

- **`closing`** — invocation to Apollo (deity) or a neutral close ("Trust the process. The work is prescribed; the execution is yours.") for plain profiles.

The Praescriptor convention is to render `opening` at the top of each card, `rationale_header` above the engine's `rationale` text inside the card, and `closing` once per page at the bottom (centred). iOS may follow that convention, render only `opening`, render all three together, or ignore them entirely.

## Caching

Single module-level LRU keyed by `(sport, category, date)`. Praescriptor and the HTTP API share the cache. First-of-day request for a given (sport, category, user-tz-date) tuple costs one Anthropic API call (~1 s); all subsequent same-day requests (any user, any surface) return immediately from cache. If `ANTHROPIC_API_KEY` is unset on the server, the static fallback fires immediately.

`Cache-Control: private, max-age=300` still applies to the response itself.

## Wire shape example

`status: "ready"` (new field shown):

```json
{
  "generated_at": "2026-05-27T22:00:00Z",
  "user_id": "ze",
  "date": "2026-05-27",
  "tz": "America/Los_Angeles",
  "status": "ready",
  "suggestion": {
    "sport": "Swim",
    "category": "base",
    "title": "Endurance Swim",
    "rationale": "Building aerobic base with steady-state swim.",
    "total_duration_s": 1500,
    "...": "..."
  },
  "invocation": {
    "opening": "Before Amphitrite, queen of calm waters and rhythmic motion, this prescription is laid. May each stroke be counted, each length purposeful, and the body surrender to the discipline of the lane.",
    "rationale_header": "Under Minerva's Counsel",
    "closing": "Let Apollo, keeper of measure and truth, confirm through the data what the body already knows. The work is prescribed; the execution is yours."
  }
}
```

`status: "already_trained"`: `invocation` is **omitted** (the text lives in `rest_message.invocation` instead — a single string, not a struct, because the Quies card has no per-section rendering).

## Client work

1. **Recognise the new optional field**. If your decoder is strict-additive, this is no-op; if it errors on unknown keys, allow it.

2. **Decide whether to render**. Three valid stances:
   - Render verbatim: copy Praescriptor's three-place layout (opening at top, rationale_header above rationale text, closing at bottom).
   - Render only the opening: matches a more minimal card aesthetic.
   - Ignore entirely: substitute your own narration. The field's absence on `already_trained` already establishes that "no invocation" is a valid mode.

3. **Profile-agnostic rendering**. The server has already branched on `deities`, so the shape is the same for ze and Pam. Pam's text just happens to lack deity references. Treat both identically.

## Backwards compatibility

100 % additive. 0.2.0 clients ignore `invocation` and behave as before. No migration is forced.

## Server-side notes

- Cold-cache cost on the API: ~1 s first request per (sport, category, date). Acceptable — Praescriptor has always eaten this cost on its daily render.
- Failure mode: `generateInvocations` swallows Anthropic API errors and returns the static fallback. Never throws. The API response always populates `invocation` when status is `ready`.
- The known SAST finding that the invocation cache key omits `readiness_score` and `warnings` (so two API calls with different readiness levels but same sport/category/date share a cache slot) is pre-existing and accepted on baseline `sast-baseline-2026-05-27`. Not made worse by surfacing the field on the wire.
