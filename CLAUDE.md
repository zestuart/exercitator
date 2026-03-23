# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This file is Claude's operating manual. Keeping it accurate is not busywork — it is
> self-care. An outdated CLAUDE.md leads to wrong assumptions, missed context, and
> compounding errors. Treat this document and its subsidiaries as first-class code
> artifacts: review them, update them, and trust them only when they reflect reality.

## Project

**Name**: Exercitator
**Description**: MCP bridge for Claude to access the intervals.icu API, hosted on Arca Ingens via Docker and Tailscale funnel
**Domain**: exercitator.tail*.ts.net (Tailscale funnel)
**Repository**: https://github.com/zestuart/exercitator

## Stack

- **Runtime**: Node.js + TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Database**: SQLite (via `better-sqlite3`) — local caching/state
- **Linter/Formatter**: Biome
- **Type checking**: `tsc --noEmit`
- **Test runner**: Vitest
- **Containerisation**: Docker + Docker Compose
- **Networking**: Tailscale funnel on Arca Ingens
- **External API**: [intervals.icu](https://intervals.icu) REST API

## Architecture

```
src/
  index.ts              — entry point, transport selection, session management
  intervals.ts          — intervals.icu REST client (Basic auth over HTTPS)
  auth.ts               — OAuth middleware (PKCE + passphrase + signed tokens)
  db.ts                 — SQLite cache layer (better-sqlite3, WAL mode)
  tools/
    athlete.ts          — get_athlete_profile, get_sport_settings
    activities.ts       — list_activities, get_activity, get_activity_streams, get_power_curve
    wellness.ts         — get_wellness, update_wellness
    events.ts           — list_events, create_event
```

### Key patterns

- **Per-session McpServer**: The MCP SDK allows only one transport per `McpServer`. In streamable-http mode, each session gets its own `McpServer` + `StreamableHTTPServerTransport` instance, tracked in a session map. Sessions are capped at 100 and pruned after 5 minutes idle.
- **Dual transport**: `MCP_TRANSPORT=stdio` for local dev (`claude mcp add`), `MCP_TRANSPORT=streamable-http` for Docker/funnel production.
- **OAuth middleware** (`src/auth.ts`): RFC-compliant (9728, 8414, 7591). PKCE S256 + client_credentials grants. Passphrase-gated authorisation. Self-validating HMAC-SHA256 tokens with version-based revocation. Per-IP rate limiting and lockout. Redirect URI validated against localhost allowlist. Request body capped at 64 KiB.
- **Tool registration**: Each tool module exports a `register*Tools(server, client)` function. Tools use Zod schemas for input validation. Date parameters enforce `YYYY-MM-DD` regex.
- **SQLite cache**: TTL-based cache in `data/exercitator.db`. Used for infrequently-changing data (athlete profile). WAL mode for concurrent reads.

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
MCP_OAUTH_CLIENT_SECRET=<openssl rand -hex 32>    # OAuth signing secret
MCP_OAUTH_AUTHORIZE_PASSPHRASE=<your passphrase>  # Human-memorable auth gate
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
- **Docker secrets**: Container environment variables must not be logged or exposed via health/debug endpoints.
- **OAuth redirect URI**: Must be validated against localhost allowlist to prevent open redirect attacks.
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

- **Target**: Arca Ingens (Docker Compose)
- **Method**: `docker compose up -d` on the server
- **Networking**: Tailscale funnel exposes the MCP server externally
- **Branch**: `main` — deploy from main only

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
