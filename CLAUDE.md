# Armature — AI-Assisted Development Framework

> This file is Claude's operating manual. Keeping it accurate is not busywork — it is
> self-care. An outdated CLAUDE.md leads to wrong assumptions, missed context, and
> compounding errors. Treat this document and its subsidiaries as first-class code
> artifacts: review them, update them, and trust them only when they reflect reality.

<!-- ============================================================
     SECTIONS MARKED [SETUP] ARE POPULATED BY /setup ON FIRST RUN.
     RUN /setup BEFORE STARTING DEVELOPMENT.
     ============================================================ -->

## Project

<!-- [SETUP] Project identity — filled by /setup interview -->

**Name**: _not yet configured — run /setup_
**Description**: _pending_
**Domain**: _pending_
**Repository**: _pending_

## Stack

<!-- [SETUP] Technology stack — filled by /setup interview -->

_Run /setup to configure._

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
- Listed in `.gitignore` (verified by /setup)
- Never committed, logged, or echoed
- The single source of truth for all API keys, tokens, and secrets

A `.env.example` file documents required variables with placeholder values. This file
IS committed and kept in sync with `.env`.

```bash
# .env.example — commit this, not .env
GEMINI_API_KEY=your-gemini-api-key-here    # Required for SAST scans
# Add project-specific keys below
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

<!-- [SETUP] Document project-specific attack surfaces here.
     Examples: file uploads, authentication, external APIs, user input handling.
     The SAST scanner uses this section for focused analysis. -->

_Run /setup to configure._

## Testing

<!-- [SETUP] Test configuration — filled by /setup interview.
     /setup will detect your language/framework and suggest an appropriate test
     structure: linter, type checker, unit tests, integration tests. -->

_Run /setup to configure._

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

<!-- [SETUP] Deployment configuration — filled by /setup interview.
     /setup will ask about your deployment target and CI/CD setup. -->

_Run /setup to configure._

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

<!-- [SETUP] Project conventions — filled by /setup interview.
     Language style, formatting, naming conventions, etc. -->

- ISO 8601 dates (YYYY-MM-DD), 24-hour time (HH:MM)
- Commit messages: imperative mood, concise summary, optional body
- Co-author attribution on AI-assisted commits

## Skills

| Command   | Description |
|-----------|-------------|
| `/setup`  | First-run project interview — configures everything |
| `/test`   | Run the test suite (lint + type check + tests) |
| `/deploy` | Pre-flight checks + SAST + commit + push + monitor |
| `/sast`   | Full SAST scan of the entire codebase |
