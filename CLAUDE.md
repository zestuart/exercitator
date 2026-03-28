# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This file is Claude's operating manual. Keeping it accurate is not busywork — it is
> self-care. An outdated CLAUDE.md leads to wrong assumptions, missed context, and
> compounding errors. Treat this document and its subsidiaries as first-class code
> artifacts: review them, update them, and trust them only when they reflect reality.

## Project

**Name**: Exercitator + Praescriptor
**Description**: MCP bridge for Claude to access the intervals.icu API, plus a web UI serving daily workout prescriptions. Hosted on Arca Ingens via Docker and Tailscale.
**Domains**: `exercitator.tail7ab379.ts.net` (MCP, funnel — public) · `praescriptor.tail7ab379.ts.net` (web UI, serve — tailnet only)
**Repository**: https://github.com/zestuart/exercitator

## Stack

- **Runtime**: Node.js + TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Database**: SQLite (via `better-sqlite3`) — local caching/state
- **Linter/Formatter**: Biome
- **Type checking**: `tsc --noEmit`
- **Test runner**: Vitest
- **Containerisation**: Docker + Docker Compose
- **Networking**: Tailscale funnel (MCP, public) + Tailscale serve (web UI, tailnet-only) on Arca Ingens
- **External API**: [intervals.icu](https://intervals.icu) REST API

## Architecture

```
src/
  index.ts              — entry point, transport selection, session management
  intervals.ts          — intervals.icu REST client (Basic auth over HTTPS)
  auth.ts               — OAuth middleware (PKCE + passphrase + signed tokens)
  db.ts                 — SQLite cache + enrichment tracking (better-sqlite3, WAL mode)
  stryd/
    client.ts           — Stryd PowerCenter API client (auth, list activities, download FIT)
    enricher.ts         — detect low-fidelity activities, match to Stryd, upload full FIT
  tools/
    athlete.ts          — get_athlete_profile, get_sport_settings
    activities.ts       — list_activities, get_activity, get_activity_streams, get_power_curve
    wellness.ts         — get_wellness, update_wellness
    events.ts           — list_events, create_event
    suggest.ts          — suggest_workout (Daily Suggested Workout engine)
  engine/
    types.ts            — shared TypeScript interfaces
    readiness.ts        — readiness score (0–100) from wellness + activity data
    power-source.ts     — Stryd vs Garmin vs HR-only detection, load metric selection
    sport-selector.ts   — Run vs Swim selection from load deficit + monotony rules
    staleness.ts        — sport-specific threshold staleness detection + category ceiling
    workout-selector.ts — category selection (rest/recovery/base/tempo/intervals/long)
    terrain-selector.ts — flat/rolling/trail/pool guidance per category + recent terrain
    workout-builder.ts  — structured segment generation per sport × category
    suggest.ts          — top-level orchestrator: fetchTrainingData, suggestWorkoutFromData, suggestWorkoutForSport, suggestWorkout
  web/
    server.ts           — Praescriptor HTTP entrypoint (port 3847)
    routes.ts           — route handler (/, /api/prescriptions, /api/send/:sport, /health)
    prescriptions.ts    — dual Run+Swim prescription generator with day-level cache
    send.ts             — push workout to intervals.icu calendar with dedup
    intervals-format.ts — WorkoutSegment[] → intervals.icu workout text
    invocations.ts      — deity invocations via Anthropic API with static fallbacks
    render.ts           — SSR HTML renderer (inlined CSS + JS, no framework)
```

### Key patterns

- **Per-session McpServer**: The MCP SDK allows only one transport per `McpServer`. In streamable-http mode, each session gets its own `McpServer` + `StreamableHTTPServerTransport` instance, tracked in a session map. Sessions are capped at 100 and pruned after 5 minutes idle.
- **Dual transport**: `MCP_TRANSPORT=stdio` for local dev (`claude mcp add`), `MCP_TRANSPORT=streamable-http` for Docker/funnel production.
- **OAuth middleware** (`src/auth.ts`): RFC-compliant (9728, 8414, 7591). PKCE S256 (SHA-256 hash, not HMAC) + client_credentials grants. Passphrase-gated authorisation. Self-validating HMAC-SHA256 signed tokens with version-based revocation. Per-IP rate limiting and lockout. Redirect URIs validated against allowlist (`https://claude.ai/api/mcp/auth_callback`, `http://localhost`, `http://127.0.0.1`). Request body capped at 64 KiB. Registration returns `token_endpoint_auth_method: "none"` for browser-based auth_code flow.
- **Claude Desktop compatibility**: OAuth endpoints accept both `/oauth/*` and `/*` paths (e.g. `/authorize` and `/oauth/authorize`). The MCP handler accepts both `/` and `/mcp` — Claude Desktop POSTs to `/` after OAuth.
- **Tool registration**: Each tool module exports a `register*Tools(server, client)` function. Tools use Zod schemas for input validation. Date parameters enforce `YYYY-MM-DD` regex. Date-only strings are appended with `T00:00:00` before forwarding to intervals.icu (which requires datetime format).
- **DSW engine** (`src/engine/`): Pure computation over JSON — no external dependencies. Pipeline: power source detection → readiness scoring → sport selection → staleness check → workout category (with staleness ceiling) → terrain selection → structured segments with dual-target prescription (power + HR cap). Staleness tiers (normal/moderate/severe) apply pace buffers and can force HR-only targets for return-to-sport safety. Testable in isolation with fixture data.
- **Power source detection** (`src/engine/power-source.ts`): Supports three ecosystems: Stryd CIQ (Garmin, `power_field: "Power"`), Stryd native (Apple Watch via HealthFit, `power_field: "power"` with `external_id` containing "Stryd"), and Garmin native. Apple Watch detection uses `device_name` pattern (`/^Watch\d/`) + `external_id` to avoid false Garmin correction. `getActivityLoad()` correctly uses `power_load` for both CIQ and native Stryd recordings.
- **Hard session detection** (`src/engine/workout-selector.ts`): Multi-signal `isHardSession()` — RPE ≥ 7, `icu_intensity > 85` (normalised power as % of FTP), HR Z4+ > 25% of session time, load > 0.7 × sportCtl. Multiple signals prevent back-to-back intense prescriptions when individual metrics are missing.
- **Stryd FIT enrichment** (`src/stryd/`): Optional pipeline that detects low-fidelity Apple Watch + Stryd activities (missing CIQ developer fields), downloads the full FIT from Stryd PowerCenter API, uploads to intervals.icu, and marks the original as ignored. Runs before prescription generation. Tracked in SQLite (`stryd_enrichments` table) to prevent re-processing. Graceful degradation: skipped entirely if `STRYD_EMAIL`/`STRYD_PASSWORD` not set. Failures never break prescriptions.
- **Stale session handling**: POSTs with an unknown `mcp-session-id` return HTTP 404 with a JSON-RPC error. This prevents the SDK from creating a fresh transport for non-initialize requests after container restarts.
- **SQLite cache**: TTL-based cache in `data/exercitator.db`. Used for infrequently-changing data (athlete profile). WAL mode for concurrent reads.
- **Praescriptor** (`src/web/`): Separate container, same codebase. Serves daily Run + Swim prescriptions as SSR HTML via Tailscale `serve` (tailnet-only, no funnel). Imports the DSW engine directly — no network calls between containers. Deity invocations generated via Anthropic API with static fallbacks. "Send to intervals.icu" with server-side dedup. Every segment shows a zone guide: watts for running (derived from FTP zones), HR bpm for swimming (from intervals.icu HR zones). Z1 uses `<` threshold format, higher zones show ranges.

## Philosophy

These principles govern all development work in this project. They are not
guidelines — they are constraints.

1. **Security is non-negotiable.** A missed deployment is always better than an
   insecure deployment. Every change passes a SAST scan before reaching production.
   No exceptions, no overrides, no "we'll fix it later".

2. **Tests grow with the project.** When you write code, you write tests. When you
   find a bug, you write a test that catches it. When a deployment fails, you write
   a test that would have caught it. The test suite is a ratchet — it only moves
   forward.

3. **Documentation is code.** This file, the changelog, user-facing docs, and API
   references are maintained with the same rigour as source code. Stale documentation
   is a bug. Claude auto-maintains all documentation — not by flagging staleness, but
   by fixing it.

4. **Lessons are permanent.** Every failure, surprise, or hard-won insight is recorded
   in `lessons.md`. This prevents the same mistake from happening twice, across
   conversations, across contributors, across time.

5. **Never commit secrets.** API keys, tokens, passwords, and credentials live in
   `.env` and nowhere else. Not in source code, not in commit messages, not in
   comments, not in documentation. The `.env` file is never committed. This matters
   because secrets in git history are effectively public — they persist in every
   clone, every fork, every backup, forever. Even "private" repositories get shared,
   transferred, and compromised. One leaked key can mean unauthorised access,
   unexpected bills, or a full breach.

## Development Workflow

Every change follows this sequence. No steps are optional.

```
Write code → Run tests (/test) → Update docs → Update CHANGELOG → Deploy (/deploy)
```

The `/deploy` skill enforces this by running pre-flight checks (tests + SAST) before
any code reaches production. If you are not deploying, still run `/test` after changes.

### When to update documentation

- **CLAUDE.md**: When you add a new pattern, dependency, convention, or architectural
  decision. When you discover that existing documentation is wrong.
- **Subsidiary files**: When a CLAUDE.md section exceeds ~50 lines, split it into a
  subsidiary file and link it from the index. Use your judgement — the goal is
  efficient retrieval, not arbitrary size limits.
- **CHANGELOG.md**: Every user-visible change, every deploy. Follow Keep a Changelog
  format (see below).
- **User-facing docs**: README, API docs, guides — update them as part of the change,
  not as a separate task.
- **lessons.md**: After every bug, failed deploy, unexpected behaviour, security
  finding, or any insight that would help future development.

## Document Management

### The blooming pattern

This CLAUDE.md starts small. As the project grows, sections will need more detail
than fits comfortably in one file. When that happens, split the section into its own
file and replace the section content with a link.

Maintain an index file (`CLAUDE-INDEX.md`) listing all subsidiary files with one-line
descriptions. This index serves both Claude and human developers.

Example structure after blooming:
```
CLAUDE.md              — core rules, workflow, conventions (this file)
CLAUDE-INDEX.md        — index of all subsidiary files
architecture.md        — file map, module responsibilities, data flow
decisions.md           — architectural and technical decisions with rationale
lessons.md             — post-mortem log (auto-maintained)
security.md            — security surfaces, acknowledged risks, remediation history
```

### Changelog

Maintain `CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com/) format
with [Semantic Versioning](https://semver.org/):

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- New features

### Changed
- Changes to existing features

### Fixed
- Bug fixes

### Security
- Security-related changes (always document these)

### Removed
- Removed features
```

Move `[Unreleased]` items to a versioned section on each release. Security changes
are always documented, even if they are internal refactors with no user-visible effect.

### Lessons learned

`lessons.md` is a chronological post-mortem log. Claude maintains this proactively —
every time something unexpected happens, a bug is found, a deployment fails, or a
security issue is discovered, add an entry:

```markdown
## YYYY-MM-DD — Brief title

**What happened**: Factual description of the issue.
**Root cause**: Why it happened.
**Fix**: What was done to resolve it.
**Prevention**: What test, check, or process change prevents recurrence.
```

This file is append-only. Do not edit or remove past entries.

## Security

### Credential management

All credentials live in `.env` at the project root. This file is:
- Listed in `.gitignore` (verified by /init)
- Never committed, logged, or echoed
- The single source of truth for all API keys, tokens, and secrets

A `.env.example` file documents required variables with placeholder values. This file
IS committed and kept in sync with `.env`.

```bash
# .env.example — commit this, not .env
GEMINI_API_KEY=your-gemini-api-key-here          # Required for SAST scans
INTERVALS_ICU_API_KEY=your-intervals-icu-api-key  # Required for intervals.icu access
TAILSCALE_AUTH_KEY=your-tailscale-auth-key         # Required for Docker deployment
MCP_OAUTH_CLIENT_ID=exercitator                   # OAuth client ID
MCP_OAUTH_CLIENT_SECRET=<openssl rand -hex 32>    # OAuth token signing secret
MCP_OAUTH_AUTHORIZE_PASSPHRASE=<your passphrase>  # Human-memorable auth gate
MCP_TOKEN_VERSION=1                               # Increment to revoke all tokens
ANTHROPIC_API_KEY=<your-anthropic-api-key>         # Optional: deity invocations in Praescriptor
STRYD_EMAIL=<your-stryd-email>                    # Optional: Stryd FIT enrichment
STRYD_PASSWORD=<your-stryd-password>              # Optional: Stryd FIT enrichment
QNAP_PASSWORD=<arca-ingens-password>              # SSH to Arca Ingens (dominus@192.168.4.180:2022)
```

### SAST scanning

Every deployment includes a SAST scan using Gemini 2.5 Pro (a different model family
from Claude, providing independent security review). The scan:

- Runs in `diff` mode during deploys (only changes since last baseline)
- Runs in `full` mode on demand via `/sast`
- Tags clean scans as `sast-baseline-YYYY-MM-DD` for incremental tracking
- **Blocks deployment on findings** — findings must be fixed or explicitly accepted

The SAST scanner (`scripts/sast_scan.py`) is zero-dependency (Python stdlib only) and
reads `GEMINI_API_KEY` from `.env` or environment.

### Security surfaces

- **intervals.icu API key**: Stored in `.env`, used server-side only. Leaking it grants read/write access to the user's training data.
- **Tailscale funnel exposure**: The MCP server is publicly reachable via the funnel. All endpoints must validate requests — no open proxy behaviour.
- **SQLite injection**: Any user-supplied parameters used in SQL queries must be parameterised.
- **MCP tool input validation**: All tool parameters received from Claude must be validated before forwarding to intervals.icu.
- **Anthropic API key**: Optional, used server-side only by Praescriptor for deity invocations. Never sent to the client. Stored in `.env`.
- **Praescriptor access**: Tailnet-only via `tailscale serve` (no funnel). No authentication layer — Tailscale provides device-level access control.
- **Stryd credentials**: Optional `STRYD_EMAIL`/`STRYD_PASSWORD` in `.env`, used server-side only by Praescriptor for FIT enrichment. Token is short-lived and held only in memory during enrichment. Never exposed via web UI or MCP tools.
- **Docker secrets**: Container environment variables must not be logged or exposed via health/debug endpoints.
- **OAuth redirect URI**: Validated against allowlist (`https://claude.ai/api/mcp/auth_callback`, localhost). Do not add arbitrary URIs.
- **Session exhaustion**: HTTP sessions are capped at 100 with 5-minute idle timeout to prevent memory exhaustion DoS.
- **Request body size**: OAuth endpoints limit request bodies to 64 KiB.

## Testing

```bash
npx biome check .              # Lint + format check
npx tsc --noEmit               # Type check
npx vitest run                 # All tests
npx vitest run src/tools       # Tests in a specific directory
npx vitest run -t "tool name"  # Single test by name
```

The `/test` skill runs all three in sequence.

### Test growth protocol

When adding new functionality:
1. Write tests for the new code path
2. Run the full suite to verify no regressions

When fixing a bug:
1. Write a test that reproduces the bug (it should fail)
2. Fix the bug (test should now pass)
3. Add a lessons.md entry

When a deployment or production issue occurs:
1. Write a test that would have caught it
2. Add a lessons.md entry with the prevention section referencing the new test

## Deployment

- **Target**: Arca Ingens (QNAP NAS) — `dominus@192.168.4.180:2022`
- **Path on server**: `/share/Container/exercitator/`
- **Method**: Tarball upload + `docker compose up -d --build` (no git on QNAP)
- **Networking**: Tailscale funnel (`exercitator.tail7ab379.ts.net`) → `exercitator-mcp:8642`; Tailscale serve (`praescriptor.tail7ab379.ts.net`) → `praescriptor-web:3847`
- **Branch**: `main` — deploy from main only
- **Containers**: `exercitator-mcp` (MCP server) + `tailscale-exercitator` (funnel sidecar) + `praescriptor-web` (web UI) + `tailscale-praescriptor` (serve sidecar)
- **Volumes**: `exercitator-data` (SQLite), `exercitator-tailscale-state` (external), `praescriptor-tailscale-state` (external) — do not delete external volumes

### Deploy procedure

```bash
# 1. SSH password (special characters — use Python file-write, not shell expansion)
python3 -c "
with open('/Users/ze/Documents/claude/exercitator/.env') as f:
    for line in f:
        if line.startswith('QNAP_PASSWORD='):
            open('/tmp/.qnap_pass','w').write(line.split('=',1)[1].strip())
" && chmod 600 /tmp/.qnap_pass

# 2. Tarball (exclude git, node_modules, .env, data)
tar czf /tmp/exercitator.tar.gz --exclude='.git' --exclude='node_modules' \
  --exclude='dist' --exclude='data' --exclude='.env' --exclude='phase2' \
  --exclude='.claude/settings.local.json' .

# 3. Upload and extract
sshpass -f /tmp/.qnap_pass scp -P 2022 /tmp/exercitator.tar.gz \
  dominus@192.168.4.180:/share/Container/exercitator/
sshpass -f /tmp/.qnap_pass ssh -p 2022 dominus@192.168.4.180 \
  'cd /share/Container/exercitator && tar xzf exercitator.tar.gz && rm exercitator.tar.gz'

# 4. Rebuild app containers (Tailscale sidecars stay running)
sshpass -f /tmp/.qnap_pass ssh -p 2022 dominus@192.168.4.180 \
  'export PATH=/share/CE_CACHEDEV1_DATA/.qpkg/container-station/usr/bin/.libs:$PATH && \
   cd /share/Container/exercitator && docker compose up -d --build exercitator praescriptor'

# 5. Verify both services
curl -s https://exercitator.tail7ab379.ts.net/health
curl -s https://praescriptor.tail7ab379.ts.net/health

# 6. Clean up
rm -f /tmp/.qnap_pass /tmp/exercitator.tar.gz
```

### Pre-flight sequence (enforced by /deploy)

1. **Lint + type check** — language-appropriate static analysis
2. **Test suite** — all tests must pass
3. **Secret scan** — verify no credentials in staged files
4. **SAST scan** — Gemini security review of changed files
5. **Documentation check** — CHANGELOG.md updated, docs current
6. **Commit** — descriptive message with co-author attribution
7. **Push** — to configured branch/remote
8. **Monitor** — verify deployment status (if CI/CD configured)

## Conventions

- ISO 8601 dates (YYYY-MM-DD), 24-hour time (HH:MM)
- Commit messages: imperative mood, concise summary, optional body
- Co-author attribution on AI-assisted commits
- Biome handles formatting and linting — no separate Prettier/ESLint config
- British English in documentation and user-facing strings

## Skills

| Command   | Description |
|-----------|-------------|
| `/init`   | First-run project interview — configures everything |
| `/test`   | Run the test suite (lint + type check + tests) |
| `/deploy` | Pre-flight checks + SAST + commit + push + monitor |
| `/sast`   | Full SAST scan of the entire codebase |
