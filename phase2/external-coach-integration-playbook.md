# Playbook — external-coach workout-recommendation integration

**Author**: derived from the Stryd-recommendations integration arc (2026-05-25), one full session covering Phases 0 → 6 plus push-back.
**Purpose**: provide a repeatable process for bridging Exercitator's prescription engine to a *second* external coaching source (FORM swim suggestions, or any other "external system serves us a workout body matching our category" integration).
**Reading guidance**: this is a process spec, not a copy-paste template. Each phase tells you *what to decide* and *what to verify*, with pointers to the exact files/patterns from the Stryd arc.

---

## When this playbook applies

You're bridging a coach-AI / external recommender that:

1. Has an HTTP API that returns *structured workouts* (blocks, segments, intensity bands)
2. Returns workouts that Exercitator's engine could plausibly map to its `WorkoutCategory` ladder (`rest | recovery | base | progression | tempo | threshold | intervals | long`)
3. Is the *source* of the workout body, while Exercitator stays the source of *the category decision* (readiness, Vigil, HRV, sleep debt, cross-training, staleness)

It does **not** apply when the integration is "Exercitator emits a workout, external system displays/executes it" (e.g. the existing FORM-text path via `buildFormDescription` — that's a one-way push, no swap).

---

## Decision tree — does this external system have an API at all?

Three states:

| State | Action |
|---|---|
| Vendor publishes an API spec | Skip Phase 0 capture; use the spec as your contract |
| API exists but undocumented; you have account credentials | Run a mitm capture (retextor pattern); reverse-engineer the response shape; codify as `notes/<vendor>-api/spec-recommendations.md` (or similar) |
| No API exists, only on-device input | This playbook does not apply. The existing FORM-text push (`src/web/form-format.ts`) is the model for that case |

**FORM swim** (status as of 2026-05-26): **completed reference arc alongside Stryd.** Phase 0 capture identified the auth flow + the two-call recommendation pattern: `GET /api/v1/users/me/workouts/smart_coach/personalized` returns 3 metadata summaries; `GET /api/v1/workouts/{id}` returns the structured `setGroups[]` body. Wire spec at `~/Documents/claude/retextor/notes/form-api/spec-recommendations.md`. Plan + phase breakdown at `phase2/form-swim-integration-plan.md`. Shipped end-to-end in commit `89ff94b`; live on ze with `swimRecommendationSource: "form"`.

**Two reference arcs to mine for new integrations**: this playbook generalises both. Stryd shows the JSON-with-blocks shape + integer-FTP gotcha + selected_id PATCH; FORM shows the qualitative-effort + two-call body fetch + cache-cadence-unknown patterns. New vendor → diff against both.

---

## Phase 0 — wire-contract verification (~30 min, manual)

**Goal**: produce a verified `spec-*.md` documenting the external API surface you'll integrate against.

Concrete steps from the Stryd arc:

1. **Capture under varied state**. The same endpoint can behave differently under "free tier vs paid sub", "no active plan vs active plan", "Apple Watch native vs Stryd-recorded". Capture under each state and content-hash the responses modulo timestamps to find what actually toggles behaviour. *Stryd lesson*: a paid sub did not unlock `type=long` — only an active adaptive plan did.
2. **Confirm response stability**. Re-capture the same endpoint a few hours later. Anything that changes between captures is metadata (timestamps, `updated_time`), not load-bearing content. *Stryd lesson*: `labels` rotate day-to-day for the same workout IDs — never pick by label.
3. **Confirm invariants empirically**. Hash content modulo volatile fields; verify the same workout id always carries the same blocks/segments. *Stryd*: `estimated_workout.intensity_zones[k] == sum_over_blocks(estimates[i].intensity_zones[k])` held everywhere.
4. **Codify** as `notes/<vendor>-api/spec-recommendations.md`. Include endpoint, auth, query params, response shape with field-by-field annotation, invariants, reproduction recipe, and an explicit "caveats / unknowns" section so the next person knows what was *not* verified.

**Output**: a spec doc + the captured JSON payloads checked in (or referenced from the retextor repo).

---

## Phase 1 — client surface (autonomous-agent safe; ~10 min)

**Goal**: add `getRecommendedWorkouts(type, extended?)` (or vendor-equivalent) to a vendor-specific client class.

Concrete:
- Extend the existing client at `src/<vendor>/client.ts` rather than creating a new one. The Stryd client at `src/stryd/client.ts` adds the recommendations method alongside `login`, `listActivities`, `createWorkout`, etc.
- Mirror the existing JSON-cap pattern: `parseBoundedJson<T>(res, label)` enforcing a 1 MB limit, applied to every JSON-parsing method. Defends against compromised/malformed upstream.
- TypeScript types match the wire field names *exactly* (snake_case if the wire is snake_case; no client-side renaming). Same as `StrydRecommendationSet`, `StrydRecommendedWorkout`, etc.
- Use a fixed-length tuple for any fixed-shape array on the wire (e.g. `intensity_zones: [number, number, number, number, number]` for Stryd's 5-zone array). Encodes invariants in the type system.
- Tests under `tests/<vendor>/recommendations.test.ts`. Fixtures vendored under `tests/fixtures/<vendor>-recommendations/`.

**Agent brief shape**: see the Phase 1 agent dispatch from this session — bounded scope, fixture-backed tests, no engine-layer changes.

---

## Phase 2 — mapper + picker + converter (autonomous-agent safe; ~15 min)

**Goal**: pure-function module at `src/engine/<vendor>-mapper.ts` with three functions.

| Function | Signature | Notes |
|---|---|---|
| `mapCategoryToVendorType` | `(category: WorkoutCategory) => string \| null` | Decides which vendor-side bucket to query for the given Exercitator category. `null` = skip (e.g. `rest`) |
| `pickVendorWorkout` | `(category, response) => { picked, rationale } \| null` | Picks one candidate from the vendor's response. **Score by content (intensity_zones / per-block stats), not by vendor labels** (labels can rotate day-to-day). Returns a rationale string for audit logging. |
| `vendorWorkoutToSegments` | `(vendorWorkout, ftp) => WorkoutSegment[]` | Converts the vendor's block/segment shape to Exercitator's flat `WorkoutSegment[]`. |

**Critical**: use **integer FTP** — read from `suggestion.power_context.ftp` once the swap is wired (the engine rounds Stryd's float CP at `src/engine/suggest.ts:171`; downstream layers must use the rounded integer, not the raw float). The Stryd arc hit a float-vs-int drift here that took a session to diagnose.

**Repeat-folding rule** (Stryd-specific but probably generalisable): if the vendor's blocks have a `repeat: N` field that loops over `segments[]`, **flatten** at conversion time (emit each segment N times in the output). Don't try to reuse Exercitator's `WorkoutSegment.repeats / work_duration_secs / rest_duration_secs` fields — those describe a single (work, rest) pair, not a structural N-loop over an arbitrary-length segment list. Render-time pair-collapse (Phase 6) handles UX.

---

## Phase 3 — Praescriptor + HTTP API integration (non-autonomous; ~30 min)

**Goal**: every surface that produces a Run/Swim suggestion runs the same swap.

The Stryd arc identified four surfaces producing suggestions; **audit yours similarly before starting**. Use:

```bash
grep -rn "suggestWorkoutFromData\|generatePrescriptions\|<your-vendor-suggestion-func>" src/
```

For Stryd:
- `src/web/prescriptions.ts:generatePrescriptions` (Praescriptor) — already runs the swap
- `src/api/handlers/workouts.ts` (`GET /workouts/suggested`) — needed wiring
- `src/api/handlers/dashboard.ts` (`GET /dashboard`) — needed wiring
- `src/engine/suggest.ts:suggestWorkout` (MCP `suggest_workout`) — deferred (no profile in scope)

**Pattern**: centralise the gate in a shared helper. Stryd's lives at `src/web/stryd-swap.ts:applyStrydSwapIfEnabled`:

```typescript
if (
  suggestion.sport !== "<expected-sport>"
  || suggestion.status === "awaiting_input"
  || profile.<vendor>RecommendationSource !== "<vendor>"
  || !vendorClient
  || !(suggestion.power_context.ftp > 0)
) return { suggestion, vendorRecommendationSet: null };
return applyVendorRecommendation(suggestion, vendorClient);
```

**Per-user flag**: extend `UserProfile` in `src/users.ts` with a new optional field (`runRecommendationSource: "stryd"` was the pattern; FORM swim would use `swimRecommendationSource: "form"`). Default undefined = engine output unchanged.

**Source chip in render**:
- Green chip on success (`Source: <Vendor> · <Workout title>`)
- Amber chip on fallback (`Source: Exercitator (<Vendor> unavailable: <reason>)`)
- No chip when no swap was attempted (other users, other sports, rest days)

**Engine-narrative cleanup** when swap succeeds (Stryd lesson — UX feedback caught this late):
- Replace `rationale` with the vendor's own description (e.g. `strydWorkout.desc`). Engine narrative ("Sweet-spot tempo...") becomes superfluous.
- Neutralise `terrain` to `"any"` and `terrain_rationale` to `""` (vendor's workout type carries terrain implicitly).
- Filter `warnings` to drop engine-modification-narrative (the staleness "Adding 10s/km buffer" + "easing back in" patterns). Keep health-related warnings (sleep, HRV, TSB, Vigil). See `src/web/stryd-swap.ts:filterEngineWarningsForStryd`.

**Preserve the original vendor payload** for round-trip push. Add an optional field to `WorkoutSuggestion`:

```typescript
strydOriginalWorkout?: unknown;  // typed as `unknown` to avoid engine→stryd cycle
```

Used by the push path (Phase 5) to round-trip without re-deriving from the flattened segments.

---

## Phase 4 — Promus DSW logging (fire-and-forget; ~15 min)

The Promus DSW endpoint (`POST /api/ingest/dsw`, issue #164 / PR #165) accepts records from any source. For FORM:

```typescript
source: "form"          // string; no enum yet
picked_workout_id       // FORM's workout id, stringified
picked_workout_title    // human-readable
picked_workout_type     // FORM's type discriminator
fallback_used           // bool
fallback_reason         // string
stryd_recommendation_set / form_recommendation_set  // see below
exercitator_context     // shared shape
```

**JSONB column naming**: today the column is `stryd_recommendation_set`. If we want to keep one row per (user, date, sport, source) and let `source` discriminate, we can either:
- (a) Rename the column to `vendor_recommendation_set` (Promus migration required) — preferred long-term
- (b) Add a parallel `form_recommendation_set` column — easier short-term, ugly long-term

The Promus issue's natural-key design already supports source-discriminated rows; the JSONB column naming is the only friction point. **Discuss with Promus side before starting FORM integration.**

**Read API** shipped as Promus issue #167 (merged 2026-05-27). `fetchDswRecord(userId, date, sport, source)` in `src/web/promus-dsw.ts` is the TS client; `GET /api/dsw/{...}` is the single-record endpoint; `GET /api/dsw?from=&to=` is the range endpoint with `?lean=true` to suppress the JSONB columns.

---

## Phase 5 — send-side signals + push (~20 min)

Three send paths to wire:

1. **`send-to-intervals.icu`** (`src/web/send.ts`) — accept optional `vendorClient` parameter, fire the "I picked this" signal after a successful intervals.icu event creation. For Stryd: `markStrydRecommendationSelected(strydClient, suggestion)` — PATCH `selected_id` back to Stryd. **Discover whether the vendor has an equivalent preference-signal endpoint during Phase 0.** FORM might not.

2. **`send-to-<vendor>`** (e.g. `src/web/send-stryd.ts`) — push the workout back to the vendor's calendar. The Stryd arc's discovery: `POST /workouts` to create the workout in their library + `POST /users/{userId}/workouts?id=&timestamp=` to schedule on the calendar. Round-trip the *original vendor payload* via `strydOriginalWorkout` for byte-faithful structure.

3. **TZ correctness**: when scheduling, do NOT floor the timestamp to local-midnight via `setHours(0,0,0,0)` — that sets midnight in the JS runtime's TZ (UTC in containers), landing the schedule on the wrong day for users west of UTC. Use the current moment directly. *Stryd lesson, took a session to diagnose live*.

4. **Error handling**: catches must log full error server-side via `console.error` but return a *generic* message to the client (no `String(err)` to the wire). Stryd arc's `src/web/send-stryd.ts` + `send.ts` show the pattern.

---

## Phase 6 — UX adaptations on the render + API surfaces (~20 min)

**Pair-collapse**: vendor workouts often have repeated (work, rest) pairs. Render-time collapsing produces "5× (30s + 30s)" instead of 10 flat rows. Logic lives at `src/engine/segment-groups.ts:groupPairSegments` — pure function over `WorkoutSegment[]`, conservative (only collapses byte-equal A-B-A-B-... patterns). Both Praescriptor's render and the API's `suggestionToApi` use it.

**ApiSegment**: when emitting a pair group on the API surface, include both the work target *and* the rest target:

```typescript
rest_target?: SegmentTarget;
rest_target_description?: string;
```

Default-unset for engine-built intervals (their rest is implicit-easy). New consumers ignore the field; updated consumers render both work and rest power bands.

**Sub-minute durations**: `formatDuration` in `render.ts` floored sub-minute durations to `0min`. Stryd fartlek bursts (30s work / 30s recovery) hit this. Fix is in place but watch for other render paths that do similar math.

---

## Phase 7 — validation (manual, interpretive; multi-day)

**Replay-from-Promus** via `fetchDswRecord` (Promus #167, shipped 2026-05-27): GET `/api/dsw/{userId}/{date}/{sport}/{source}`, reconstruct a `WorkoutSuggestion` from the stored fields + `exercitator_context.picked_workout_body` (+ `swim_css_m_per_s` for FORM/Swim), run through `toStrydWorkout` / `buildIntervalsDescription` / `buildFormDescription`, confirm byte-equal to a fresh live-engine emission. FORM arc's reference scaffold lives at `scripts/replay-form-dsw.ts`. **Defensive cap**: always call `validateFormWorkoutBody` (or the equivalent vendor helper) before flattening a stored body — a poisoned DSW row would otherwise blow memory at replay time. The shared helper between the live swap and the replay path is the canonical pattern.

For replay determinism:
- Store *integer* CP/FTP (the engine's rounded value), not the raw float
- Have the swap layer use `suggestion.power_context.ftp` exclusively
- Verify post-deploy: SQL-read the stored row, re-run conversion, hash both, expect equality

If replay diverges from live, the cause is almost certainly a precision drift between layers — the Stryd arc's bug was at `src/engine/suggest.ts:171` rounding while the swap layer used the float.

---

## Process meta-lessons (apply to FORM swim and any future bridge)

### What worked

1. **Phase 0 first, with empirical hashes**. SHA-256 of responses (sans timestamps) is faster than field-by-field diff for proving "this flag is a no-op" or "this label rotates". Saved ~30 min on the Stryd arc.
2. **Interview before plan**. The 4-question structured interview (replace-mode, pick-strategy, Promus scope, compliance handling) collapsed several rounds of speculative implementation before they started.
3. **Pair-collapse at render-time only** (not in the mapper) keeps the intervals.icu export unchanged. Single locus of UX-adaptation.
4. **Per-user flag on `UserProfile`** rather than a global toggle. Pam's flow stays untouched; ze's swap is opt-in.
5. **`strydOriginalWorkout` field** for round-trip preservation. Reconstructing from flattened segments lost block-repeat fidelity AND substituted Z1 Easy for everything (because Stryd-sourced segments had no `stryd_zone`).

### What was slow

1. **SAST iteration spiral** — Gemini finds progressively narrower defensive-coding issues. Each fix attracts a new Medium-severity finding because the diff bundle includes the new code. Stopping criterion: stop when the practical exploit is bounded by an existing structural defence (e.g. 1 MB JSON cap caps all the unbounded-loop variants). Don't chase past 2-3 iterations.
2. **TZ bug in `scheduleWorkout`** — `setHours(0,0,0,0)` in a UTC container landed schedules on the wrong local day. Caught only when ze visually inspected Stryd's calendar. **Lesson**: when scheduling on external calendars, log the exact timestamp + render in user's TZ before deploy.
3. **Float-vs-int FTP drift** — three layers using different rounding caused the same workout to render as 286-314W on the live API but 286-315W on replay. Took a deep-diff to find. **Lesson**: pick one rounding convention; thread the rounded value through every consumer.
4. **API path bypassing the swap** — Praescriptor was wired but the HTTP API handlers called the engine directly. Audit *every* surface that produces a suggestion before declaring the integration complete. The grep pattern is in Phase 3 above.

### SAST iteration management

Per-deploy SAST budget: **fix Critical + High; accept Medium / Low with explicit rationale if the structural defence is in place.** Document accepted findings in the commit message or SECURITY.md. Don't iterate more than 2-3 rounds on the same code path — Gemini's diff bundle excludes upstream context and will repeatedly flag theoretical issues that the surrounding code already addresses.

---

## FORM swim — concrete next steps

**Pre-Phase-0**:

1. **Capture FORM iOS app traffic** (mitmproxy + tailnet, same setup as the Black Library / Stryd captures). Open the FORM app → Workouts tab → flip through Coached Workouts and any "today's suggestion" tile. Save captures.
2. **Identify whether FORM has a recommendations API**. Look for URLs containing `recommendations`, `suggestions`, `workouts/{user}/today`, or similar. If you see structured JSON responses with workout bodies (segments, intensity), this playbook's Phase 1 onwards applies.
3. **If FORM has no such API**: pivot to a different swim-coach integration (MySwimPro / TriDot / SwimSmooth — each has subscription tiers with suggested workouts). Apply the same playbook against whichever you choose.
4. **If FORM has the API**: the playbook's Phase 0 step (verify the wire contract) is your starting point, with `<vendor> = form`.

**Open questions on the FORM side**:

- Does FORM expose suggestions per-user via an authenticated API?
- If yes, what's the auth scheme? (Auth0 like the Black Library captures? Bearer token in headers? Cookie session?)
- What categories does FORM's library cover? (Aerobic / threshold / sprint / drill / etc.?)
- Are intensity targets expressed in pace per 100m, or HR zones, or perceived effort?

**Known constraints (Exercitator side)**:

- Swim FTP / CSS lives in intervals.icu sport-settings (HR zones + pace zones). The swap will need to convert FORM's intensity targets to either pace-per-100m or HR-zone segments. The existing engine swim builder at `src/engine/workout-builder.ts` produces both — mirror its output shape in the mapper.
- Vigil does NOT apply to swim. Skip the Vigil-related guards in `applyVendorSwapIfEnabled`.
- The current FORM-text push (`buildFormDescription` + clipboard) should stay as the *fallback* execution channel — i.e. if FORM-sourced suggestions land via the new API, we can still emit FORM-text for the user to paste into their goggles. Two channels, one source.

---

## References

| Surface | File path |
|---|---|
| Stryd wire spec | `notes/stryd-api/spec-recommendations.md` (in `retextor` repo) |
| Stryd Phase-0 verification | `notes/stryd-api/phase0-verification-2026-05-25.md` (in `retextor` repo) |
| Promus DSW write endpoint | issue #164 / PR #165 in `zestuart/promus` |
| Promus DSW read endpoint | issue #167 in `zestuart/promus` (shipped 2026-05-27); `fetchDswRecord` in `src/web/promus-dsw.ts` |
| Today's session log | TBD — Exercitator has no `notes/session-*` convention; today's arc is in commit history `dc62f64..9d3ce13` |
| Architecture overview | `architecture.md` |
| Stryd swap layer | `src/web/stryd-swap.ts` |
| Stryd-side mapper (pure) | `src/engine/stryd-mapper.ts` |
| Pair-collapse | `src/engine/segment-groups.ts` |
| Promus DSW emitter | `src/web/promus-dsw.ts` |
| Per-user flag | `src/users.ts` |
