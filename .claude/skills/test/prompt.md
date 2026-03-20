---
description: "Run the test suite. Lint, type check, and tests — language-agnostic."
user_invocable: true
---

# /test — Run Test Suite

Run the project's configured test suite. Report results clearly and concisely.

## Step 0 — Detect test configuration

Read the Testing section of CLAUDE.md to find the configured commands for:
- Lint
- Type check (if applicable)
- Unit/integration tests

If the Testing section says "Run /setup to configure", tell the user:
> Tests aren't configured yet. Run /setup to set up your test infrastructure,
> or tell me what test commands to use.

## Step 1 — Lint

Run the configured lint command. If it fails, show the errors. Do NOT attempt to
fix unless the user asks.

## Step 2 — Type check (if configured)

Run the configured type check command. If it fails, show the errors. Do NOT attempt
to fix unless the user asks.

## Step 3 — Run tests

Run the configured test command. Use a 120-second timeout (adjustable per project).

If tests fail:
- Show the first failure clearly
- Do NOT attempt to fix unless the user asks

## Step 4 — Report

**If all pass**: Report lint status + test count/runtime in one line.

**If any fail**: Show which step failed and the relevant error output.

## Step 5 — Test growth check

After reporting results, quickly check whether new code paths lack test coverage:

1. Look at recently modified files (from git status)
2. Check if corresponding test files exist
3. If new functionality was added without tests, suggest (but don't insist):
   > I notice [file/function] was added without a corresponding test. Want me to
   > add one?

This check is advisory only — it should never block or slow down the test report.
