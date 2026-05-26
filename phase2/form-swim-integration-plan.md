# Plan — FORM swim recommendations into Exercitator

**Created**: 2026-05-26, derived from `external-coach-integration-playbook.md` after Stryd arc.
**Vendor**: FORM Athletica (swim goggles).
**Scope**: bridge FORM's per-user recommendation endpoint into the Swim path of Exercitator's prescription engine, mirroring the Stryd run swap.
**Status of pre-work**: FORM client + auth done in retextor (`notes/form-client/`, 2026-05-26). 220 calls captured. OAuth verified end-to-end. Endpoint catalogue inventoried.

---

## Decisions (from interview, 2026-05-26)

| Fork | Decision | Consequence |
|---|---|---|
| Source endpoint | `GET /api/v1/users/me/workouts/smart_coach/personalized` (the list) | Need `pickFormWorkout(category, response)` — content-scored. The `up_next` workout is always in the 3-item list, so personalized is a superset. |
| Promus JSONB column | Rename `stryd_recommendation_set` → `vendor_recommendation_set` | Phase 4 gates on a Promus migration. Open issue first. |
| Intensity target | **Resolved 2026-05-26**: FORM emits qualitative `effort.level` (easy/moderate/build/strong/fast — `pace`/`zone`/`percentage`/`rpeLevel` always null in recommendations). Mapper derives `pace_target` from CSS via level→multiplier table; HR target via LTHR table; mirrors existing swim-builder output shape (both fields populated). | Phase 2 unblocked. |
| Execution channel | intervals.icu calendar event + FORM-text paste | Stryd-pattern dual channel. No write-back to FORM's library. |

---

## Phase 0 — wire-contract spike (~30 min, manual; **DONE 2026-05-26**)

**Output**: `~/Documents/claude/retextor/notes/form-api/spec-recommendations.md` — full wire contract, field-by-field annotation, reproduction recipe, captured fixtures.

**Key findings**:

1. **Two-call pattern**. `/users/me/workouts/smart_coach/personalized` returns 3 metadata summaries (no segments). `/workouts/{id}` returns the structured body in `setGroups[]`. Mapper must call both.
2. **Discriminator**: top-level `type` (`Endurance | Power | Technique` observed) mirrored by `workout.categories[0]` lowercase.
3. **Intensity is qualitative**: `effort.level` ∈ `easy | moderate | build | strong | fast` (5 values observed). `pace / zone / percentage / rpeLevel / splitRange` are all null in recommendations. Mapper derives numeric targets from user's CSS (pace) and LTHR (HR).
4. **Two-layer repeat**: `setGroup.roundsCount` × `set.intervalsCount`. Flatten at conversion; pair-collapse at render.
5. **`rest`**: `{defined: <seconds>, takeoff: null}` or null (continuous). `takeoff` shape unobserved but supported.
6. **`createdAt`** was 6 days old — recommendation list appears to be cached / event-driven (regenerated after a swim?). Recapture after next FORM swim to confirm cadence.

**Caveats** (carried forward as Phase 2 robustness requirements):
- `effort.level` vocab not enumerated — default unknowns to `moderate` + log.
- `type` vocab not enumerated — `Speed`, `Recovery`, `Drill` plausibly exist.
- Pace-mapping table (CSS×{1.18, 1.05, 1.00, 0.95, 0.88} for {easy, moderate, build, strong, fast}) is a starting heuristic — calibrate against execution history.

---

## Phase 1 — TS client (agent-safe, ~15 min)

**File**: `src/form/client.ts` (new directory).

**Reuse from Stryd**: `parseBoundedJson<T>(res, label)` 1 MB cap, snake_case wire types, fixed-length tuples for fixed-shape arrays.

**Auth in TypeScript**: port the three-tier cascade from `personalized.py`:

1. Read cached OAuth response (cache path under `~/.cache/form-client/oauth.json`, mode 0600). If `accessToken.expires` > now + 5min, use Bearer.
2. Else if `refreshToken.expires` > now, `POST /api/v1/oauth/token/refresh` with Basic client-creds + JSON `{refreshToken}`.
3. Else `POST /api/v1/oauth/token` with Basic client-creds + JSON `{email, password}` from `.env`.

`X-form-app-version: 3.19.1` on every request.

**Env vars**: `FORM_EMAIL`, `FORM_PASSWORD` in `.env` + `.env.example`. Client-id and client-secret as constants in `src/form/client.ts` — they ship in the APK so are not real secrets, but keep them at the module scope.

**Methods**:

```typescript
class FormClient {
  async getPersonalizedWorkouts(): Promise<FormRecommendationSet>
  async getWorkoutById(id: string): Promise<FormWorkoutBody>   // required — personalised list has no setGroups
  async getMe(): Promise<FormUser>                              // for sanity-check
  // Defer: up_next, plans, workouts list — not needed for the swap
}
```

**Two-call composition helper**: add `getPersonalizedWithBodies()` that fetches the list then the 3 bodies in parallel. Returns `{set, bodies: Map<id, FormWorkoutBody>}`. Caches in-memory for 1h to avoid hammering FORM during a Praescriptor render cycle.

**Tests**: `tests/form/client.test.ts` + fixtures vendored under `tests/fixtures/form-personalized/`. Stub `fetch` per Stryd test pattern.

**Refresh-rotation watch**: the Python handoff flags the refresh path as `[UNVERIFIED]` on the wire (only static-RE so far). When the TS client first fires the refresh path in production (≈30 days after first login), log the wire shape and update the spec doc.

---

## Phase 2 — mapper (agent-safe, ~20 min)

**File**: `src/engine/form-mapper.ts`.

**Three pure functions**:

| Function | Signature |
|---|---|
| `mapCategoryToFormType` | `(category: WorkoutCategory) => string \| null` |
| `pickFormWorkout` | `(category, response) => { picked, rationale } \| null` |
| `formWorkoutToSegments` | `(workout, css, lthr) => WorkoutSegment[]` |

**Category map** (preliminary — Phase 0 will firm up FORM's type vocabulary):

| Exercitator | FORM (placeholder) |
|---|---|
| `rest` | `null` (skip) |
| `recovery` | technique / easy |
| `base` | endurance |
| `tempo` | tempo / threshold-prep |
| `threshold` | threshold |
| `intervals` | sprint / VO2 |
| `long` | endurance-long |
| `progression` | endurance |

**Pick strategy**: score by content (total distance, intensity-band density, presence of drill blocks) — **not** by labels. Same lesson as Stryd: labels rotate.

**Conversion**: emit `WorkoutSegment[]` matching the existing swim builder's output at `src/engine/workout-builder.ts`. Pace in m/s on `pace_target` (CSS-derived); HR in bpm on `hr_target` (LTHR-derived). Both fields populated if Phase 0 confirms FORM carries intensity that resolves to either form.

**Flatten repeats**: if FORM blocks have a `repeat: N` loop, emit each segment N times. Pair-collapse at render-time only (Phase 6, already shared with Stryd).

**Vigil**: skip — swim has no Vigil signals.

**Tests**: `tests/form/mapper.test.ts`. Snapshot tests on segment output for a canonical fixture.

---

## Phase 3 — swap layer + surface wiring (non-autonomous, ~30 min)

**Helper**: `src/web/form-swap.ts:applyFormSwapIfEnabled`.

**Gate**:

```typescript
if (
  suggestion.sport !== "Swim"
  || suggestion.status === "awaiting_input"
  || profile.swimRecommendationSource !== "form"
  || !formClient
  || !(suggestion.pace_context.css > 0)
) return { suggestion, formRecommendationSet: null };
return applyFormRecommendation(suggestion, formClient);
```

**`UserProfile` extension** (`src/users.ts`):

```typescript
swimRecommendationSource?: "form";
```

Default undefined → engine output unchanged. Ze opt-in only at first.

**Surfaces to wire** (audit via `grep -rn "suggestWorkoutFromData\|generatePrescriptions" src/` before starting):

- `src/web/prescriptions.ts:generatePrescriptions` (Praescriptor)
- `src/api/handlers/workouts.ts` (`GET /workouts/suggested`)
- `src/api/handlers/dashboard.ts` (`GET /dashboard`)
- **Defer** `src/engine/suggest.ts:suggestWorkout` (MCP) — same reason as Stryd: no profile in scope.

**Source chip**:
- Green: `Source: FORM · <Workout title>`
- Amber on fallback: `Source: Exercitator (FORM unavailable: <reason>)`
- No chip when no swap attempted

**Engine-narrative cleanup on success**:
- `rationale` ← FORM workout's `description` field (or equivalent)
- `terrain` → `"any"`, `terrain_rationale` → `""` (FORM workouts are pool, terrain is implicit)
- Filter `warnings`: drop engine-modification narrative; keep health-related (sleep, HRV, TSB)

**Preserve original FORM payload**:

```typescript
formOriginalWorkout?: unknown;  // on WorkoutSuggestion, for FORM-text round-trip
```

---

## Phase 4 — Promus DSW (gated on Promus migration, ~15 min Exercitator-side)

**Pre-requisite**: open Promus issue *rename `stryd_recommendation_set` → `vendor_recommendation_set`*. Plus migration. Block Phase 4 until merged.

**Once Promus side ships**, emit on every successful FORM swap:

```typescript
source: "form"
picked_workout_id: string         // FORM's workout id
picked_workout_title: string
picked_workout_type: string       // FORM's type discriminator
fallback_used: bool
fallback_reason: string
vendor_recommendation_set: FormRecommendationSet  // full /personalized payload
exercitator_context: { ... }      // shared shape with Stryd
```

Fire-and-forget. Don't block the user-facing path on Promus latency.

**Existing Stryd writes** need a `source: "stryd"` field too once the column is renamed — that's a Stryd-side bookkeeping change to ship with the Promus migration.

---

## Phase 5 — send paths (~20 min)

**intervals.icu calendar event**: `src/web/send.ts` already pushes Swim suggestions to intervals.icu. Verify the path uses the swapped suggestion (not the raw engine output) — same pattern as the Stryd fix.

**FORM "selected this" signal**: catalogue shows no obvious PATCH endpoint for marking a recommendation chosen. **Skip** unless Phase 0 mitm reveals one (capture the app while tapping "Start workout" on a personalised tile).

**FORM-text paste**: existing `buildFormDescription` in `src/web/form-format.ts` keeps working — the swap upgrades the *source* of the prescription; the paste channel is unchanged. Verify the format renders FORM-sourced segments correctly (pace bands, drill markers).

**No write-back to FORM library**: explicitly out of scope per interview. If we later want it, the catalogue has `POST /api/v1/users/me/workouts` (write path, mark "use with care" in handoff).

**TZ correctness**: same lesson as Stryd — never `setHours(0,0,0,0)` on schedule timestamps in a UTC container. Use current moment.

---

## Phase 6 — UX (~10 min, mostly already done)

**Pair-collapse**: `src/engine/segment-groups.ts:groupPairSegments` is vendor-agnostic; reuse as-is. Swim sets like `8× (50 fast + 50 easy)` get collapsed at render-time only.

**ApiSegment rest_target / rest_target_description**: already in place from Stryd arc. Swim consumers may want to render both work and rest pace bands.

**Sub-minute durations**: confirm `formatDuration` handles 15-30s rest intervals between 50m reps — already fixed for Stryd, but watch the swim-specific render paths in `render.ts`.

---

## Phase 7 — validation (multi-day)

1. **Replay from Promus** once issue #167 (DSW read endpoint) ships. SQL-read the stored row, reconstruct `WorkoutSuggestion`, run through `buildFormDescription` + `buildIntervalsDescription`, hash both, expect equality.
2. **Live verification**: ze does one swim sourced from FORM. Check: intervals.icu calendar event matches the FORM tile, FORM-text paste matches, compliance grading runs, Promus DSW row written.
3. **Determinism**: store integer CSS (the engine's rounded value), thread through `pace_context.css`, exclude raw floats from the swap layer.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| FORM rate-limits the personalised endpoint | Medium | Cache responses in-memory for 1h; the endpoint is per-day-ish so this is safe |
| Refresh-rotation wire shape differs from static-RE | Low (verified via Python static-RE, fires only at 30-day mark) | When TS client first hits refresh path, log the wire and patch immediately |
| FORM removes/renames `/personalized` (no SLA on an undocumented API) | Low-Medium | Amber fallback chip; engine output remains the safety net |
| Personalised pick mismatches the engine category | Medium | Pick by content score; allow fallback to engine when no match passes a threshold |
| Promus migration delayed | Medium | Phase 4 is parallelisable but optional for shipping Phases 1-3 + 5-6 |
| SAST iteration spiral | Medium (saw this on Stryd) | Cap at 2-3 rounds; accept Medium/Low with documented structural defence |

---

## Open questions deferred to next session

- Does FORM have a per-user **HR strap** signal in the recommendation? If yes, prefer HR-zone targets in the mapper; if no, prefer pace.
- Does the personalised list include **drill-only workouts** (no intensity)? If yes, handle as a special category (low cardiac demand, technique focus).
- How does the personalised endpoint behave during a **subscription gap**? Capture under "free tier" if possible (or note as unverified).
- Should the swap apply to Pam's profile too, or stay ze-only at first? Default: ze-only, like Stryd.

---

## References

| Surface | Path |
|---|---|
| Playbook | `phase2/external-coach-integration-playbook.md` |
| FORM client handoff | `~/Documents/claude/retextor/notes/form-client/HANDOFF.md` |
| FORM Python client | `~/Documents/claude/retextor/notes/form-client/personalized.py` |
| FORM mitm capture | `~/Documents/claude/retextor/mitm/form/2026-05-26.flows` |
| FORM static-RE dossier | `~/Documents/claude/retextor/notes/form-app-discovery-2026-05-26.md` |
| Stryd swap (reference) | `src/web/stryd-swap.ts` |
| Stryd mapper (reference) | `src/engine/stryd-mapper.ts` |
| Pair-collapse (shared) | `src/engine/segment-groups.ts` |
| Per-user flag (extend) | `src/users.ts` |
| Existing FORM-text path | `src/web/form-format.ts` |
