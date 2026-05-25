# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This file is Claude's operating manual. Keeping it accurate is not busywork — it is
> self-care. An outdated CLAUDE.md leads to wrong assumptions, missed context, and
> compounding errors. Treat this document and its subsidiaries as first-class code
> artifacts: review them, update them, and trust them only when they reflect reality.

## Project

**Name**: Exercitator + Praescriptor
**Description**: MCP bridge for Claude to access the intervals.icu API, plus a web UI serving daily workout prescriptions. Hosted on Cogitator (Mac Mini M4 Pro) via Docker and Tailscale (migrated from Arca Ingens 2026-04-04).
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
- **Networking**: Tailscale funnel (MCP, public) + Tailscale serve (Praescriptor + HTTP API, tailnet-only) on Cogitator
- **External API**: [intervals.icu](https://intervals.icu) REST API
- **HTTP API**: bearer-scoped REST surface for native clients (Excubitor iOS/watchOS) — port 8643, tailnet-only

## Architecture

Two co-located containers off the same codebase: **Exercitator** (MCP server + HTTP API) and **Praescriptor** (web UI). The DSW (Daily Suggested Workout) engine lives under `src/engine/` and is imported by all three surfaces — no network calls between containers. Vigil (biomechanical injury warning) hangs off `src/engine/vigil/`. Compliance tracking persists prescriptions and grades execution under `src/compliance/`.

Full file map, module responsibilities, and key patterns: see **`architecture.md`**.

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
   comments, not in documentation. The `.env` file is never committed. Secrets in
   git history are effectively public — they persist in every clone, fork, and
   backup, forever. One leaked key can mean unauthorised access, unexpected bills,
   or a full breach.

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
- **CHANGELOG.md**: Every user-visible change, every deploy. [Keep a Changelog](https://keepachangelog.com/) format with [Semantic Versioning](https://semver.org/). Security changes are always documented, even when internal-only.
- **User-facing docs**: README, API docs, guides — update them as part of the change,
  not as a separate task.
- **lessons.md**: After every bug, failed deploy, unexpected behaviour, security
  finding, or any insight that would help future development.

## Document Management

### The blooming pattern

Sections that exceed comfortable inline reading get extracted to their own files.
`CLAUDE-INDEX.md` is the index of subsidiary files. Current layout:

```
CLAUDE.md         — core rules, workflow, conventions (this file)
CLAUDE-INDEX.md   — index of all subsidiary files
architecture.md   — file map, module responsibilities, key patterns
deployment.md     — Cogitator deploy procedure, networking, volumes
SECURITY.md       — security surfaces, outstanding findings, remediation history
lessons.md        — chronological post-mortem log (append-only)
CHANGELOG.md      — user-visible changes per release
```

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

All credentials live in `.env` at the project root: gitignored, never logged or echoed, the single source of truth for API keys, tokens, and secrets. A committed `.env.example` documents required variables with placeholder values and is kept in sync with `.env`.

Every deployment includes a SAST scan via Gemini 2.5 Pro (different model family from Claude, independent review). `scripts/sast_scan.py` is zero-dependency (Python stdlib) and reads `GEMINI_API_KEY` from `.env` or environment. Diff mode during deploys (changes since last baseline), full mode on demand via `/sast`. Clean scans tag as `sast-baseline-YYYY-MM-DD`. Findings block deployment — fix or explicitly accept.

**Current baseline**: `sast-baseline-2026-05-25` on commit `9960fc3` (Stryd workout-recommendations integration phases 1–3 + defensive caps on `block.repeat` and recommendation-response size, both from the 2026-05-25 SAST findings + sast_scan.py inline-content patch for cache-disabled accounts). `python3 scripts/sast_scan.py --mode diff` scans only files changed since this tag. Re-baseline immediately after each clean deploy or accepted-risk deploy.

Full inventory of security surfaces, outstanding findings, and remediation history: see **`SECURITY.md`**.

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

Tarball upload + `docker compose up -d --build` against Cogitator (`dominus@cogitator.tail7ab379.ts.net`), three Tailscale-fronted services on the `tail7ab379.ts.net` tailnet. Deploy from `main` only.

Full target details, networking, container/volume layout, deploy procedure, and pre-flight sequence: see **`deployment.md`**. Wider home-lab conventions live in `github.com/zestuart/praefectura`.

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

## graphify

This project has a graphify knowledge graph at `graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
