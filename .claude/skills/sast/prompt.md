---
description: "Run a full SAST scan of the codebase using Gemini 2.5 Pro. Reports vulnerabilities and tags the baseline."
user_invocable: true
---

# /sast — Full SAST Scan

Run a comprehensive static application security test against all source code using
Google's Gemini 2.5 Pro as the analysis engine. Gemini is used deliberately — a
different model family from Claude provides independent security review.

## Prerequisites

`GEMINI_API_KEY` must be available in `.env` or shell environment.
If missing, tell the user:
> SAST scanning requires a Gemini API key. Get one free at
> https://aistudio.google.com/apikey and add `GEMINI_API_KEY=<key>` to your .env file.

## Step 1 — Run the scanner

```bash
python3 scripts/sast_scan.py --mode full 2>&1
```

Use a **600-second timeout** (large context, Gemini may think for a while).

## Step 2 — Evaluate results

The script exits with:
- **0** = no findings (response contains `NO_FINDINGS`)
- **1** = findings reported
- **2** = error (API key missing, network failure, etc.)

### If exit code 0 (no findings):

Report "SAST scan complete — no vulnerabilities found" and proceed to Step 3.

### If exit code 1 (findings):

Present the findings to the user. Then for each finding:

1. Read the referenced file(s) to verify the finding is genuine (not a false positive)
2. Classify as **actionable** or **false positive** with a brief justification
3. For actionable findings, propose a specific code fix

Ask the user for each finding:
- "Fix now" — implement fixes, then re-run the scan to verify
- "Accept risk" — document in SECURITY.md under Outstanding
- "False positive" — note in scan report, no action needed

Do NOT proceed to Step 3 with unacknowledged findings.

### If exit code 2 (error):

Report the error and stop. Do not proceed.

## Step 3 — Update baseline tag

After all findings are resolved (or none were found), tag the current commit:

```bash
git tag sast-baseline-$(date +%Y-%m-%d) HEAD
```

If a tag with today's date already exists, append a counter:

```bash
git tag sast-baseline-$(date +%Y-%m-%d)-2 HEAD
```

## Step 4 — Report

Summarise:
- Files scanned (count)
- Gemini token usage (from stderr output)
- Findings: N actionable, N false positives, N accepted risk
- Baseline tag created
- Any fixes applied (list files changed)
