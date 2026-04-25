# Exercitator HTTP API — Implementation Plan

**Companion to**: `phase2/exercitator-http-api-spec.md` v0.2
**Status**: ready for autonomous execution
**Owner**: Claude Code
**Estimated effort**: 4–6 focused hours of build + 1 deploy cycle

This plan implements the v0.2 spec. It is structured for execution in auto mode: each phase has explicit success criteria, file paths, and shell verifications. Phases are sequential; tasks within a phase are parallel-safe unless noted.

The plan opens with the architectural decisions and their devil's-advocate counter-arguments, so a future executor doesn't relitigate them silently.

---

## A. Architectural decisions (with chain-of-reasoning + devil's advocate)

### A1. Same container, new HTTP listener (rather than a new container)

**Reasoning**:
- The HTTP API needs the IntervalsClient cache, the Stryd client (for CP queries), the SQLite cache (for Vigil baselines, Stryd enrichment, compliance), and the DSW engine. All of these are imported inline by the existing MCP server. A second container would either (a) duplicate the upstream calls — burning intervals.icu rate limits — or (b) require IPC between containers, which is needless complexity for a tailnet service.
- The MCP server is the canonical owner of the SQLite file (writes Vigil metrics, compliance, Stryd enrichment tracking). A second container writing to the same SQLite via the `exercitator-data` volume would risk lock contention even with WAL mode. Single writer is safer.
- Praescriptor today imports the same modules — proves the same-codebase pattern works.

**Devil's advocate**:
- *"A separate container would isolate API faults from MCP."* True, but the MCP server already runs `setInterval` timers, OAuth state machines, and per-session McpServers without taking the process down. Adding another HTTP listener on a different port is bounded blast radius. If an API handler throws, only that request fails.
- *"Two listeners in one Node process competes for the event loop."* Node's HTTP server is non-blocking; the event loop handles both fine. The expensive work (intervals.icu calls) is awaited and yields. If telemetry later shows contention, we can split — but premature.
- *"What if the API is much larger than MCP?"* Then we split. Today we have ~10 endpoints, all reading the same upstream. Co-locating wins on simplicity.

**Decision**: extend `src/index.ts` to start a third HTTP listener on port 8643 when `EXERCITATOR_API_KEYS` is set.

### A2. Routing under `/api/users/:userId/...`

**Reasoning**:
- The existing system has two athletes with independent credentials. Praescriptor already uses `/:userId/` URL routing. Mirroring the convention keeps mental model alignment between web and native clients.
- Bearer keys are bound to a user (§2 of spec). Path scoping makes the bound user explicit in every request, which simplifies auditing and removes ambiguity if a key is reused incorrectly.

**Devil's advocate**:
- *"`/api/me/...` would let one key fetch its own data without naming the user — simpler client."* True for single-user clients, but Excubitor's design supports both Zë and Pam (the Promus dashboard already does), and explicit userId in the path lets the same client switch users without re-authenticating. `/api/me` aliasing can be added later as sugar (resolve `me` → bearer's bound userId) without breaking `/users/:userId/`.

**Decision**: explicit `/api/users/:userId/...`. No `/me` alias in v0.2.

### A3. Bearer scoping `<client>:<userId>:<token>`

**Reasoning**:
- Tailscale provides device-level access (only tailnet members reach the API). It does **not** provide per-user authorisation — a tailnet device that obtains *any* valid key would otherwise read both Zë's and Pam's data.
- Encoding the bound userId in the key string lets the middleware refuse cross-user reads without a separate ACL store.
- Constant-time compare is required because the token portion is the secret.

**Devil's advocate**:
- *"Per-user keys mean rotating one user's key doesn't affect the other — simple. But what about a future shared 'family view'?"* Add a `multi-user` key class (e.g. `multi:ze,pam:token`) when needed. Spec §12 question 1 already flags this.
- *"Why not OAuth like the MCP surface?"* OAuth is overkill for a known-device list. The MCP surface needs OAuth because Claude Desktop expects PKCE; native tailnet clients can ship a static bearer.

**Decision**: bearer with format `<client>:<userId>:<token>`; middleware splits on `:`, looks up the (client, userId, token) tuple by constant-time compare against the env-configured list, and 403s on path-userId mismatch.

### A4. New Tailscale sidecar `exercitator-api`, tailnet-only

**Reasoning**:
- The MCP server's funnel exposes it publicly. The HTTP API is for internal native clients only — funnel exposure is a needless attack surface.
- Praescriptor uses the same tailnet-only pattern. Reusing it keeps ops uniform.
- Different sidecar ⇒ different hostname ⇒ different TLS cert, no path-routing tricks needed.

**Devil's advocate**:
- *"Could we reuse the existing `tailscale-exercitator` sidecar with path-based routing on the same hostname?"* Tailscale `serve` does support multiple paths, but mixing public-funnel and tailnet-only on one hostname is a footgun: a misconfig that flips the funnel ON would expose the API. Two sidecars give us defence-in-depth.
- *"Two sidecars cost more memory."* ~30 MB per Tailscale userspace daemon. Negligible on the QNAP.

**Decision**: new sidecar `tailscale-exercitator-api` (container_name `exercitator-api-ts`, hostname `exercitator-api`). New external volume `exercitator-api-tailscale-state`.

### A5. Polymorphic target shape (run vs swim)

**Reasoning**:
- The engine already produces both run (power-targeted) and swim (pace-targeted) prescriptions. A flat `target_power_w` field can't represent swim.
- A discriminated union (`{ kind: "power" | "pace" | "hr", ... }`) is the standard TS pattern and renders cleanly to JSON. Decoders on Swift can use Codable's `decode(forKey:)` with the `kind` discriminator.

**Devil's advocate**:
- *"Two separate fields (`target_power`/`target_pace`) might be simpler for a Swift decoder."* Maybe, but it pollutes the response with mostly-null fields. The discriminated union scales to future target kinds (e.g. cadence) without schema changes.

**Decision**: discriminated union with `kind`.

### A6. 409 on `awaiting_input` (rather than 200 with status)

**Reasoning**:
- HTTP semantics: the resource the client asked for (a prescription) does not yet exist because input is required from the user. 409 Conflict (or 422 Unprocessable Entity) communicates that to clients that follow status codes.
- Returning 200 with a `status: "awaiting_input"` field works but forces every client to special-case the body. Status-code dispatch is more idiomatic.

**Devil's advocate**:
- *"422 is more accurate than 409."* Both fit. 409 reads more naturally as "your request conflicts with current state (missing prerequisite)". 422 reads as "your body was malformed". The body is fine here. We pick 409.
- *"GraphQL-style would put this in `errors[]` with code, status 200."* We're not doing GraphQL.

**Decision**: 409 + `details.awaiting_input` in the error envelope.

### A7. Reuse `src/web/users.ts` as the canonical user registry

**Reasoning**:
- DRY. One source of truth for user IDs, env var names, sport list, Stryd flag.
- Avoids drift where Praescriptor recognises a user but the API doesn't (or vice versa).

**Devil's advocate**:
- *"`web/` semantically belongs to the HTML UI; mixing into HTTP API muddies layers."* True. The longer-term fix is to extract `users.ts` into `src/users.ts` (top-level). Doing that as part of this task is a small, safe refactor and improves both the API and Praescriptor.

**Decision**: extract `src/web/users.ts` → `src/users.ts`. Update Praescriptor imports.

### A8. New module path `src/api/`

**Reasoning**: parallel to `src/tools/` (MCP) and `src/web/` (Praescriptor). Each surface owns its module; engine and clients are shared.

**Devil's advocate**:
- *"`src/http/` could host both Praescriptor and the API."* No — Praescriptor's renders, deity invocations, and CSS are HTML-shaped. The API is JSON-shaped. They share zero render code.

**Decision**: `src/api/`.

---

## B. File-level inventory

New:
- `src/users.ts` — moved from `src/web/users.ts`
- `src/api/server.ts` — HTTP listener wiring
- `src/api/auth.ts` — bearer middleware
- `src/api/router.ts` — path dispatch
- `src/api/errors.ts` — error envelope helpers
- `src/api/types.ts` — DTOs
- `src/api/handlers/health.ts`
- `src/api/handlers/status.ts`
- `src/api/handlers/workouts.ts`
- `src/api/handlers/compliance.ts`
- `src/api/handlers/cross-training.ts`
- `src/api/handlers/dashboard.ts`
- `src/api/cache.ts` — per-user response cache (TTL)
- `tailscale-config-exercitator-api/serve.json`
- `tests/api/auth.test.ts`
- `tests/api/router.test.ts`
- `tests/api/handlers/*.test.ts` (one per handler)

Modified:
- `src/index.ts` — start the API listener alongside MCP
- `src/web/server.ts` — import users from `src/users.ts`
- `src/web/routes.ts` — same
- `docker-compose.yml` — new sidecar + new env vars
- `.env.example` — `EXERCITATOR_API_KEYS`, `EXERCITATOR_API_BIND_ADDR`
- `CLAUDE.md` — Architecture section gains an `src/api/` entry; Stack mentions HTTP API
- `CHANGELOG.md` — `[Unreleased]` Added section
- `lessons.md` — append after deploy if anything surprising surfaces

Deleted: none.

---

## C. Phased execution

Each phase ends with `npx biome check . && npx tsc --noEmit && npx vitest run` (the `/test` skill). A phase is not complete until those pass.

### Phase 0 — preflight (5 min)

1. Verify the working tree is clean: `git status` → clean.
2. Verify the spec file is present: `phase2/exercitator-http-api-spec.md` exists.
3. Confirm `package.json` does not need new deps. (We use Node stdlib `http`, no Express.)
4. Run baseline tests: `npx vitest run` — must pass before we start changing things.

Success: tests green on `main`-equivalent state.

### Phase 1 — extract `src/users.ts` (15 min)

Single safe refactor up-front so both Praescriptor and the API share one source.

1. Move `src/web/users.ts` → `src/users.ts` (content unchanged).
2. Update imports:
   - `src/web/server.ts`
   - `src/web/routes.ts`
   - any other importers (verify with `Grep "from \"./users.js\"|from \"../users.js\"" src/`)
3. Add a 1-line re-export shim at `src/web/users.ts` if any external scripts import it (search `scripts/` and `tests/`).
4. Run `/test`. All Praescriptor tests must still pass unchanged.

Success: tests green; `git diff` shows only path rewrites.

### Phase 2 — auth + router skeleton + /health (30 min)

1. Create `src/api/types.ts` with the DTO interfaces from the spec (StatusResponse, SuggestionResponse, etc.). Keep them mirrored to spec §5 — one struct per endpoint.
2. Create `src/api/errors.ts` with `apiError(res, code, message, details?)` — writes the envelope from spec §4.
3. Create `src/api/auth.ts`:
   - `parseApiKeys(env)` → `Map<token, { client: string, userId: string }>`
   - `requireBearer(req, res, requestedUserId)` → boolean (true if pass; false and writes 401/403 if fail)
   - Use `node:crypto.timingSafeEqual` on the token portion only (client/userId are not secret).
4. Create `src/api/router.ts`:
   - Dispatches `GET/POST /api/...` to handlers.
   - Validates `:userId` against the user registry; 404 unknown.
5. Create `src/api/handlers/health.ts` — returns the §5.1 payload. Probe `IntervalsClient` and `StrydClient` reachability with a tiny GET (or static `users_configured` only — see note).
6. Create `src/api/server.ts`:
   - Reads `EXERCITATOR_API_KEYS`, `EXERCITATOR_API_BIND_ADDR` (default `0.0.0.0:8643`).
   - Builds per-user `IntervalsClient` and `StrydClient` maps using `src/users.ts`. (Same code as `src/web/server.ts` — extract to a helper if duplication is annoying.)
   - Starts `http.createServer((req, res) => router(req, res, ctx))`.
   - Exports `startApiServer(ctx)` so `src/index.ts` can call it.
7. Wire into `src/index.ts`:
   - After MCP setup, if `process.env.EXERCITATOR_API_KEYS` is set, call `startApiServer({ intervalsClients, strydClients })`.
   - Both stdio and streamable-http modes start the API listener (or only streamable-http? See devil's advocate below).
8. Tests:
   - `tests/api/auth.test.ts`: valid key passes; wrong userId in path → 403; missing key → 401; malformed key → 401.
   - `tests/api/router.test.ts`: `/api/health` returns 200; unknown user → 404; method not allowed → 405.

**Devil's advocate**: *"Should the API listener also start in stdio mode?"* In stdio (local dev), no Tailscale, no native client. It's harmless to bind to 8643 on localhost, and it lets the developer hit the API with curl during dev. Bind to `127.0.0.1:8643` in stdio mode; bind to `0.0.0.0:8643` only in streamable-http mode (Docker).

**Note on health probes**: don't make `/health` actually call intervals.icu / Stryd on every request — that DDoSes upstream. Cache reachability for 60 s.

Success: `curl -H "Authorization: Bearer $KEY" http://localhost:8643/api/health` returns 200; `curl http://localhost:8643/api/health` returns 200 (health is unauthenticated); `/api/users/ze/status` returns 401 without bearer; tests green.

### Phase 3 — read endpoints (90 min)

Implement, in order:

1. `GET /api/users/:userId/status` (`src/api/handlers/status.ts`)
   - Compose readiness (call `computeReadiness` from `src/engine/readiness.ts` after fetching wellness via `IntervalsClient`).
   - Critical power via `getPowerContext` from `src/engine/power-source.ts` (re-purpose; the engine already does this).
   - Training load: pull last 14 days of activities, compute CTL/ATL/TSB and 7-day trend.
   - Last workout: most recent activity from list_activities.
   - Vigil summary: read `vigil_metrics` + `vigil_baselines` from SQLite using existing `src/engine/vigil/` helpers; return inactive shape if no alert.
2. `GET /api/users/:userId/workouts/today` (`src/api/handlers/workouts.ts`)
   - Resolve TZ from query → athlete profile → UTC.
   - List intervals.icu events for today + completed activities for today.
3. `GET /api/users/:userId/workouts/suggested`
   - Call `suggestWorkout(client, strydClient, profile, sport)` from `src/engine/suggest.ts`.
   - On `status === "awaiting_input"`, respond 409 with the `awaitingInput` details.
   - On success, transform `WorkoutSuggestion` → `SuggestionResponse` with polymorphic targets. Mapper in `src/api/payload.ts`.
4. `GET /api/users/:userId/workouts/:id`
   - If id starts with `iv-` → fetch from intervals.icu.
   - If id starts with `prescribed-` → look up in the day cache.
   - Else 404.
5. `GET /api/users/:userId/dashboard`
   - Call the three handlers above, assemble. If suggested is 409 → top-level `awaiting_input`.
6. `GET /api/users/:userId/compliance/summary` and `/compliance/detail`
   - Wrap `getComplianceSummary` / `getComplianceDetail` from `src/tools/compliance.ts` (extract from MCP tool wrappers if needed — pure functions over `IntervalsClient` + SQLite).

For each handler:
- Implement.
- Add `tests/api/handlers/<name>.test.ts` with mocked `IntervalsClient` returning fixture data. At least one happy-path test, one auth-fail test, one missing-data test.
- Run `/test`.

**Per-user response cache** (`src/api/cache.ts`): keyed `(userId, path)` → response + expiry. TTL from `EXERCITATOR_API_CACHE_TTL_S`. Used by status, suggested, dashboard. Bypassed by query `?fresh=1`.

**Devil's advocate**: *"Do we really need a server-side cache when clients cache for 10 min?"* Yes — multiple clients (iOS + watchOS forwarder + future home dashboard) all polling concurrently amplifies upstream calls. Server cache shields intervals.icu.

Success: each endpoint returns the spec'd shape against fixture data; tests green.

### Phase 4 — write endpoint: cross-training RPE (30 min)

1. `POST /api/users/:userId/cross-training/:activityId/rpe` (`src/api/handlers/cross-training.ts`)
   - Validate body: `{ rpe: 1..10 }`.
   - Persist to SQLite via the same helper that `submit_cross_training_rpe` uses (`src/tools/suggest.ts` — extract if necessary).
   - Re-classify strain.
   - Respond with the new strain tier and whether it cleared today's prescription block.
2. Tests: valid RPE, out-of-range RPE → 400, unknown activity → 404.

Success: spec'd 200 shape; subsequent `/workouts/suggested` no longer 409.

### Phase 5 — Docker + Tailscale wiring (45 min)

1. Update `docker-compose.yml`:
   - In the `exercitator` service: add `EXERCITATOR_API_KEYS=${EXERCITATOR_API_KEYS:?required}`, `EXERCITATOR_API_BIND_ADDR=0.0.0.0:8643`. Expose port `8643`.
   - Add new service `tailscale-exercitator-api`:
     - container_name: `exercitator-api-ts` (per memory rule, must not match hostname `exercitator-api`)
     - hostname: `exercitator-api`
     - mount `tailscale-config-exercitator-api/:/config:ro`
     - state volume `exercitator-api-tailscale-state`
2. Create `tailscale-config-exercitator-api/serve.json`:

   ```json
   {
     "TCP": { "443": { "HTTPS": true } },
     "Web": {
       "${TS_CERT_DOMAIN}:443": {
         "Handlers": { "/": { "Proxy": "http://exercitator:8643" } }
       }
     }
   }
   ```
3. Add new external volume to compose:

   ```yaml
   exercitator-api-tailscale-state:
     name: exercitator-api-tailscale-state
     external: true
   ```
4. Update `.env.example`:

   ```
   EXERCITATOR_API_KEYS=excubitor-ios:ze:replace-me,excubitor-ios:pam:replace-me
   EXERCITATOR_API_BIND_ADDR=0.0.0.0:8643
   ```
5. Pre-deploy on Arca Ingens: `docker volume create exercitator-api-tailscale-state` (one-time).

**Devil's advocate**: *"Could we use the same `tailscale-state` volume?"* No — Tailscale tracks node identity in that volume. Two daemons sharing one state would conflict. Each sidecar gets its own.

Success: `docker compose config` validates; both new env vars documented.

### Phase 6 — docs + changelog + lessons (15 min)

1. `CLAUDE.md`:
   - In **Architecture** code block: add `api/` subtree under `src/`.
   - In **Stack**: add a line about the HTTP API (Tailscale-served on port 8643).
   - In **Security surfaces**: add the new bearer-key secret.
   - In **Deployment**: note the new container in the Containers list and the new external volume.
2. `CHANGELOG.md` `[Unreleased]` → Added: "HTTP API (`/api/...`) for native clients. Tailnet-only via `exercitator-api` Tailscale sidecar."
3. `lessons.md`: append only if Phase 7 surfaces something unexpected.

### Phase 7 — pre-flight + deploy (45 min)

Use the existing `/deploy` skill, which runs:
1. Lint + typecheck + tests.
2. Secret scan.
3. SAST (Gemini).
4. Docs check.
5. Commit + push.
6. Deploy to Arca Ingens via the documented procedure.
7. Post-deploy verify:
   - `curl -s https://exercitator-api.tail7ab379.ts.net/api/health` → 200.
   - `curl -s -H "Authorization: Bearer <ze-key>" https://exercitator-api.tail7ab379.ts.net/api/users/ze/status` → 200, JSON shape matches spec §5.2.
   - `curl -s -H "Authorization: Bearer <ze-key>" https://exercitator-api.tail7ab379.ts.net/api/users/pam/status` → 403 (cross-user).
   - Existing MCP funnel still responsive: `curl -s https://exercitator.tail7ab379.ts.net/health` → 200.
   - Existing Praescriptor still responsive: `curl -s https://praescriptor.tail7ab379.ts.net/health` → 200.

**Devil's advocate**: *"What if the new sidecar fails to come up — does the deploy block?"* Use `--no-deps` style? No — the existing services restart cleanly because their config didn't change semantically. Only the new sidecar can fail; if it does, MCP and Praescriptor keep running and we debug the sidecar separately.

Per memory, **warn the user to reconnect their MCP client** after the rebuild touches the `exercitator` service.

---

## D. Failure modes and mitigations

| Failure | Detection | Mitigation |
|---|---|---|
| Port 8643 already in use | listen() throws | Make `EXERCITATOR_API_BIND_ADDR` overridable; document in `.env.example` |
| Bearer key file missing in prod | startup error log | Compose `:?required` on `EXERCITATOR_API_KEYS` so deploy fails fast |
| intervals.icu rate limit (429) on a high-traffic day | 502 to client; log line | Per-user TTL cache (already in plan); exponential backoff in `IntervalsClient` (already exists) |
| SQLite WAL contention with MCP writes | rare; might surface as long write latency | Same process = same connection pool; better-sqlite3 handles it |
| Vigil baseline missing for a new user | `injury_warning.status: "unknown"` | Spec already covers this; no error |
| Cross-user key abuse from a leaked iOS key | Logs show 403 spike | Rotate by removing the key from `EXERCITATOR_API_KEYS` and redeploying |
| Tailscale sidecar can't reach Docker DNS for `exercitator:8643` | sidecar logs | Service name in compose is `exercitator`; sidecars are on the same default network |

---

## E. Success criteria (overall)

- [ ] Spec v0.2 in `phase2/`, this plan alongside.
- [ ] All endpoints in spec §5 (excluding §5.6 push and §5.7 wellness write — both deferred or opt-in) return the documented shape.
- [ ] Bearer scoping enforced (cross-user → 403).
- [ ] `:memory:` SQLite integration tests pass.
- [ ] `npx biome check . && npx tsc --noEmit && npx vitest run` all green.
- [ ] SAST scan clean (no new findings vs baseline).
- [ ] Live deploy: all four hostnames responsive (MCP funnel, Praescriptor serve, API serve, health endpoints).
- [ ] CHANGELOG, CLAUDE.md updated.
- [ ] User reminded to reconnect MCP client.

---

## F. Stop conditions (for autonomous mode)

Halt and surface the issue rather than guessing if any of the following occur:

1. **Spec ambiguity**: any handler can't be implemented unambiguously from the spec — write a short note, halt.
2. **Test fails after a fix attempt**: don't blindly retry; investigate root cause, write a `lessons.md` candidate, halt.
3. **SAST finds a new high/critical**: do not deploy; halt.
4. **Tailscale auth key invalid**: deploy fails before sidecar comes up; halt for human key issuance.
5. **Schema drift surfaces**: e.g. an existing engine function returns a shape the spec didn't account for. Update the spec (with a `### YYYY-MM-DD` note), then continue.
6. **Behaviour change in MCP surface**: any code change that alters MCP tool behaviour requires explicit user sign-off — halt before committing.

---

## G. Out of scope for this plan (and intentional non-goals)

- iOS client implementation (Excubitor's Exercise tab) — separate workspace.
- Push to Stryd / push to intervals.icu calendar from the API (deferred to v0.3 per spec §5.6).
- Wellness writes beyond the opt-in subset (spec §5.7).
- A `/api/me/...` alias.
- API versioning (`/api/v2/`) until needed.
- Any change to the existing OAuth/MCP surface.
- Any change to Praescriptor's HTML rendering (only the `users.ts` import path changes).

---

## H. Notes for the executor

- Run each phase, run `/test`, only then proceed.
- If a refactor (Phase 1) would touch more files than expected, stop and surface the diff for review before proceeding to Phase 2.
- The deploy procedure (Phase 7) must use the documented tarball flow in `CLAUDE.md` §Deployment — do not invent a new path.
- After deploy, the user expects a reminder to reconnect their MCP client (per stored memory `feedback_deploy_reconnect.md`).
- This plan does **not** touch any data in `data/exercitator.db`. Existing SQLite tables are read; no schema changes.
