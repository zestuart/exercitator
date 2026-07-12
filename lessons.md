# Lessons Learned

Chronological log of bugs, failures, surprises, and insights. Claude maintains this
proactively. Entries are append-only — never edit or remove past entries.

## 2026-05-09 — Issue #31 close was wrong: `watts !== strydCp` regression on `/status` and `/dashboard` (issue #32)

**What happened**: Hours after closing #31 with the claim "`critical_power.watts === Math.round(strydCp.cp)` whenever Stryd creds are configured, by construction", Excubitor's iOS Nunc card showed 315 W (intervals.icu rolling FTP) under a `source: "stryd_direct"` label while Praescriptor's data-source row showed the correct 286 W (raw Stryd CP from the same `fetchStrydCpInput` call). The exact divergence #31 was supposed to close, on the same wire field, on the same deploy day.

**Root cause**: I reasoned about *one* engine path (`suggestWorkoutFromData`) and treated the wire CP block as if it always flowed through that path. It doesn't. `/status` (`src/api/handlers/status.ts:40`) and `/dashboard` (`src/api/handlers/dashboard.ts:56`) build `powerContext` directly from `detectPowerSource(data.activities)` and pass that straight into `criticalPowerFromContext`, never calling `suggestWorkoutFromData`. The engine-level Stryd override at `src/engine/suggest.ts:170` (`powerContext.ftp = Math.round(strydCp.cp)`) only runs on the *suggestion* path. On status/dashboard, `powerContext.ftp` was whatever intervals.icu rolling FTP `detectPowerSource` produced (315 W). `criticalPowerFromContext`'s precedence (`powerContext.ftp > 0 ? powerContext.ftp : strydCp`) then picked the rolling FTP. The defensive unit test I wrote during the doc-sync hours later (`defensively prefers powerContext.ftp over strydCp when they disagree`) actively *pinned* the bug — I had renamed it from a stale-comment cleanup, with rationale that read like sound engineering and was structurally wrong.

**Fix**: Single-line precedence flip at `src/api/payload.ts:161`:

```ts
const chosenFtp = strydCp ?? (powerContext.ftp > 0 ? powerContext.ftp : null);
```

Now Stryd CP wins whenever present, *inside the function itself* — independent of whether the caller routed through the suggestion engine. Stryd-less users (Garmin / intervals.icu only) still get the rolling-FTP fallback. The defensive-precedence test was rewritten as a regression test that pins the exact dashboard/status input shape (`ftp=315, strydCp=286 → watts=286`).

**Prevention**:

1. **"By construction" is a load-bearing claim — earn it before saying it.** When I closed #31 I hadn't traced every call site of `criticalPowerFromContext`. The function had three call sites (`status.ts`, `dashboard.ts`, plus the suggestion-block embedding); only one of them upstream-applied the override. A two-minute `rg criticalPowerFromContext` would have shown the missing path. Lesson: when claiming structural impossibility, list the call sites explicitly in the close note. If the list isn't short and obvious, the claim is wrong.
2. **Push security/correctness invariants into the function, not the caller.** The 2026-05-01 entry's prevention #3 ("when two surfaces compute the same logical value, route them through one helper") covered FTP fetching (`fetchStrydCpInput`) but not the precedence decision. Three handlers fetched Stryd CP through one helper, then independently composed `(powerContext, strydCp)` and passed the pair to a function whose precedence didn't enforce the invariant. The fix moves the invariant *inside* `criticalPowerFromContext` so any future handler that calls it inherits the right semantics by default.
3. **Defensive tests must defend the right thing.** The "defensively prefers powerContext.ftp over strydCp" test I kept hours earlier was protecting an invariant that didn't exist. Rationale-by-comment is not a substitute for tracing the actual call graph. When a test's name and rationale start describing a hypothetical future code path, ask whether you're really defending current behaviour or just inventing a constraint.
4. **A doc-sync that touches a test comment without reading the test's call sites is dangerous.** During the same-day doc-sync, I rewrote the test's comment on the basis of `git grep STRYD_CP_STALE` results. I never grep'd for callers of `criticalPowerFromContext`. The audit was thorough on the *removed-symbol* axis and blind on the *path-coverage* axis.

**Tests changed**: `defensively prefers powerContext.ftp over strydCp when they disagree` (added during 2026-05-09 doc-sync) → replaced with `Stryd CP wins when powerContext.ftp differs (dashboard/status regression #32)`. Same input shape, inverted expectation. 401/401 green.

## 2026-05-09 — Reverted Stryd CP staleness override (issue #31)

**What happened**: Excubitor (Nunc) iPhone client surfaced a `critical_power.watts` value on its Exercitatio "Critical Power" card that disagreed with both the Stryd PowerCenter app and Praescriptor's web header. All three nominally referenced the same `stryd_direct` source. Filed as issue #31 with a recommended additive `stryd_cp_w` field on `CriticalPowerBlock` so clients could choose between "engine's prescribing FTP" (`watts`) and "raw Stryd authority" (`stryd_cp_w`).

**Root cause**: The 2026-05-01 staleness override (lessons.md entry "MCP/Praescriptor disagreed on FTP, plus stale Stryd CP under-prescribed", commit `d744097`) protected against a real failure mode — post-layoff Stryd CP sits on pre-layoff hard efforts and under-prescribes by a zone — but it created a new failure mode by design: when the override fired, `powerContext.ftp` flipped to intervals.icu rolling FTP while `mapWirePowerSource` still emitted `stryd_direct` (the wire enum branched on "did we query Stryd?", not "did we use Stryd's number?"). Wire `watts` and `source` could disagree on which engine produced the headline number, with no signal on `/status` (the override warning rode only on `/workouts/suggested`'s `power_context.warnings`).

**Fix**: User chose to remove the override entirely rather than ship the additive `stryd_cp_w` field. Trade-off accepted: simpler model (Stryd CP is authoritative when present, full stop) at the cost of pushing CP-freshness responsibility onto the athlete (book a fresh CP test when fitness shifts). Removed `STRYD_CP_STALE_DAYS` and `STRYD_CP_STALE_OVERRIDE_RATIO` constants, the `inferredFtp/isStale/inferredHigher` block in `suggestWorkoutFromData`, and both warning strings. `StrydCpInput.ageDays` retained because the HTTP API `critical_power.updated_at` and Praescriptor's data-source row still surface CP age to the human in the loop — the *information* is preserved, only the *automatic action* is dropped.

**Prevention**:

1. **Authoritative-source decisions are a one-way door, not a tunable.** The 2026-05-01 entry's "Authoritative-source flags must come with a freshness contract" guidance was technically followed (we logged the override) but the engine still made the override automatic. The user-facing failure (Excubitor showing wrong number) was harder to debug than the original under-prescription would have been. Lesson: when the source-of-truth is also the user's mental model, don't let the engine silently substitute. Surface the staleness, let the human act.
2. **Wire-enum semantics must reflect the value, not the *intent*.** `mapWirePowerSource` returning `stryd_direct` based on "we queried Stryd" was a defensible-on-paper choice that broke the moment the engine diverged from the Stryd value. If we ever re-introduce an override, the wire enum must change with it (e.g. a fourth `stryd_overridden` value), not just rely on a warning attached to a sibling endpoint.
3. **Reverting prior protective code is legitimate, but check the lesson it produced.** The 2026-05-01 entry remains canonical for the original failure mode — if the athlete returns from a layoff with a stale CP and runs the prescription at RPE 1, the engine won't catch it now. That's an explicit acceptance, not a regression.

**Tests changed**: Two override-specific tests removed (`falls back to intervals.icu rolling FTP when Stryd CP is stale and lower`, `keeps Stryd CP when stale but inferred FTP is not materially higher`); third test (`uses fresh Stryd CP without warning even if lower than intervals FTP`) replaced with `trusts Stryd CP regardless of age — no rolling-FTP override` covering both stale and fresh paths. 401/401 green.

## 2026-05-03 — v0.3 deploy (push-to-stryd + form-text) blocked twice by pre-existing SAST findings

**What happened**: Routine deploy of two new HTTP API endpoints (`POST /api/users/:userId/push-to-stryd` and `GET /api/users/:userId/form-text`) for the Excubitor/Nunc iPhone client. Lint, typecheck, and 399/399 tests all green. `--mode diff` SAST scan blocked the deploy twice in succession on two pre-existing High findings that were brought into scope by the changed files:

1. **DoS via unvalidated `tz` on `/dashboard`** — the dashboard handler used a weak `q?.includes("/")` check that admitted crafted IANA-shaped strings (e.g. `?tz=a/a`) which then reached `Intl.DateTimeFormat` inside `localDateStr` → `RangeError` → process crash. The `workouts.ts` handler had been correctly using `isValidTimezone` from day one; the dashboard handler had drifted.
2. **SSRF / path-traversal via crafted `activityId` in MCP `submit_cross_training_rpe`** — `encodeURIComponent` already neutralised the immediate vector, but the HTTP API equivalent had a regex allowlist (`isValidIntervalsId` = `^[A-Za-z0-9_-]{1,64}$`) as documented defence-in-depth, and the MCP tool didn't.

**Root cause**:

1. (Dashboard) The `tz` resolver was duplicated across `workouts.ts` and `dashboard.ts` as separate-but-similar functions. `workouts.ts` evolved to use `isValidTimezone` after the previous SAST cleanup; `dashboard.ts` kept the older `q?.includes("/")` pattern. Two implementations of the same security-critical decision drifted apart.
2. (MCP tool) The HTTP API's `cross-training` handler and the MCP tool both submit RPE for an activity, but they were independently authored. The HTTP API got the regex allowlist as a documented step in the previous SAST cleanup; the MCP tool wasn't part of that cleanup's diff scope, so its Zod schema kept `z.string()` without a regex.

**Fix**:

- Extracted the canonical `resolveTz(user, url)` to `src/api/tz.ts`. Both `dashboard.ts` and `workouts.ts` now import it; the new `push-to-stryd.ts` and `form-text.ts` handlers consume it from day one. Single source of truth — a future handler that forgets to validate `tz` is impossible by construction (the helper is the only sanctioned path).
- Added `z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid activity ID format")` to the Zod schema in `src/tools/suggest.ts`. Same pattern as `src/api/validate.ts:isValidIntervalsId`.
- Crafted-tz security tests added to both new handler test files (`tests/api/handlers/push-to-stryd.test.ts`, `tests/api/handlers/form-text.test.ts`): a request with `?tz=a/a` must drop to `"UTC"` instead of crashing.

**Prevention**:

1. **Centralise security-critical decisions on the first duplication, not the second.** The drift between `workouts.ts` and `dashboard.ts` would not have happened if `resolveTz` had been extracted at the moment a second handler needed it. The lesson: when copy-pasting a request-boundary validator, extract immediately.
2. **Keep MCP and HTTP API surfaces aligned on input validation.** Any time the HTTP API gains a new validator at the request boundary (regex, allowlist, tz check), audit the MCP tool that exposes the same operation. They share an upstream and therefore share the threat model. A grep for the field name (`activityId`) catches this in seconds.
3. **`--mode diff` SAST is a feature, not a chore.** Both findings were pre-existing — neither was introduced by the v0.3 work — but the diff scan correctly flagged them when files in the same blast radius changed. Treating diff-scan failures as "not my finding" would have shipped a known-vulnerable container. Philosophy #1 ("security non-negotiable") plus the deploy gate caught it. Re-baseline on the next deploy commit so the SAST signal stays sharp.

**Tests added**: 2 crafted-tz cases in the new handler test files. 399/399 green after fixes.

## 2026-05-01 — MCP/Praescriptor disagreed on FTP, plus stale Stryd CP under-prescribed

**What happened**: User ran the prescribed sweet-spot tempo (2 × 6 min Stryd Z2) at avg 235–241 W with HR 128–134 (cap was 153) and reported RPE 1 — breathing unaffected, legs unaware. Calibration interview surfaced two distinct issues that compounded:

1. **MCP `suggest_workout` and Praescriptor were rendering different watt targets for the same prescription on the same day.** MCP said the work intervals were 252–284 W (FTP 315). Praescriptor's UI said 219–247 W (FTP 274). User screenshotted the UI — the two surfaces were silently disagreeing.
2. **Stryd Critical Power was 274 W, last updated 2026-04-07** — almost a month stale, after a layoff with only 2 runs in 14 days. Even when running on plan, the sweet-spot band was actually upper Z1 / low Z2 in absolute terms because CP hadn't seen any hard efforts to revise upward. Athletes' lived experience: "should be one zone higher" — i.e. CP is one zone-width too low.

**Root cause** (the disagreement): `suggestWorkout` (engine entry, MCP path) called `suggestWorkoutFromData(... undefined ...)` for the `strydCp` slot. Praescriptor (`generatePrescriptions`) and the HTTP API handlers (`status`, `dashboard`, `workouts`) all fetched Stryd CP and passed it through. The MCP path therefore fell back to `detectPowerSource()`'s `icu_rolling_ftp` (315 W), while the others got the real Stryd CP (274 W) — same data, two prescriptions. Tool fan-out around the engine never ratcheted the MCP path forward.

**Root cause** (the stale CP): The override always trusted Stryd CP even after a long layoff. Stryd's CP estimator is anchored on recent hard efforts; absent those, it just sits. intervals.icu's rolling FTP is recomputed from each new activity's NP/intensity factor, so it adapts faster after a return-to-training. We were trusting the slower, more authoritative signal *as if it were always current*.

**Fix**:
- New `StrydCpInput = { cp, ageDays }` shape. `getLatestCriticalPower()` now returns `{ criticalPower, createdAt }` so callers can compute age. New shared helper `fetchStrydCpInput(strydClient, now)` used by all four prescription paths (MCP, Praescriptor, HTTP API status, HTTP API workouts/dashboard) — single resolution point.
- `suggestWorkoutFromData` staleness override: when CP is older than `STRYD_CP_STALE_DAYS` (30) **and** intervals.icu's rolling FTP exceeds it by `STRYD_CP_STALE_OVERRIDE_RATIO` (1.05), use rolling FTP and warn loudly with both numbers and the age. Stale CP without a higher inferred FTP keeps Stryd CP but emits a softer "consider a fresh CP test" warning.
- MCP entry `suggestWorkout` now accepts an optional `StrydClient`; `src/index.ts` constructs one from `STRYD_EMAIL`/`STRYD_PASSWORD` at startup and passes it through `registerSuggestTools`.
- HTTP API `critical_power.updated_at` now reports the real Stryd CP creation timestamp instead of `now()` — clients can detect staleness without a separate API call.
- `criticalPowerFromContext` (HTTP API payload) flipped precedence to prefer `powerContext.ftp` over the raw `strydCp` argument: when the staleness override fires, the engine has chosen the inferred FTP and the API must report that — otherwise `watts` would still announce the stale Stryd value while segment targets are derived from a different number. Wire `source` keeps reporting `stryd_direct` (we did query Stryd); the override reason lives in `power_context.warnings`.

**Prevention**:
1. Two engine entries with overlapping responsibility (`suggestWorkoutFromData` and `suggestWorkout`) must take the same FTP-resolution path. Adding tests that pin the MCP wire output against a fixture-with-stryd-CP would have caught this immediately. The unit test `suggestWorkout integration > overrides FTP with Stryd CP when provided` only exercised `suggestWorkoutFromData` directly, never the MCP entry — that's how the disagreement persisted.
2. Authoritative-source flags ("Stryd is the source of truth") must come with a freshness contract. Any time the engine prefers one signal over another, log when that decision was made under stale data so the staleness becomes visible.
3. When two surfaces (MCP, web UI, HTTP API) compute the same logical value, route them through one helper. Three of the four CP fetches were structurally identical try/catch blocks around `getLatestCriticalPower()` — copy-paste invited drift.

**Tests added**: 3 new cases in `tests/engine/suggest.test.ts` cover (a) stale CP overridden by higher rolling FTP with warning, (b) stale CP kept when rolling FTP is not materially higher, (c) fresh CP used as-is even when rolling FTP is higher.

## 2026-04-29 — Run zones realigned to Stryd's 5-zone model + threshold/progression categories

**What happened**: User flagged that the morning's run-power tune (Z2 base 70–80% CP) was still "barely above a brisk walk" and asked for the engine bands to map onto Stryd's published 5-zone model directly. Stryd's bands at CP=274W: Z1 Easy 65–80%, Z2 Moderate 80–90%, Z3 Threshold 90–100%, Z4 Interval 100–115%, Z5 Repetition 115–130%.

**Root cause** (zones): The engine had its own ad-hoc 4-zone model (recovery / base / tempo / intervals + long) that no longer matched Stryd's prescriptive guidance. "Tempo" lived at 80–90% which the engine labelled Z3 but Stryd actually labels as Z2 Moderate; Stryd's "tempo workout" is *Extensive Threshold Stimulus* (sweet-spot, 80–90%) while their "threshold workout" is *Intensive Threshold Stimulus* (90–95%) — these are two different sessions, and the engine collapsed them. A quick web search of Stryd's own blog/help-centre surfaced the distinction; user picked Path C (add a `threshold` category, keep `tempo` as sweet-spot) over my initial suggestion of redefining `tempo` as Z3.

**Fix**:
- `WorkoutCategory` extended to 8 values: `rest | recovery | base | progression | tempo | threshold | intervals | long`. `progression` is a new "thirds" build (65–72 / 72–80 / 80–87% CP) for variety in moderate-readiness weeks; `threshold` is sustained 3×15 min at 90–100%.
- All run-builder bands shifted to the Stryd 5-zone model. Sub-65% CP (walk territory) is no longer prescribed for any working segment — if readiness wants less, the prescription is rest, not "barely above a brisk walk".
- New `WorkoutSegment.stryd_zone` field (1–5) so Stryd export can pick the right CP-% band independently of `target_hr_zone` (which still drives the safety-cap HR display in Praescriptor). HR zones and power zones don't always align under the new mapping (e.g. base sits at HR Z2 but Stryd Z1 Easy), and a single field would have forced one or the other to lie.
- Selector ladder: 51–65 → tempo, 66–80 → threshold, 81+ → intervals (3-day rest), threshold (2-day rest), tempo (yesterday). Vigil downshift, staleness DOWNGRADE, sleep-debt cap, and cross-training capOrder all updated for the two new rungs.
- Stryd export gained an explicit `RECOVERY_PCT` band (sub-Z1, 0–65%) so warm-up walks and inter-rep recovery jogs aren't pushed up into the new 65–80% Z1 Easy floor.

**Root cause** (Vigil 4/5): Not a bug — user has 22 Stryd-instrumented runs going back to 2025-12-31, but only 4 fall inside the rolling 30-day count window (most recent before today was 2026-03-27, three days outside the window). Threshold gate was sound; window was just narrow for an athlete with low-but-consistent volume.

**Fix** (Vigil): Decoupled the *count window* (now 60d) from the *metric baseline window* (still 30d). The 30d window remains the statistically relevant horizon for deviation detection — sliding it to 60d would let stale form pollute the baseline. The 60d count just confirms the athlete is "consistent enough for the alert system to be useful" before the alerter activates.

**Prevention**: Two structural things to keep:
1. When aligning the engine to a third-party model, always cross-reference the model's *workout structure* guidance, not just its zone-label nomenclature. Stryd's app calls Z3 "Threshold" but their training guidance reserves *threshold workouts* for the 90–95% subset of Z3 — collapsing the two would have made every "threshold" prescription dramatically too easy or too hard depending on which interpretation Claude picked.
2. When introducing a new field that overlaps with an existing one (HR zone vs power zone), keep them distinct from the start. We almost reused `target_hr_zone` for both display and Stryd-export selection; that would have forced base runs to display as "Z1 HR" (false — they're HR Z2) just to get the right Stryd band on export.

Tests: `tests/engine/workout-builder.test.ts` regrown with band assertions for all 7 working categories at FTP=248. `tests/engine/staleness.test.ts` covers the new 8-rung downgrade ladder. `tests/engine/vigil/integration.test.ts` updated for the new downshift map (intervals → threshold instead of intervals → tempo). 380/380 green after the changes.

## 2026-04-29 — SAST cleanup: cache bound, constant-time bearer, rate limit, security headers

**What happened**: The five accepted findings from the 2026-04-29 deploy (one High, two Medium, two Low) were closed in a dedicated cleanup pass. While re-running SAST after the fixes a new Medium finding surfaced — `handleWorkoutsSuggested` was using the user-supplied `sport` query parameter directly in the cache key, which became reachable now that the cache is bounded but still LRU-evicted on insert. Closed in the same pass.
**Root cause**: Each finding had its own root cause. (1) `src/api/cache.ts` was an unbounded `Map` written to from authenticated read paths. (2) `matchBearer` in `src/api/auth.ts` short-circuited the per-key loop the moment `(client, userId, tokenLen)` failed, leaving a measurable timing channel for "is this (client, userId) configured?" even though the token compare itself was `timingSafeEqual`. (3) Praescriptor and the HTTP API had no rate limit beyond OAuth and the 30 s `/api/refresh` cooldown, so an authenticated tailnet client could amplify intervals.icu and Stryd polls. (4) `CLAUDE.md` echoed a truncated Tailscale auth-key prefix in source-controlled docs. (5) Praescriptor HTML responses were served without CSP/HSTS/`X-Content-Type-Options`/`X-Frame-Options`. (6) The `sport` query parameter flowed unvalidated into the cache key, so an attacker could fill the LRU with crafted long-key entries.
**Fix**: (1) `src/api/cache.ts` now caps at `EXERCITATOR_API_CACHE_MAX_ENTRIES` (default 1000) with LRU eviction on insert and a 60 s `setInterval(...).unref()` prune started from `startApiServer`. (2) `matchBearer` runs all three comparisons (`clientBuf`, `userIdBuf`, `tokenBuf`) for every configured key and aggregates them with bitwise AND; malformed bearers go through a dummy compare so total work is flat. (3) New `src/rate-limit.ts` token-bucket module is shared by both surfaces — separate read/write buckets per `userId`, configurable via `EXERCITATOR_RATE_LIMIT_READ` / `_WRITE` (0 disables for tests), 429 + `Retry-After` envelope. (4) `CLAUDE.md` now points to `praefectura/docs/tailscale.md` instead of echoing the prefix. (5) `src/web/security-headers.ts` exports `applyBaseSecurityHeaders` (every response) and `applyHtmlSecurityHeaders` (HTML pages); the CSP allows inline styles/scripts and Google Fonts because the renderer ships both, locks down `frame-ancestors`/`base-uri`/`form-action`. (6) `handleWorkoutsSuggested` allowlists `sport` to `{Run, Swim, auto}` before composing the cache key.
**Prevention**: Each fix grew a regression test (`tests/api/cache.test.ts`, `tests/rate-limit.test.ts`, `tests/web/security-headers.test.ts`, plus new auth and router cases). The deeper preventative is the workflow note from the previous lessons entry: re-baseline immediately after each accepted-risk deploy and open the cleanup work-item the same day. This time the deploy → SAST diff → cleanup loop completed inside one working session because the baseline `sast-baseline-2026-04-29` was tagged on the deploy commit, so the cleanup-pass diff could prove the fixes were complete with no historical noise.

A second SAST pass after the cleanup deploy surfaced two more findings — a Medium cache-flooding vector via the `tz` query (introduced when `tz` was added to the cache key on the same SAST scanner's earlier recommendation) and a Low DoS where a crafted `tz` cookie reached `localDateStr` and threw a RangeError 500. Both rooted in the pre-existing weak `tz.includes("/")` validation. Closed by lifting strict IANA validation into `src/engine/date-utils.ts` (`isValidTimezone`, backed by `Intl.DateTimeFormat`) and consuming it from both Praescriptor's cookie path and the HTTP API's `tz` query.

Lesson worth keeping: when a remediation extends a cache key with a previously unkeyed user-controlled value, the validator on that value moves from "decorative" (worst case = wrong "today" string) to "load-bearing" (worst case = unbounded cache flood). Tighten the validator at the same time — don't ship the cache change first and harden later.

## 2026-04-29 — Accepted SAST findings deferred to a dedicated cleanup PR

**What happened**: Pre-deploy SAST (`scripts/sast_scan.py --mode diff`) surfaced one new Medium-severity finding (path traversal in the `/api/compliance/confirm` endpoint via the user-supplied `activityId`) and re-surfaced five pre-existing issues in HTTP API / Praescriptor infrastructure that the baseline `sast-baseline-2026-03-29-b` predates.
**Root cause**: SAST diff mode compares against the most recent clean baseline; the HTTP API and Praescriptor compliance routes were rolled out after that baseline was tagged, so all of their unflagged tech debt surfaces on every diff run until a fresh clean baseline is pinned.
**Fix**: Patched the path traversal (`src/web/routes.ts` + `src/tools/suggest.ts` — wrap caller-supplied activity IDs in `encodeURIComponent` before path interpolation) and re-ran SAST. The remaining findings are accepted with the user's explicit consent and tracked for a dedicated cleanup pass:
  1. **High** — Unbounded in-memory cache in `src/api/cache.ts`. Tailnet-only and requires a valid bearer; needs LRU eviction + periodic prune of expired entries.
  2. **Medium** — Short-circuit logic inside `matchBearer` (`src/api/auth.ts`). The token compare itself is `timingSafeEqual` over fixed-length buffers, but the surrounding `&&` chain leaks whether `(client, userId)` matches a configured key. Real but very low impact (userIds are 2 known short strings, `ze` and `pam`, already implicit in the URL space). Refactor to evaluate all three comparisons unconditionally and aggregate with bitwise AND.
  3. **Medium** — No rate limiting on Praescriptor / HTTP API endpoints beyond the OAuth surface and `/api/refresh`'s 30 s cooldown. Tailnet-only mitigates impact, but `force=true` calendar sends and Stryd round-trips warrant per-user buckets.
  4. **Low** — `CLAUDE.md` line 342 prints a truncated Tailscale auth-key prefix (`tskey-auth-kqDKwGVavf...`). Not a usable key, but violates the "no secrets in docs" rule. Replace with a placeholder pointing at `praefectura/docs/tailscale.md`.
  5. **Low** — Praescriptor HTML responses ship without CSP / HSTS / `X-Content-Type-Options` / `X-Frame-Options`. Tailnet-only, but defence-in-depth; add the headers in `handleMainPage`.
A new `sast-baseline-2026-04-29` tag was placed on the deploy commit so future diff scans surface only post-2026-04-29 changes; the cleanup PR will clear these and re-baseline once landed.
**Prevention**: When the SAST baseline tag drifts a long way behind reality (here: a month, including a major HTTP API rollout), every diff scan re-prosecutes pre-existing issues and the deploy team starts treating SAST output as background noise. Re-baseline immediately after each accepted-risk deploy so the next diff scan only flags genuinely new issues, and open the cleanup ticket at the same time so accepted findings don't quietly accrue.

## 2026-04-29 — Run power Z2 lower bound dropped into walk-jog wattage

**What happened**: User reported that today's "Easy Base Run" prescription gave a power band of 173–236 W on a 315 W critical power. They flagged the lower bound as "brisk walk, not runnable" — for a runner whose actual easy run power averages 220–260 W, anything below ~210 W is sub-running effort.
**Root cause**: `workout-builder.ts` derived Z2 endurance as 55–75% of FTP/CP, which loosely matches intervals.icu's stored `icu_power_zones` but is below the running-power model Stryd uses. Stryd's "Easy" ceiling is 80% CP and the user's lowest comfortable run sits at ~72% CP. 55% CP on a high CP collapses into walking territory.
**Fix**: Tightened all run-power bands toward Stryd's published model: Z1 <70%, Z2 70–80%, Z3 80–90%, Z4 90–105%. Updated `tests/engine/workout-builder.test.ts` expectations and the `ZONE_CP_PCT` map in `src/web/stryd-format.ts` so the Stryd workout-export agrees with the engine.
**Prevention**: When reasoning about run-power zones, anchor against the foot-pod's measured easy-run distribution, not against intervals.icu's auto-zone defaults — the latter were inherited from cycling-style zone widths and don't reflect the walk-to-run transition power floor.

## 2026-04-29 — Vigil baseline froze at 2/5 after initial backfill

**What happened**: User saw "Vigil: baseline building (2/5 activities)" on Praescriptor despite having four Stryd-instrumented runs in the last 30 days. Two runs (the Stryd-device uploads from the start of April) were in `vigil_metrics`; the more recent Garmin + Stryd CIQ run and the Apple Watch + Stryd run were not.
**Root cause**: `runVigilBackfillIfNeeded` was gated by `hasAnyVigilMetrics` — it ran the 90-day backfill exactly once, then returned early forever. The only ongoing path that wrote to `vigil_metrics` was `enrichLowFidelityActivities`, which by design only processes Apple Watch native runs that lack CIQ developer fields. Garmin + Stryd CIQ runs and any post-seed Stryd-device upload were structurally invisible to Vigil.
**Fix**: `runVigilBackfillIfNeeded` now runs an incremental 14-day Stryd sync once the seed exists. `processStrydActivity` is already idempotent via `hasVigilMetrics(activityId)`, so the new path is cheap once everything is processed. Debounced to once per UTC day per athlete to keep the Stryd `listActivities` call from firing on every prescription render. Added `tests/engine/vigil/backfill.test.ts` covering first-time vs. incremental, debounce, and the no-client no-op.
**Prevention**: When a one-shot bootstrap step writes to a table that other code paths also need to keep current, audit every long-running write path the next time a metric "froze." Symmetric writes (enrichment) and asymmetric writes (one-time backfill) need an incremental cousin or the table goes stale.

## 2026-03-23 — SAST found five vulnerabilities in initial scaffold

**What happened**: First full SAST scan (Gemini 2.5 Pro) flagged 5 findings: open redirect in OAuth (Critical), global auth lockout DoS (High), unbounded request body (Medium), path traversal via date params (Medium), unbounded session storage (Medium).
**Root cause**: OAuth middleware was ported from internuntius (Python) without applying all the hardening that the original accumulated over time. Date parameters weren't validated. Session management had no limits.
**Fix**: (1) Validate redirect_uri against localhost allowlist. (2) Per-IP lockout instead of global. (3) 64 KiB body size limit on readBody(). (4) Regex date validation + encodeURIComponent on all path-interpolated params. (5) Max 100 sessions + 5-minute idle timeout with periodic pruning.
**Prevention**: SAST scan is mandatory before every deploy. Added date regex validation pattern as standard for all date-accepting tools.

## 2026-03-23 — Claude Desktop connector fails with path mismatches

**What happened**: After deploying to Arca Ingens, Claude Desktop could not connect as a connector. Same issues previously hit in the signifer project.
**Root cause**: Two Claude Desktop behaviours differ from the OAuth/MCP specs: (1) It POSTs to `/` after OAuth completes, not `/mcp` where StreamableHTTPServerTransport listens. (2) It constructs OAuth endpoints as `/authorize`, `/token`, `/register` by appending to the server URL, rather than reading the full paths from RFC 8414 metadata (`/oauth/authorize`, etc.).
**Fix**: (1) Match both `/` and `/mcp` in the MCP request handler. (2) Match both `/oauth/authorize` and `/authorize` (and same for `/token`, `/register`) in the OAuth middleware.
**Prevention**: When implementing MCP OAuth for Claude Desktop connectors, always accept both short and prefixed OAuth paths, and handle `/` as an alias for `/mcp`.

## 2026-03-23 — OAuth token exchange failed: three compounding bugs

**What happened**: Claude Desktop connector completed passphrase entry but failed with "Authorization with the MCP server failed". Three separate issues:
**Root cause**: (1) PKCE verification used `createHmac("sha256", emptyKey)` instead of `createHash("sha256")` — HMAC with empty key produces different output than SHA-256, so every PKCE challenge comparison failed. (2) Registration response included `client_secret` and set `token_endpoint_auth_method: "client_secret_post"` — Claude Desktop expects `"none"` for browser-based auth_code flow. (3) Allowed redirect URIs only included localhost — Claude Desktop uses `https://claude.ai/api/mcp/auth_callback`.
**Fix**: (1) Switch to `createHash("sha256")` for PKCE. (2) Registration returns `token_endpoint_auth_method: "none"`, no client_secret. (3) Added `https://claude.ai/api/mcp/auth_callback` to allowed redirect URIs.
**Prevention**: Always test OAuth with an actual Claude Desktop connector before declaring it working. PKCE S256 is SHA-256, not HMAC-SHA-256.

## 2026-03-23 — intervals.icu rejects YYYY-MM-DD dates for event creation

**What happened**: `create_event` tool returned 422 Unprocessable Entity when passing a date-only string.
**Root cause**: intervals.icu expects a datetime string (`2026-03-24T00:00:00`), not a date-only string (`2026-03-24`).
**Fix**: Append `T00:00:00` to date-only strings in the `create_event` handler before forwarding to the API.
**Prevention**: When interfacing with external APIs, verify the exact format they expect — don't assume ISO 8601 date-only is sufficient even when the parameter is called "date".

## 2026-03-23 — Stale connector state after container rebuild

**What happened**: After deploying a fix and rebuilding the container, Claude Desktop reported every tool returning generic errors — despite the server being healthy and responding to curl.
**Root cause**: Container rebuild invalidated all existing MCP sessions. Claude Desktop cached the previous auth/session state and kept reusing it rather than re-authenticating.
**Fix**: Remove the connector in Claude Desktop Settings → Connectors, then re-add it.
**Prevention**: After any container rebuild that changes the server process, warn users to remove and re-add the connector. This is a Claude Desktop limitation — stale auth state is not automatically cleared on server restart.

## 2026-03-24 — Stale mcp-session-id causes "Server not initialized" after container restart

**What happened**: After container rebuild, the Claude.ai connector kept sending `mcp-session-id` from the previous container. The server's original code created a new `StreamableHTTPServerTransport` for the unknown session and handed it a non-initialize request (`tools/call`). The MCP SDK rejected this with "Bad Request: Server not initialized" because the transport had never received an `initialize` message.
**Root cause**: The session lookup fell through to the "new session" code path, which created a fresh transport. But a fresh transport expects `initialize` as its first message, not `tools/call`. The connector doesn't drop its cached session ID on error.
**Fix**: Added explicit handling for stale session IDs — return HTTP 404 with a JSON-RPC error body before reaching the new-session code path. This is spec-correct per the MCP streamable-http transport specification. The Claude.ai connector does not currently auto-recover from 404 (requires manual reconnection), but the error is now clear instead of cryptic.
**Prevention**: Always check for stale session IDs between the "existing session" lookup and the "new session" creation. Never create a new transport for a request that carries a session ID not in the session map.

## 2026-03-28 — Enriched Stryd uploads not recognised by power source detection

**What happened**: After deploying Stryd FIT enrichment, the run prescription showed "Power field is set to Garmin native but Stryd is connected" with the 0.87 correction warning — despite the FTP being correct (279W from Stryd CP). The enriched activity had `device_name: "STRYD"` and `external_id: "stryd-6151018183557120.fit"`.
**Root cause**: `isStrydNativeRecording()` only matched Apple Watch devices (`/^Watch\d/`) and case-sensitive "Stryd" in `external_id`. The enriched upload used `device_name: "STRYD"` (not a Watch pattern) and lowercase "stryd" in the filename. The function returned false, so `detectPowerSource()` fell through to the "Garmin active but Stryd connected" branch.
**Fix**: Extended `isStrydNativeRecording()` to also match `device_name === "STRYD"` and made the `external_id` check case-insensitive. Also excluded power context warnings from swim prescriptions entirely.
**Prevention**: When adding a new data path (enrichment upload), verify it's recognised by all downstream detection logic. The upload filename format (`stryd-{id}.fit`) was set by the enricher but never checked against the detection patterns. Test with the actual data the system produces, not just the original source data.

## 2026-03-28 — 66–80 readiness band hard-session downshift insufficient (tempo instead of base)

**What happened**: With readiness 68 and a VO2max session yesterday (correctly detected via `icu_intensity: 90.07`), the engine prescribed threshold tempo. The 66–80 band's hard-session downshift only went from `intervals` to `tempo`, not to `base`. Additionally, the `hardSessionGuard` from the #11 fix was blocking the `highPct > 0.4 → tempo→base` rebalancing — a downward shift that would have been protective.
**Root cause**: Two compounding issues: (1) The decision matrix treated the 66–80 band differently from 51–65 — hard session gave `tempo` not `base`, assuming higher readiness meant moderate intensity was acceptable. Physiologically wrong after VO2max. (2) The `hardSessionGuard` was applied symmetrically to both upward and downward rebalancing, but only upward shifts needed blocking.
**Fix**: (1) Changed 66–80 band: `daysSinceHard < 2` now gives `base` (matching 51–65 band). (2) Removed `!hardSessionGuard` from the `highPct > 0.4 && tempo → base` rebalancing path — downward shifts are always safe.
**Prevention**: When designing a decision matrix with protective guards, ensure the guard floor is low enough for the worst-case stimulus (VO2max, race, etc.), not just the average case. And when adding guard flags to rebalancing, consider directionality — blocking downward (protective) shifts defeats the purpose.

## 2026-03-28 — Zone rebalancing silently undid hard-session protection (#11)

**What happened**: After deploying the #9 fix for hard session detection, the engine correctly identified yesterday's VO2max session as hard and selected `base` — then the HR zone distribution rebalancing (`lowPct > 0.7`) bumped it back to `tempo`. The engine prescribed threshold work the day after VO2max intervals, with its own "negative TSB" warning contradicting the prescription.
**Root cause**: The rebalancing logic didn't distinguish why `base` was selected. Two paths lead to `base` in the 51–65 readiness band: (1) genuinely moderate readiness (36–50), (2) protective downshift from a hard session. The rebalancing was appropriate for case 1 but destructive for case 2. This was a silent regression path — the #9 fix appeared to work in unit tests but the downstream rebalancing undid it in production.
**Fix**: Added a `hardSessionGuard` flag (`readinessScore > 50 && daysSinceHard < 2`). When active, `lowPct > 0.7` cannot bump `base→tempo`, and `highPct > 0.4` cannot push `tempo→base` (protects the 66–80 band). The guard only prevents *upward* rebalancing; downward rebalancing (reducing intensity) still applies.
**Prevention**: When a multi-stage pipeline makes a decision (e.g. "select base because hard session"), downstream stages must know the *reason* for the decision, not just the result. A boolean flag is the simplest mechanism. Test the full pipeline path, not just the individual stage.

## 2026-03-28 — Stryd enrichment duplicate caused null icu_intensity and persistent wrong prescription

**What happened**: After Stryd FIT enrichment deployed, both the original HealthFit activity and the new Stryd activity existed in intervals.icu. The enriched activity had `icu_intensity: null` (not yet analysed by intervals.icu), causing `isHardSession()` to miss it. The engine prescribed tempo instead of base despite the #11 hard-session guard fix being deployed.
**Root cause**: The original enrichment used `icu_ignore_time: true` to mark the HealthFit activity, but this left a duplicate visible to intervals.icu's analysis pipeline. Two activities for the same run confused metric computation, delaying or preventing `icu_intensity` calculation on the replacement. The hard-session detection chain (intensity → HR zones → load) was intact, but the input data was incomplete.
**Fix**: Changed enrichment from `PUT /activity/{id}` with `icu_ignore_time: true` to `DELETE /activity/{id}`. The enriched FIT is strictly superior (93KB → 165KB, all developer fields). The SQLite `stryd_enrichments` table preserves the audit trail. Delete failure is caught and logged but doesn't fail the enrichment.
**Prevention**: When replacing one entity with another in an external system, prefer deletion over soft-ignore. Soft-ignore leaves ambiguity that downstream systems may not handle. Always verify the external system has fully processed the replacement before relying on computed fields like `icu_intensity`.

## 2026-03-28 — Apple Watch + Stryd misdetected as Garmin native power (#8)

**What happened**: When recording a run with the Stryd watchOS app on Apple Watch (synced via HealthFit), `detectPowerSource()` incorrectly identified the power field as Garmin native and applied the 0.87 correction factor. FTP was reported as 280 instead of 322, producing artificially low zone targets.
**Root cause**: Stryd on Apple Watch records `power_field: "power"` (lowercase, same as Garmin native) and does not produce CIQ stream markers (`StrydLSS`, `StrydFormPower`, `StrydILR`). The detection logic relied solely on these CIQ markers to identify Stryd. Older Garmin runs in the 5-run lookback window did have CIQ markers, so `athleteHasStryd = true`, which triggered the "Garmin active but Stryd connected (forgot to switch)" branch.
**Fix**: Added `isStrydNativeRecording()` helper — detects Stryd via `external_id` containing "Stryd" + `device_name` matching Apple Watch pattern (`/^Watch\d/`). New branch inserted before the Garmin+Stryd correction branch. Also fixed `getActivityLoad()` to use `power_load` for Stryd native recordings (not just CIQ recordings).
**Prevention**: When adding support for a new recording device/app combination, check all detection signals — don't assume the existing power field naming convention is universal. The intervals.icu API returns `external_id` and `device_name` which together identify the recording source reliably.

## 2026-03-28 — Back-to-back intense sessions prescribed due to narrow hard session detection (#9)

**What happened**: The engine prescribed VO2max intervals (2026-03-27) followed by threshold tempo (2026-03-28) — two intense sessions on consecutive days. The `isHardSession()` function failed to recognise yesterday's VO2max session as hard.
**Root cause**: `isHardSession()` used only two signals: (1) RPE ≥ 7 (was null — not logged), (2) load > 0.7 × sportCtl (threshold was inflated by the Apple Watch power source bug #8, pushing it above all recent loads). A 37-minute VO2max session with `icu_intensity: 90.07` and 64% of time in HR Z4+ was unambiguously hard by any physiological measure, but neither check caught it.
**Fix**: Added two new checks to `isHardSession()`: (1) `icu_intensity > 85` — normalised power as % of FTP, the single best objective intensity indicator. (2) HR Z4+ > 25% of session time — catches high-intensity sessions even without power data. Both fire before the load-based fallback. Ordering: RPE → intensity → HR zones → load.
**Prevention**: When designing heuristics that classify training sessions, always have multiple independent signals. Any single signal can be missing (RPE) or distorted (load via power ecosystem mismatch). The `icu_intensity` field was already available from intervals.icu but not typed or used.

## 2026-03-28 — Test interaction: new isHardSession checks vs hrZoneDistribution rebalancing

**What happened**: Three new workout-selector tests failed because the test data triggered the existing `hrZoneDistribution` rebalancing logic (highPct > 0.4 downgrades tempo→base) or the load-based check with an artificially low sportCtl.
**Root cause**: Tests were constructed to isolate the new `isHardSession()` signals but didn't account for downstream interactions: (1) A VO2max session's HR zones inflated the overall highPct across all activities, triggering the rebalancing. (2) A single activity with load 30 gave sportCtl = 15, making 30 > 0.7×15 = 10.5, so the load check falsely triggered.
**Fix**: (1) Use null HR zones on the VO2max fixture to isolate the intensity signal. (2) Add easy activities to dilute highPct below 40%. (3) Add multiple activities to raise sportCtl so the load check doesn't false-positive.
**Prevention**: When testing one part of a multi-stage pipeline, trace the full pipeline with the test data on paper before writing assertions. Account for all downstream transformations, not just the function under test.

## 2026-03-28 — Stryd API endpoint changed: calendar moved to user-scoped path with epoch params

**What happened**: The Python reference script's `listActivities()` used `GET https://www.stryd.com/b/api/v1/activities/calendar?srtDate=MM-DD-YYYY&endDate=MM-DD-YYYY`. This returned HTTP 430 with `"aid path param must be int64: calendar"` — the API was interpreting `calendar` as an activity ID.
**Root cause**: Stryd migrated their API. The activities calendar endpoint moved from `www.stryd.com/b/api/v1/activities/calendar` (with MM-DD-YYYY date params) to `api.stryd.com/b/api/v1/users/{userId}/calendar` (with `from`/`to` Unix epoch params and `include_deleted`). The old `srtDate`/`endDate` params were silently ignored even on the new endpoint, causing the API to return all 822 activities.
**Fix**: Updated `StrydClient.listActivities()` to use the correct endpoint with epoch-based `from`/`to` params. Discovered via browser dev tools HAR capture.
**Prevention**: When porting from a reference script that calls an undocumented API, always verify the endpoints work before writing tests. Capture a fresh HAR from the web app to confirm current request patterns. Undocumented APIs change without notice.

## 2026-03-28 — Vigil pipeline only ran for exact sport="Run", missing TrailRun/Treadmill

**What happened**: End-to-end review (Chain of Reasoning) found that `suggestWorkoutFromData` checked `sport === "Run"` before running the Vigil pipeline. When the sport selector chose "TrailRun" or "Treadmill", Vigil was silently skipped — no biomechanical monitoring for those activities.
**Root cause**: The initial wiring used a simple string equality check against "Run", not accounting for intervals.icu's run-type variants (TrailRun, VirtualRun, Treadmill). Separately, Stryd stores all activities as `sport = "Run"` in vigil_metrics regardless of intervals.icu's classification, so querying with the exact sport type would return no results for non-"Run" types.
**Fix**: Changed to check against all run types (`["Run", "VirtualRun", "TrailRun", "Treadmill"].includes(sport)`) and normalise to "Run" when calling `runVigilPipeline()`, matching how Stryd data is stored.
**Prevention**: When wiring a subsystem that operates on a sport category (running), always match the full set of sport type variants, not a single string. The `RUN_TYPES` constant in workout-selector.ts already defined this set — should have reused it or defined a shared constant.

## 2026-03-28 — Stryd Duo provides balance percentages, not separate L/R streams

**What happened**: The Vigil spec assumed Duo would provide separate left/right streams (e.g. `StrydL_GCT`, `StrydR_GCT`) based on CIQ naming conventions. Real Duo FIT data contains **balance percentages** instead: `Leg Spring Stiffness Balance` (52.0%), `stance_time_balance` (48.5%), etc. Also discovered field name differences: `stance_time` not "Ground Time", `Impact` (Body Weight) not "Impact Loading Rate", `vertical_oscillation` in mm not cm.
**Root cause**: The spec's bilateral field patterns were marked [UNVERIFIED] and based on guesses from CIQ naming conventions. Stryd's Duo uses a different paradigm — balance is a single percentage representing the left foot's share (50% = symmetric), not paired L/R absolute values.
**Fix**: Wrote a discovery script to download a real Duo FIT and inspect `field_descriptions`. Updated `STRYD_FIT_FIELDS` constants, added `balanceToAsymmetry()` (asymmetry = `|balance - 50| × 2`), and `splitByBalance()` to derive L/R from `total × balance`. Also fixed `vertical_oscillation` mm→cm conversion.
**Prevention**: When designing for hardware you don't yet have data from, always mark field assumptions as unverified and build a discovery step as the first task. The 10-minute script saved hours of debugging incorrect assumptions. For any undocumented sensor API, capture real data before writing production code.

## 2026-03-28 — SSR HTML tests matching CSS class names instead of rendered elements

**What happened**: Vigil render tests checking `not.toContain("vigil-section")` failed even when no Vigil section was rendered. The HTML contained `vigil-section` in the inlined `<style>` block as a CSS class definition, not as a rendered element.
**Root cause**: The `renderPage()` function inlines all CSS into a `<style>` tag. String matching on the full HTML output matches CSS class definitions (`.vigil-section { ... }`) as well as actual rendered elements (`class="vigil-section"`). When testing that an element is *not* rendered, the CSS definition creates a false match.
**Fix**: Added a `htmlBody()` helper that slices the HTML after `</style>`, testing only the rendered body content. Also used more specific selectors (`vigil-header` for element presence) that only appear in rendered output, not CSS definitions.
**Prevention**: When testing SSR output with inlined styles, always strip the `<style>` block before asserting on absence. Alternatively, test for element-specific content (text, attributes) rather than class names that also appear in CSS.

## 2026-03-28 — Module-level const captures env var at import time, not at use time

**What happened**: Vigil DB tests failed with stale data from prior tests despite setting `EXERCITATOR_DB_PATH` in `beforeEach`. The `getVigilMetrics()` function returned 4 rows when only 1 was saved — data from the previous test's DB was leaking through.
**Root cause**: `db.ts` declared `const DB_PATH = process.env.EXERCITATOR_DB_PATH ?? "data/exercitator.db"` at module scope. This evaluates once when the module is first imported, not when `getDb()` is called. Changing the env var in `beforeEach` had no effect — `DB_PATH` was already captured. Even with `_resetDb()` clearing the singleton, the new `getDb()` call used the original path.
**Fix**: Replaced `const DB_PATH` with `function getDbPath()` that reads the env var on each call. Also added `:memory:` guard to skip `mkdirSync` when using in-memory SQLite for tests.
**Prevention**: When a module needs to respect env var changes (especially in tests), never capture the env var in a module-level const. Use a function that reads `process.env` at call time. This is a common ESM/Node.js testing pitfall — modules are cached, consts are evaluated once.

## 2026-03-26 — Tailscale sidecar DNS clash with Docker container name

**What happened**: Praescriptor's Tailscale sidecar returned 502 when proxying to `http://praescriptor:3847`. The container was running and healthy on the Docker network.
**Root cause**: The Tailscale sidecar's `hostname: praescriptor` registered `praescriptor` in Tailscale's MagicDNS, which took priority over Docker's internal DNS. When the sidecar resolved `praescriptor`, it got the Tailscale IP (172.29.28.5 — itself) instead of the Docker container IP (172.29.28.4). Connection refused because the sidecar isn't listening on port 3847.
**Fix**: Renamed the web container from `praescriptor` to `praescriptor-web` (via `container_name: praescriptor-web`). Updated the serve config to proxy to `http://praescriptor-web:3847`. The Tailscale hostname stays `praescriptor` (for the public-facing URL) while the Docker container name is distinct.
**Prevention**: When a Tailscale sidecar uses `hostname: X`, never name the proxied container `X`. Use a different `container_name` (e.g. `X-web`, `X-app`) so Docker DNS and Tailscale MagicDNS don't collide. The existing exercitator setup already did this correctly: `hostname: exercitator` + `container_name: exercitator-mcp`.

## 2026-03-29 — OAuth "wrong password" caused by browser password manager autofill

**What happened**: User reported "wrong password" when authenticating at the OAuth passphrase gate. The passphrase was confirmed correct (copy-paste verified in plain text). curl POST from the command line succeeded (HTTP 302).
**Root cause**: The browser's password manager had `Hotcrumpet3579` (14 chars) saved for `exercitator.tail7ab379.ts.net` and was silently overwriting the clipboard paste with the saved credential. The server expected `praescriptor-fortis` (19 chars). Diagnostic hex logging of the POST body confirmed the mismatch — the browser was sending a value the user never typed.
**Fix**: Changed the passphrase to `Hotcrumpet3579` to match the password manager entry. Added `autocomplete="off"` to the password input to reduce future autofill interference (though browsers may ignore this).
**Prevention**: When debugging "wrong password" issues where the user insists the input is correct, add server-side diagnostic logging to see what was actually received. Password manager autofill on `<input type="password">` fields is invisible to the user and can override clipboard paste. The `autocomplete="off"` attribute is a best-effort mitigation — not all browsers respect it.

## 2026-03-29 — IntervalsClient.athleteId "0" is an alias, not a unique identifier

**What happened**: Per-user Vigil isolation (athlete_id column in vigil_metrics/baselines) was ineffective — both Ze and Pam resolved to `client.athleteId = "0"`, so Ze's Vigil data blocked Pam's 90-day backfill.
**Root cause**: intervals.icu treats athlete ID `"0"` as a convenience alias meaning "the athlete owning this API key". Two different API keys both resolve to `"0"` locally, even though they represent different athletes server-side. Using `client.athleteId` as a DB partition key created a collision.
**Fix**: Use `profile.id` ("ze", "pam") as the Vigil athlete_id instead of `client.athleteId`. The profile ID is stable, unique, and doesn't depend on intervals.icu API semantics.
**Prevention**: When partitioning local data by user, never use an external API's convenience aliases as partition keys. Use the application's own unique identifiers (profile IDs, slugs, UUIDs) that are guaranteed distinct.

## 2026-03-29 — Apple Watch native power misclassified as Garmin with Stryd correction

**What happened**: When an athlete ran with just an Apple Watch (no Stryd pod), the power source was classified as "Garmin native with Stryd connected", applying a meaningless 0.87 correction factor to Apple's wrist-accelerometer power estimate.
**Root cause**: Apple Watch and Garmin both report `power_field: "power"` (lowercase). The detection logic only distinguished them by checking for Stryd CIQ streams (`StrydLSS`, etc.) in the history, not by checking the device type of the most recent run. An Apple Watch run with `athleteHasStryd = true` (from older runs) hit the Garmin+Stryd correction branch.
**Fix**: Added an Apple Watch native detection check before the Garmin+Stryd branch. When `isNonGarminDevice(mostRecentRun)` is true and it's not a Stryd native recording, look past it to find the most recent Stryd-powered run. If none exists, return `source: "none"`.
**Prevention**: When classifying device ecosystems, check the specific device of the activity in question, not just the athlete's historical data. Different devices from the same athlete can produce fundamentally different data.

## 2026-03-29 — Stryd has an undocumented workout API

**What happened**: Research suggested Stryd had no public API for pushing workouts. A HAR capture of the PowerCenter web UI revealed a full REST API for creating, scheduling, and deleting structured workouts.
**Root cause**: Stryd's API is not publicly documented. The only way to discover it was traffic analysis.
**Fix**: Reverse-engineered three endpoints: `POST /workouts` (create), `POST /users/{id}/workouts?id=&timestamp=` (schedule on calendar), `DELETE /users/{id}/workouts/{calendarId}` (remove). Power targets use CP% — maps directly to our zone model. Auth is the same Bearer token from the existing login endpoint.
**Prevention**: When a vendor's public documentation says "no API", check the web UI's network traffic. Modern SPAs almost always have a REST/GraphQL API behind them. HAR captures are the fastest way to map undocumented APIs.

## 2026-04-01 — Doubled repeat count in swim prescriptions (#24)

**What happened**: Swim prescriptions displayed "4×4×200m" — the repeat count appeared twice in the UI and intervals.icu workout text.
**Root cause**: All swim builders embedded the rep count in `target_description` (e.g. "4×200m Z2") while also setting the `repeats` field. The rendering layer prepended `repeats`, producing doubled output.
**Fix**: Stripped the `N×` prefix from `target_description` in all swim and run builders. The `repeats` field carries the count structurally.
**Prevention**: When a segment has both a structured field (`repeats`) and a human-readable description (`target_description`), the description should describe the work interval only, not include structural data that the renderer will add.

## 2026-04-01 — intervals.icu parser treats `m` as minutes, not metres

**What happened**: Swim workouts sent to intervals.icu parsed incorrectly — "200m" was interpreted as "200 minutes". The downloaded workout JSON showed only 4 bare steps with no distances.
**Root cause**: The intervals.icu workout text parser uses `m` for minutes and `mtr` for metres. Our format used `200m` (minutes), not `200mtr` (metres). Also: repeat blocks need blank lines before/after, rest needs an intensity target (not just the word "rest"), and pace needs a `Pace` suffix.
**Fix**: Rewrote `buildIntervalsDescription` for swim: `mtr` for metres, `Pace` suffix, blank lines around repeats, `50%` for rest. Swim uses `target_description` directly for distance-based steps.
**Prevention**: When generating text for an external parser, always verify against the parser's documentation — don't assume units match common conventions. Download and inspect the parsed result to confirm structure.

## 2026-04-02 — Readiness scoring: five compounding bugs inflated scores by ~8 points

**What happened**: Athlete with suppressed HRV (73% of baseline), poor sleep (5h58), and Oura readiness of 51 got a readiness score of 49 and was prescribed long sessions for both run and swim. Should have been ~42 with base sessions.
**Root cause**: Five issues: (1) Oura readiness (0–100) treated as 0–10 scale, always clamping subjective component to 100. (2) Sleep warning only fired below score 60 — too lenient. (3) No multi-night sleep trend detection. (4) HRV cliff at 75% of mean — anything below scored 0, losing gradient information. (5) Long session trigger gate at readiness 45 — too low for fatigued athletes.
**Fix**: (1) Use readiness directly as 0–100. (2) Raise sleep warning to < 70 and sleepScore < 75. (3) Add 3-night trend check. (4) Extend HRV gradient to 0.6 (score 0) through 0.75 (score 20). (5) Raise long gate to 60 + add HRV guard (component < 30 blocks long).
**Prevention**: When integrating data from wearable APIs (Oura, Garmin), verify the scale of each field against the API documentation — don't assume all numeric fields use the same range. When designing readiness thresholds, test with real athlete data at various fatigue levels, not just synthetic fixtures. The subjective scale bug went unnoticed for weeks because tests used neutral defaults.

## 2026-04-03 — Staleness cleared by a single session after 68-day break

**What happened**: Athlete swam once (04-01) after a 68-day break from swimming. The staleness check saw "last swim 2 days ago" and returned normal tier. The system prescribed a distance swim (long category) — inappropriate for a return-to-sport athlete.
**Root cause**: Staleness only checked "days since last activity in this sport", not the frequency of recent sessions. A single session after months off immediately cleared the staleness flag.
**Fix**: Added a minimum session count (3 in the 14-day window) for "normal" tier. Fewer sessions with a recent date get "moderate" tier with a "Return to sport" warning and pace buffer. This naturally downgrades the category and prevents aggressive prescriptions.
**Prevention**: When designing a "recency" check, consider both the date of the most recent session and the *density* of recent sessions. A single data point shouldn't override a pattern of absence.

## 2026-04-03 — Sleep warnings were advisory-only, didn't influence prescriptions

**What happened**: Athlete had 3+ nights of poor sleep (jet lag, London→Oakland), readiness score showed sleep warnings, but the system still prescribed tempo (threshold) running. The warnings were decorative — they informed but didn't protect.
**Root cause**: The sleep trend detection ran in `computeReadiness` and added warning strings, but the resulting score (which incorporates sleep as only 20% weight) could still be high enough for tempo. No mechanism existed to feed the sleep debt signal back into category selection.
**Fix**: Added `sleepDebt: boolean` to `ReadinessResult`, set when 3+ recent poor nights detected. Threaded through to `selectWorkoutCategory` where it caps category at base — overrides tempo/intervals/long regardless of readiness score.
**Prevention**: When a system generates warnings about a dangerous condition, consider whether those warnings should also trigger protective behaviour, not just inform the user. Advisory-only warnings are insufficient when the system can act on them.

## 2026-04-04 — Swim workout steps silently dropped by intervals.icu parser

**What happened**: Swimming prescriptions sent to intervals.icu were missing the warm-up and main set steps — only the drill repeats and cool-down appeared. The 200m warm-up and 400m pull main set were silently dropped.
**Root cause**: Two issues. First, cue text from `target_description` (e.g. "easy free, Z1", "pull Z1") was placed before the distance in the step line, confusing the parser — commas and zone-like text (`Z1`) were misinterpreted. Second and more critically, pace targets used `/100mtr Pace` but intervals.icu only recognises `/100m` as a valid pace denominator. The `mtr` suffix is exclusively for bare distance values (`200mtr`), not pace unit denominators. Steps with unrecognised pace format were silently dropped.
**Fix**: (1) Removed cue text from step output — step lines now contain only `[name] [distance]mtr [pace]/100m Pace`. (2) Changed pace format from `/100mtr Pace` to `/100m Pace`.
**Prevention**: When integrating with external parsers, read the spec carefully and distinguish between similar-looking formats in different contexts (`mtr` for distance vs `m` for pace denominators). Test by verifying the external system actually rendered the output, not just that the HTTP request succeeded. Silent parse failures are the hardest bugs to catch.

## 2026-05-02 — Swim threshold_pace unit mismatch: m/s read as s/m, paces went the wrong way

**What happened**: Athlete asked the engine to align prescribed swim paces with a measured CSS of 0.94 m/s (1:46/100 m) computed length-by-length from FORM goggles streams (drills excluded by cadence). Updating intervals.icu's `threshold_pace` from 1.0309 to 0.94 m/s caused the DSW to prescribe **faster** paces (Z3 1:44 / Z4 1:38) instead of slower ones, even with the +10 s return-to-swim buffer.
**Root cause**: `swimPaceDesc` in `src/engine/workout-builder.ts` computed `cssPer100m = threshold_pace * 100`, with a comment claiming intervals.icu stored the value in seconds-per-metre. intervals.icu actually stores `threshold_pace` in metres-per-second (matching the `average_speed` and `pace` fields on activity payloads, and consistent with `pace_zones` semantics where percentages are of threshold *speed*). The correct conversion is `100 / threshold_pace`. The bug stayed hidden because the original athlete's threshold_pace was ~1.0, where `x * 100` and `100 / x` collide near 100. As soon as `x` deviated, the formula diverged in the wrong direction. Tests at `tests/engine/workout-builder.test.ts:29-128` cemented the bug by asserting the wrong arithmetic against the wrong unit interpretation.
**Fix**: Replaced the formula with `100 / settings.threshold_pace`, added a positivity guard, and rewrote the comment to document the m/s convention. Updated existing test fixture comments and added two regression tests: one with a slower swimmer (`0.94 m/s` → `1:46/100m`) verifying correct direction of change, and one with `null`/`0` confirming graceful no-pace fallback.
**Prevention**: When integrating a numeric field from a third-party API whose unit is not encoded in the type system, cross-check the unit against at least two related fields (here, `average_speed` and `pace_zones` both confirmed m/s). Don't trust a code comment over the actual API behaviour. **Also flagged**: the running pace builders (`buildRunRecovery`/`Base`/`Tempo`/`Intervals`/`Long`) apply `threshold_pace * <multiplier> + paceBufferSecs/1000` patterns that look similarly suspect — they're dead code today because Stryd users have `Run.threshold_pace = null`, but should be audited before any non-Stryd runner is onboarded.

## 2026-05-03 — push-to-stryd response type drift between 200 and 409

**What happened**: Excubitor's iOS client failed to decode 200 and 409 bodies from `POST /api/users/:userId/push-to-stryd`. Spec example showed `calendar_id` as a string; server emitted a number. Investigation surfaced a deeper bug — the 200 path emitted `workout_id` as a number (direct from `StrydClient.createWorkout`) while the 409 path emitted it as a string (read straight from SQLite where it had been stored via `String(workoutId)` for the generic TEXT `external_id` column).

**Root cause**: Storage-path coercion (`send-stryd.ts:77` — `String(workoutId)`) was never reversed at the response-path read-back (`:38`). The 200 path never persisted-then-rebuilt, so the type drift was invisible to anything that exercised only the happy path. Spec example showing string `"abc123"` masked the disagreement during review.

**Fix**: `src/web/send-stryd.ts:38` — coerce on read-back: `workout_id: existing.externalId ? Number(existing.externalId) : null`. Spec §2.1.3 corrected to numeric on both paths plus typed field table.

**Prevention**: New vitest covering the type contract on both 200 and 409 paths of the push-to-stryd endpoint. Future re-stringification regresses with a failing assertion. General lesson: storage-format coercion at write time should always be reversed at the response boundary, or the storage layer should hold the canonical type and downstream callers convert at the edges only. The 200/409 type-drift smell ("two response paths construct overlapping fields from different sources") deserves a checklist item in any new endpoint review.

## 2026-05-08 — Run prescriptions emitting %FTP and HR fallback instead of absolute watts

**What happened**: Today's tempo prescription pushed to intervals.icu rendered as `- 6m40s 72-82% HR` for warmup, `- 6m 80-90%` for main work, `- 3m 50%` for inter-rep recovery, `- 3m20s 50-72% HR` for cooldown. The user wanted absolute watts everywhere (e.g. `- 6m 229-257W`, recovery `- 3m 186-229W`). Separately the user reported that the dashes "wouldn't render" until they manually replaced them in the intervals.icu web UI — initially read as a unicode bug in our formatter.

**Root cause**: Two issues, one in our code and one not.
1. `formatRunTarget` (`src/web/intervals-format.ts`) emitted `${lowPct}-${highPct}%` whenever an explicit power band was set, falling back to HR when the segment lacked `target_power_low/high` (warm-up and cool-down in `workout-builder.ts` only carry `target_hr_zone`). The repeat-block recovery line was hard-coded to `50%`. So the natural code path produced exactly the mixed-unit format the user complained about.
2. The em-dash claim turned out to be unrelated. Hex-dumping the stored description directly from intervals.icu's API showed all bytes were ASCII (every dash was `0x2D`). The auto-correct happens in intervals.icu's web editor when a human edits the description — typing or pasting a hyphen there can be silently converted to en/em-dash, which then breaks the parser. Programmatic writes from `sendToIntervals` are unaffected.

**Fix**: `src/web/intervals-format.ts` (commit `7d575b2`):
- `formatRunTarget` now returns `${low}-${high}W` from `target_power_low/high` whenever `power.source !== "none" && power.ftp > 0`.
- Segments without explicit watts but with FTP available synthesise a Stryd Z1 Easy 65–80% CP band via a new `easyZ1Watts(ftp)` helper — covers warm-up / cool-down.
- New `formatRunRestTarget(power)` produces the same Z1 Easy band for inter-rep recovery; `50%` remains the no-FTP fallback.
- HR fallback retained when `power.source === "none"`.

**Prevention**:
- New vitest case `tests/web/intervals-format.test.ts` pins the canonical tempo workout output line-for-line (`Warm-up`, `- 6m40s 163-200W`, `2x`, `- 6m 200-225W`, `- 3m 163-200W`, …) plus an explicit ASCII-only assertion: `expect(text.charCodeAt(i)).toBeLessThanOrEqual(0x7f)` over every byte of the description. Any future stray en/em-dash, smart quote, or NBSP introduced by code changes fails the assertion immediately.
- Memory note added in `reference_intervals_icu.md` documenting the intervals.icu UI auto-correct so the next debugging session doesn't repeat the "is our formatter outputting unicode?" goose chase. The diagnostic move is to fetch the stored description over the API and check the bytes — never trust a paste-back, which may itself be normalised by the terminal or shell.
- General lesson: when a user reports a rendering bug in someone else's UI, dump the bytes our system actually sent before assuming our system is at fault. Hex evidence settles it in one tool call.

## 2026-05-25 — Stryd recommendation integration: float-vs-int FTP drift broke replay determinism

**What happened**: A full session built the Stryd-recommendations integration (Phases 0 → 6 plus push-back, PATCH-on-send, and Promus DSW logging). After shipping, the user spotted a 1 W discrepancy between the live API output (`286–314W` for a 100–110 % CP band) and a replay reconstruction from the stored Promus DSW row (`286–315W` for the same workout). Same workout id, same `intensity_percent`, same nominal FTP — different bands.

**Root cause**: precision drift across layers.
- Stryd returns raw CP as a float: `285.86459663675254`.
- The engine rounds CP to integer at `src/engine/suggest.ts:171` (`powerContext.ftp = Math.round(strydCp.cp)` → `286`). Every API response, every downstream consumer, sees FTP = 286.
- But `applyStrydRecommendation` was called with the *raw float* `strydCp.cp`, so band computation ran as `Math.round(110 % × 285.86) = 314`. The engine reported FTP = 286 to consumers while emitting segments computed from 285.86. Internal inconsistency.
- Replay reads the stored `cp_or_ftp = 286` (the integer the engine had advertised) and computes `Math.round(110 % × 286) = 315`. Diverges from the live emission.

**Fix**: `applyStrydRecommendation` now reads `suggestion.power_context.ftp` (the integer) internally. The `ftp` parameter is dropped from both that function and its `applyStrydSwapIfEnabled` wrapper. Three callers updated; integer FTP threads through every consumer. Replay verified byte-equal to live emission post-fix.

**Prevention**:
- General principle: when a value has multiple representations across layers (raw upstream value, rounded engine value, persisted JSON value), **pick the rounded representation as the canonical one and thread it through every consumer**. Don't compute downstream values from one representation while reporting another. The float CP is fine for engine-internal use (load calculations etc.) but the segment band computation needs to use the same FTP that's reported on the wire.
- Verification recipe: read a stored DSW row directly from Promus (or any persistence layer), reconstruct via the same code paths a live request would take, content-hash both, expect equality modulo metadata timestamps. This catches precision drift in a single command. Saved at `phase2/external-coach-integration-playbook.md` § Phase 7.

## 2026-05-25 — Stryd integration: TZ bug in `scheduleWorkout` landed pushes on the wrong day

**What happened**: After the round-trip push verification succeeded (API returned `success: true, calendar_id: …`), the user couldn't see the pushed workout on Stryd's calendar for today. Direct query of Stryd's calendar via the existing client showed the entry didn't exist where expected.

**Root cause**: `src/stryd/client.ts:scheduleWorkout` called `d.setHours(0, 0, 0, 0)` on the date before computing the Unix timestamp. `setHours` operates in the JS runtime's *local* TZ — UTC inside the production container. A 14:00 PDT (= 21:00 UTC) push computed midnight UTC = 2026-05-25T00:00:00Z = **2026-05-24T17:00:00-07:00** in ze's TZ. Stryd interpreted the timestamp in user TZ and scheduled it on the 24th, not the 25th.

**Fix**: drop the `setHours` floor. Use the actual current moment (or whatever the caller passes). Stryd renders the timestamp in the user's profile TZ; for a push happening during the user's local daytime, "now" always renders as "today". Re-tested: `21:00 UTC` push landed correctly on 2026-05-25 PDT.

**Prevention**:
- Never use `setHours(0,0,0,0)` on Date objects intended to be interpreted in a foreign TZ. The function operates in the runtime's local TZ, which in container deployments is UTC. Affects anyone deploying to a UTC container who serves users west of UTC.
- General test recipe for any "schedule on external calendar" path: trigger the push from the production container, then *visually* verify the external system shows the right local day. API success codes are necessary but not sufficient.
- Long-standing latent bug — would have hit any user west of UTC for any push happening after their local 17:00. Likely benign for users east of UTC where local midnight in UTC is even further "earlier" in their day. Documented at `phase2/external-coach-integration-playbook.md` § Phase 5.

## 2026-05-25 — SAST iteration spiral: when to stop

**What happened**: Each defensive cap added to `src/web/stryd-swap.ts` (block.repeat bounds, segments-per-block, total expanded segments, segment duration components, malformed duration_time object, etc.) triggered Gemini's diff-mode SAST to find the *next* unbounded surface. Seven iterations before stabilising at `NO_FINDINGS`. Most findings were theoretical — the actual exploit was already bounded by the upstream 1 MB JSON cap in `parseBoundedJson`.

**Root cause**: Gemini's diff-mode bundle includes only changed files, not upstream defences. It repeatedly flags "unbounded loop X" without seeing that the JSON cap means X is structurally bounded to <100 000 iterations.

**Fix**: stop iterating once the practical exploit is bounded by an existing structural defence. The 1 MB JSON cap caps every unbounded-loop variant; further defensive caps are belt-and-braces, not load-bearing.

**Prevention**:
- Per-deploy SAST budget: **fix Critical + High; accept Medium / Low with explicit rationale once the structural defence is in place.** Document accepted findings in the commit message or SECURITY.md.
- Don't iterate more than 2-3 rounds on the same code path — Gemini's diff bundle excludes upstream context and will repeatedly flag theoretical issues that the surrounding code already addresses.
- If a finding cites a function in the bundle but the defence lives in an upstream module *not* in the bundle, write the rationale in plain English and accept. Codified at `phase2/external-coach-integration-playbook.md` § SAST iteration management.

## 2026-05-26 — FORM deploy: docker-compose.yml didn't forward FORM_* env vars

**What happened**: Shipped the full FORM swim integration (38 files, +4664/−88 LOC, 552 tests green) and the deploy was clean — three health endpoints OK, SAST `NO_FINDINGS`, new baseline tagged. User added `FORM_EMAIL`/`FORM_PASSWORD` to Cogitator's `.env` and restarted containers. Dashboard still showed the engine-built "Threshold Swim" with no Source chip. The live JSON had `prescriptionSource: null` on the swim — the FORM swap gate was failing silently.

**Root cause**: `docker-compose.yml` only forwarded the `STRYD_*` and `PROMUS_*` env vars to the containers. `FORM_EMAIL`, `FORM_PASSWORD`, `FORM_CACHE_PATH`, and `PROMUS_FORM_DSW_ENABLED` were never declared in the `environment:` blocks, so the values existed on the host `.env` but never reached the Node process. The FormClient builder in `web/server.ts` therefore saw `process.env.FORM_EMAIL === undefined` and logged `"Ze: FORM credentials not set — swim swap disabled"` — which I would have spotted earlier if I'd tailed startup logs before declaring victory.

**Fix**: added FORM_EMAIL, FORM_PASSWORD, FORM_CACHE_PATH, PROMUS_FORM_DSW_ENABLED to both the `exercitator` and `praescriptor` services in `docker-compose.yml`. Default FORM_CACHE_PATH points at `/app/data/form-oauth.json` so OAuth tokens survive container restarts via the existing `exercitator-data` volume (no new volume needed). Rebuilt, swim card now shows `Source: FORM · Better As You Go`.

**Prevention**:
- Every new env var needs a paired docker-compose forwarder. **Pre-deploy checklist for any new credential env**: (1) `.env.example` updated, (2) `docker-compose.yml environment:` block updated for every consuming service, (3) post-deploy log tail confirming the startup log line you wrote in the code actually appears.
- The "client ready" / "credentials not set" startup log line was the lifesaver here. Every external-vendor client startup should emit one log line, success-or-skip — silent-skip is the worst failure mode.
- Generalise: when a new piece of code reads `process.env.X`, search `docker-compose.yml` for `X` before commit. Codify in the external-coach-integration-playbook.

## 2026-06-02 — Fallback-chip deploy: diff SAST surfaced a pre-existing inlined-script XSS

**What happened**: A small change to humanise the Praescriptor fallback source-chip (raw slug `stride_rejected_on_recovery` → plain English) touched `src/web/render.ts`. The `--mode diff` SAST scan therefore brought the whole file into scope and flagged a Medium XSS: `clientJs` server-interpolated the user slug into single-quoted `fetch()` path strings (`'${prefix}/api/…'`). A second run then flagged a Low `prompt()` social-engineering vector in the compliance picker.

**Root cause**: pre-existing code. `clientJs` built the API prefix by raw-interpolating `userId` into emitted JS string literals. Not exploitable today — `getUserProfile` whitelists the slug to `ze`/`pam` and anything else 404s before render — but a defence-in-depth gap that the diff scan correctly surfaces whenever the file is edited.

**Fix**: emit the slug as a JSON literal (`const __userId = ${JSON.stringify(userId)}`) and build `prefix` + all 8 API paths via client-side concatenation — safe by construction regardless of input. Added 4 vitest cases in `tests/web/source-chip.test.ts` locking the JSON-literal encoding and break-out resistance. The Low `prompt()` finding was accepted-risk per the 2026-05-25 SAST-stop discipline (narrow threat model, backend `^[A-Za-z0-9_-]{1,64}$` allowlist rejects the payload, tailnet-only) and tracked as a GitHub follow-up for a DOM-picker replacement; recorded in SECURITY.md § Outstanding.

**Prevention**:
- Inlined client JS must treat every server-supplied value as data: `JSON.stringify` into a `const`, then concatenate — never interpolate a bare value into an emitted JS string literal. Applies to any future `clientJs`-style helper.
- Reaffirms the 2026-05-25 rule: on a diff-SAST that surfaces pre-existing issues in a touched file, fix High/Medium that have a clean fix, explicitly accept Low with rationale + a filed follow-up, and stop — don't let one file's edit balloon into an open-ended audit.

## 2026-06-03 — intervals.icu Oura-sync logged an 18-minute "night", suppressing a real prescription

**What happened**: ze's run prescription read `readiness_score: 58` with a warning `Sleep below 7 hours (0h18m)`, and the engine downgraded the day to `base`/easy — diverging from what Stryd's app offered (a 26-min fartlek, "Dash & Dine"). The 18-minute figure was wrong: ze had slept normally. By the time we pulled the live wellness record, intervals.icu showed `sleepSecs: null` for all seven days, yet the same records carried Oura-derived `hrv`/`restingHR`/`avgSleepingHR`/`spo2` — so Oura was syncing physiology but the *sleep-duration* field was mis-mapping (a fragment landing as "main sleep", then nulled on the next sync).

**Root cause**: the readiness engine's Sleep + HRV components sourced from intervals.icu wellness (`/athlete/{id}/wellness`), whose sleep field is populated by Oura's direct-API sync. That sync is outside our control and demonstrably unreliable for sleep duration. A single bad nightly value flows straight into `computeSleep` and silently caps the day's prescription.

**Fix**: moved the Sleep + HRV readiness components to the in-house Promus WHOOP strap feed for `healthSource: "promus-whoop"` users (ze). New `src/promus/client.ts` (stateless bearer client) + `src/health-source.ts` (per-profile options builder) + `NightlyHealth` plumbed through `fetchTrainingData` → `computeReadiness`. WHOOP `duration_s` drives duration-based sleep; `rmssd_median_ms` drives HRV-vs-7-day-mean. TSB/Recency/Subjective still come from intervals. When today's WHOOP night is missing (strap not synced) or Promus is unreachable, the suggestion hard-fails with `status: "health_unavailable"` rather than prescribing from degraded inputs. A regression test (`tests/engine/readiness.test.ts`) asserts a poisoned `sleepSecs: 1080` no longer reaches the Sleep component when WHOOP health is present.

**Prevention**:
- A readiness input whose provenance is a third-party sync we don't control (Oura→intervals) is a latent single point of failure. Where an in-house equivalent exists (Promus WHOOP), prefer it and hard-fail loudly on absence rather than degrade silently.
- `WHOOP_SERIAL` is a new env var — added to `.env.example` AND both `docker-compose.yml` service `environment:` blocks per the 2026-05-26 docker-compose-forwarder rule. Confirm the `"Promus client ready"` / `"…falls back to intervals"` startup log line after deploy.
- Strictest staleness policy was chosen deliberately (require today's night): a morning prescription before the strap syncs will block. If that proves too aggressive in practice, relax to "transport error OR stale >2 days" — the knob lives in `fetchHealthTelemetry`.

## 2026-06-03 — WHOOP source: score moved, but the API readiness DTO + a sport-recency gap didn't follow

**What happened**: After the WHOOP health-source deploy, the Nunc (Excubitor) "Exercitatio" tab showed **HRV: unknown, Sleep: unknown, Readiness: 71** while the dashboard showed **75**. Three distinct causes: (1) `readinessFromEngine` (the HTTP `/status` + `/dashboard` DTO builder) derived the HRV/Sleep *component badges* from `data.wellness` (intervals — now null for ze), so they read "unknown" even though the readiness *score* used WHOOP. (2) `/status` fetched its window with `tz: undefined`, computing the WHOOP 7-day window in container-UTC rather than the athlete's tz. (3) Pre-existing: the status-block readiness omitted `sport`/`ftp`, so its `recency` component was whole-athlete (counting a recent cross-training session) while the prescription header used same-sport recency (100 — no recent *run*), a ~7-point gap.

**Root cause**: when changing the *source* of a derived value, I updated the headline computation (`computeReadiness` score) but not the parallel DTO path that re-derives the same signals for display (`readinessFromEngine`) — and didn't audit that every readiness call site passed the same inputs. The score and its component badges had two independent code paths reading two different sources.

**Fix**: `readinessFromEngine` now takes `NightlyHealth[]` and reads HRV/Sleep badges from WHOOP when present; `/status` resolves the athlete tz (handler gained the `url` arg → `resolveTz`); both status blocks now pass the same `{ sport: primarySport, ftp: strydCp, health }` the prescription uses, so all surfaces show one number. 2 payload tests + updated status handler test.

**Prevention**:
- When you change the source feeding a metric, grep for EVERY place that re-derives or re-displays that metric — not just the canonical computation. Score and badge, header and DTO, web and native client are separate code paths; a source swap must update all of them in one change.
- Any two surfaces that show "the same" number must call the shared computation with identical inputs. `computeReadiness` takes `{ sport, ftp, health }`; omitting any of them silently produces a different number. Prefer passing the full input set everywhere, or compute once and reuse.

## 2026-06-03 — Soreness/fatigue read on a 0–10 scale, but intervals.icu stores 1–4

**What happened**: ze flagged soreness as "high" in intervals.icu, yet the HTTP API `/status` readiness block badged soreness (and fatigue) as `"ok"`. Live wellness showed `soreness: 3` and `fatigue: 3` for 2026-06-02/03. The qualitative dropdown (low/avg/high/extreme) stores integers 1–4, so "high" = 3.

**Root cause**: both consumers assumed a 0–10 scale. (1) The API badge logic `value >= 6 ? "low" : "ok"` (`src/api/payload.ts`) — with a 1–4 domain the `>= 6` branch is unreachable, so soreness/fatigue could *never* badge `"low"`. (2) The subjective readiness component `(10 - value) * 10` (`src/engine/readiness.ts`) — "high" (3) mapped to 70, *above* the 50 neutral, so self-reported soreness/fatigue **raised** readiness and the `subjective < 40` warning essentially never fired. The wrong scale was also baked into a stale memory note and the `update_wellness` tool's field descriptions (1-10).

**Fix**: badge flags `"low"` at `>= 3` (high/extreme); the subjective component inverts via `((4 - value) / 3) * 100` (low=1→100, avg=2→67, high=3→33, extreme=4→0). Updated the `update_wellness` tool descriptions to state the 1-4 scale, and corrected the `reference_intervals_icu` memory. Two existing tests encoded the old assumption (a payload test asserting `soreness: 3` → `"ok"`, a readiness test using out-of-range `fatigue: 8`) and were corrected. Added 4 readiness + 3 payload vitest cases pinning the 1–4 mapping and the warning trigger.

**Prevention**:
- When a field's provenance is a third-party UI with a fixed-vocabulary control (dropdown/segmented picker), confirm the integer encoding against a *live* record before writing threshold logic — don't infer the numeric range from the field name or a units-style guess.
- A threshold that can never be reached within a field's actual domain is a silent dead branch. When the domain is small and known, sanity-check that each output (`"low"`/`"ok"`) is reachable.
- Subjective inputs that influence readiness must move it in the intended *direction*: a regression test now asserts higher soreness/fatigue lowers the score, which would have caught the inverted mapping immediately.

## 2026-06-03 — Stryd push pushed the "Health telemetry unavailable" placeholder, computed in UTC

**What happened**: A "Send to Stryd" from the Praescriptor dashboard (ze, tz `America/Los_Angeles`) at 21:10 PDT wrote a junk entry to the Stryd calendar — `title: "Health telemetry unavailable"`, `type: "rest"`, `blocks: null`, desc "WHOOP has not synced last night's sleep yet". The dashboard had rendered a real workout; the push sent the health-unavailable card instead.

**Root cause**: `sendToStryd` (`src/web/send-stryd.ts`) regenerated the prescription with `generatePrescriptions(client, profile)` — omitting both `tz` and `strydClient`, unlike the already-fixed `sendToIntervals`. With `tz` undefined, `localDateStr(new Date(), undefined)` defaults to **UTC**; at 21:10 PDT, UTC is already the next day, so the regen computed "today" = 4 June, the WHOOP day-cache key missed (dashboard cached 3 June), and `fetchHealthTelemetry` looked for the night of 4 June — which hadn't happened — returning `whoop_today_missing` → `status: "health_unavailable"`. Compounding: neither send path guarded `suggestion.status`, so the placeholder was serialised by `toStrydWorkout` and pushed. The same call also dropped the Stryd swap (missing `strydClient`), a latent second bug masked here because the health-unavailable status short-circuits the swap.

**Fix**: `send-stryd.ts` forwards `strydClient` and `tz` to `generatePrescriptions` (mirroring `sendToIntervals`). Both `sendToStryd` and `sendToIntervals` now refuse any suggestion whose `status` is set and not `"ready"` with a `422 { not_sendable, status, message }` (422 not 409 — the web client auto-retries 409 with `?force=true`, which would loop). Junk Stryd entry `5772855098114048` deleted. 5 new vitest cases.

**Prevention**:
- Any function that calls `localDateStr` / `fetchTrainingData` / `generatePrescriptions` must thread the athlete `tz` through — a missing `tz` silently means container-UTC, which diverges from every tz-aware surface after local-evening (west of UTC) or before local-morning (east). This is the **third** UTC-vs-athlete-tz defect (cf. the 2026-06-03 `/status` window and the WHOOP 18-minute-night entries). When a function recomputes something a tz-aware caller already produced, it must take the same `tz`.
- Test A (`tests/engine/health-telemetry.test.ts`) pins the exact incident: the same instant yields success in `America/Los_Angeles` and `whoop_today_missing` in UTC.
- A "send" surface must never serialise a non-`ready` suggestion. The web render has dedicated cards for `awaiting_input` / `already_trained` / `health_unavailable`; the send paths now have an equivalent guard. When one surface gains a new non-prescription status, every surface that consumes the suggestion must handle it — not just the renderer.
- When fixing a bug in one of a pair of parallel functions (`sendToIntervals`/`sendToStryd`), apply the fix to both in the same change. The `tz`+`strydClient` forwarding was added to `sendToIntervals` earlier (the "iOS-first flow must not regress to engine output" comment) but not to `sendToStryd`.

## 2026-07-12 — Cloning a garth token requires matching the garth version; Colima only mounts $HOME

**What happened**: Deploying the new `garmin-bridge` sidecar, we cloned ze's existing garth OAuth token (`~/.garminconnect/garmin_tokens.json`) into the `garmin-token-state` volume rather than doing a fresh interactive MFA login. Two things bit during deploy: (1) the bridge's `requirements.txt` initially pinned `garth==0.4.46`, which uses a **two-file** token format (`oauth1_token.json` + `oauth2_token.json`) and cannot read the **single-file** `garmin_tokens.json` that `garth 0.8.0` wrote — a silent auth failure. (2) The `docker run ... -v /tmp/gt:/src alpine cp ...` to populate the volume failed with "can't stat /src/garmin_tokens.json", because Colima only mounts `$HOME` into its VM, so a `/tmp` bind mount is empty inside the container.

**Root cause**: (1) garth's on-disk token format is version-specific and not forward/backward compatible; the reader's garth version must match the writer's. The writer here was blueToothDisco's `body_battery` venv (garth 0.8.0 / garminconnect 0.3.3). (2) The Colima `$HOME`-only mount is documented in `deployment.md` for build contexts, but the same constraint applies to any ad-hoc `docker run -v <host>:<ctr>` — `/tmp` on the host is invisible to the daemon.

**Fix**: Pinned the bridge to `garth==0.8.0` / `garminconnect==0.3.3` (the token-writer's versions) with a comment tying the pin to the token format. Re-staged the token under `/Users/dominus/garmin-token-tmp` (inside `$HOME`) before the `docker run` copy. Verified live: the bridge authenticates as "Ze Stuart", and forcing `healthSource: garmin` returns a Garmin-Body-Battery-sourced prescription.

**Prevention**:
- When cloning any credential/token that a library serialises to disk, pin the consumer to the **same library version** that wrote it, and validate against a live call before relying on it. A version bump that changes the token format is a silent break, not an error.
- Before validating field extraction against a third-party API of unknown shape, make one live call through the *writer's* environment and inspect the actual JSON (Body Battery entry was `[epoch_ms, level]` 2-element, not the assumed 3-element `[ts, status, level]`). Defensive extraction that scans for "the 0–100 int anywhere in the row" survived the wrong assumption; hard-coded indices would not have.
- Any `docker run -v <host-path>:<ctr>` against Cogitator/Colima must stage `<host-path>` under `$HOME`, never `/tmp` — same rule as build contexts.
- Verify a token-clone deploy end-to-end by *forcing* the new source (the WHOOP→Garmin fallback won't exercise Garmin if WHOOP happens to be healthy that day, as it was here after the strap resumed).

## 2026-07-12 — Garmin native FITs use standard fields (not CIQ dev fields); never commit a raw device FIT to a public repo

**What happened**: Building Vigil support for Garmin-recorded runs (Phase 2), two things had to be right before writing the extractor. (1) Garmin's original FIT exposes running dynamics as *standard* snake_case fields (`stance_time`, `stance_time_balance`, `vertical_oscillation`, `power`, `cadence`+`fractional_cadence`), whereas the existing Stryd extractor gates on CIQ *developer* fields ("Leg Spring Stiffness", "Form Power", "Impact"). A Garmin FIT has none of those, so the Stryd extractor correctly no-ops on it — but a naive reuse would have extracted nothing. (2) A real ze Garmin FIT embeds home GPS (`position_lat`/`position_long` ≈ 51.457, -0.120) on every record, and the exercitator repo is **public**.

**Root cause**: (1) Garmin writes running dynamics to the standard FIT profile; Stryd writes proprietary metrics (LSS, Form Power, ILR) as CIQ developer fields with human-readable names. They are different namespaces, and the Garmin metric set is a strict *subset* (no LSS/Form Power/ILR). (2) Committing a device FIT verbatim would leak home coordinates into public git history permanently — the same class of harm as committing a secret.

**Fix**: Pulled a real ze run FIT via the blueToothDisco garth venv, parsed it with the shipped `parseFitBuffer`, and inspected the actual field names *before* writing `garmin-fit.ts` (per the RESUME's "don't guess field names"). Built a Garmin extractor for the available subset — and got GCT asymmetry for free from Garmin's native `stance_time_balance`, which the single-pod Stryd never provided. Committed the fixture as **GPS-stripped, gzipped parsed records** (`tests/fixtures/garmin/garmin-run-records.json.gz`, 43 KB) — no coordinates, and tests run the extractor on the records while mocking the bridge client. Also chose **per-source baselines** (`source` in `vigil_metrics` + `vigil_baselines` PK) so a wrist-watch GCT offset can't contaminate the foot-pod baseline.

**Prevention**:
- Before extending a vendor-specific parser to a new vendor, obtain one real artefact and inspect the actual field names — vendors that both "record runs" can use entirely different FIT namespaces (standard vs developer fields). Verified by the `garmin-fit` test asserting real values (GCT 287.6 ms, asymmetry 1.87%) against a genuine FIT.
- Never commit a raw device capture (FIT/GPX/TCX) to a public repo — strip GPS (and any PII) and prefer a parsed-records fixture over the binary. Treat home coordinates like a secret.
- When merging biomechanics from two recording devices for the same athlete, keep baselines per-source unless the devices are proven to agree — a systematic offset inflates stddev and corrupts z-scores. `runVigilPipeline` returns the worst active source (injury-conservative).
