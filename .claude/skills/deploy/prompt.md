---
description: "Deploy to production. Pre-flight checks, SAST scan, commit, push, and monitor."
argument-hint: "[commit message (optional)]"
user_invocable: true
---

# /deploy — Deploy to Production

Deploy the current working tree to production. Every step exists to prevent a bad
deployment. Skipping steps is not an option.

**Core principle**: A missed deployment is always better than an insecure deployment.
If any check fails, stop. Fix the issue. Then try again. Shipping broken or insecure
code creates far more work than the delay of fixing it first.

## Step 0 — Read deployment configuration

Read CLAUDE.md's Deployment section for:
- Deploy branch (default: `main`)
- Deployment method (auto-deploy on push, CI/CD, manual)
- Monitoring command (if configured)

If the Deployment section says "Run /setup to configure", tell the user:
> Deployment isn't configured yet. Run /setup first, or tell me your deployment
> target and method.

## Step 1 — Pre-flight: lint + type check + tests

Run the full test suite as defined in CLAUDE.md's Testing section.

```
# Run whatever commands are configured in CLAUDE.md Testing section
```

If any step fails, **stop and report the failure**. Do NOT proceed.

## Step 2 — Pre-flight: verify migrations (if applicable)

If the project uses database migrations (Alembic, Prisma, Knex, ActiveRecord, etc.),
check for new migration files and verify the chain is unbroken:

- New migrations should reference the correct parent
- Migration filenames should follow the project's convention

A broken migration chain can crash the application on deploy.

## Step 3 — Pre-flight: check for secrets and large files

```bash
git diff --cached --name-only
git status --short
```

**ABORT** if any of these are staged:
- `.env`, `*.tfvars`, `terraform.tfstate*`, credentials, tokens, private keys
- Files > 10 MB (media, binaries, data dumps)
- Any file matching patterns in `.gitignore` that was force-added

Explain to the user WHY if you abort:
> I found [file] staged for commit. This appears to contain [secrets/large binary].
> Committing this would [expose credentials in git history / bloat the repository].
> I've stopped the deploy. Please unstage this file and try again.

## Step 4 — Pre-flight: documentation check

Verify:
1. `CHANGELOG.md` has entries under `[Unreleased]` for the changes being deployed
2. CLAUDE.md is consistent with the current code (spot check — not a full audit)

If the changelog is missing entries, add them before proceeding. Categorise changes
as Added, Changed, Fixed, Security, or Removed per Keep a Changelog format.

## Step 5 — Pre-flight: SAST scan

Run the SAST scanner in diff mode:

```bash
python3 scripts/sast_scan.py --mode diff 2>&1
```

Use a **600-second timeout** (Gemini may need time to think).

**If `GEMINI_API_KEY` is not set** (not in `.env` or environment):
- Tell the user: "SAST scan requires a Gemini API key. Get one free at
  https://aistudio.google.com/apikey and add it to your .env file."
- Do NOT proceed without the scan. Do NOT offer to skip it.
- The ONLY exception: if this is the very first commit in a brand new repository
  with only boilerplate files, note that the scan was skipped for this reason.

**Exit code 0 (no findings)**: Report "SAST scan clean" and continue.

**Exit code 1 (findings)**: This is a **deploy blocker**.
1. Present each finding to the user
2. For each finding, read the referenced code to verify it's genuine
3. Classify as actionable or false positive with brief justification
4. Ask the user for each finding:
   - "Fix and continue" — implement fixes, re-run the scan
   - "Accept risk and deploy" — the user acknowledges the finding explicitly
   - "Abort deploy" — stop entirely

**Exit code 2 (scanner error)**: Report the error. Do NOT proceed without a scan.
Suggest the user check their `GEMINI_API_KEY` and try again.

## Step 6 — Commit

Stage all relevant files (be specific — avoid `git add .`):

```bash
git add <specific files>
```

Commit with a descriptive message. If $ARGUMENTS is provided, use it as the commit
message. Otherwise, analyse the diff and write one.

```bash
git commit -m "$(cat <<'EOF'
<imperative summary>

<optional body explaining why, not what>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Step 7 — Push

Push to the configured deploy branch:

```bash
git push origin <deploy-branch>
```

If the push fails due to divergence, **do NOT force push**. Report the issue and
ask the user how to proceed.

## Step 8 — Monitor deployment (if configured)

If a monitoring command is configured in CLAUDE.md, run it once to check initial
deployment status. Do NOT poll in a loop — report the status and note how the user
can check progress.

If CI/CD is configured, check the pipeline status:

```bash
# GitHub Actions example
gh run list --limit 1
```

## Step 9 — Post-deploy

1. Update `lessons.md` if anything unexpected happened during the deploy
2. Report summary:
   - Files changed (count)
   - New migrations (if any)
   - Lint/test status
   - SAST status (clean / findings accepted)
   - Commit hash
   - Deployment status
