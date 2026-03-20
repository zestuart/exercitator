---
description: "First-run project interview. Configures CLAUDE.md, .env, test structure, CI/CD, and deployment."
user_invocable: true
---

# /init — Project Initialisation

Interview the user to configure their project for AI-assisted development. This skill
runs once (or again if the user wants to reconfigure). It populates all `[SETUP]`
sections in CLAUDE.md.

## Preamble

Before starting, check whether CLAUDE.md has already been configured (the Project
section will have real values instead of "run /init"). If it has, ask the user:
"This project appears to be already configured. Would you like to reconfigure, or
update a specific section?"

## Step 1 — Project identity

Ask the user these questions. Adjust phrasing to be conversational, not robotic.
If the user gives short answers, that's fine — don't push for more detail than needed.

1. **What's this project called?** (Name for CLAUDE.md header)
2. **What does it do?** (One-sentence description)
3. **Does it have a domain or public URL?** (Optional)
4. **Where's the repository?** (GitHub URL, or "not yet" for new projects)

## Step 2 — Technology stack

Detect what you can from the filesystem before asking:

```bash
ls -la
```

Look for: `package.json` (Node/JS/TS), `requirements.txt`/`pyproject.toml`/`Pipfile`
(Python), `Cargo.toml` (Rust), `go.mod` (Go), `Gemfile` (Ruby), `pom.xml`/
`build.gradle` (Java/Kotlin), `*.csproj` (C#/.NET), `Dockerfile`, CI config files.

Then confirm with the user:
1. **What language(s) and framework(s) are you using?** (Confirm or correct detection)
2. **What database, if any?** (Postgres, SQLite, MongoDB, none, etc.)
3. **Any external APIs or services?** (Payment providers, AI APIs, email, storage)

Fill in the Stack section of CLAUDE.md with what you learn.

## Step 3 — Credential management

Set up `.env` and `.env.example`:

1. Check if `.env` already exists
2. Check if `.gitignore` exists and contains `.env`
3. If `.gitignore` is missing or doesn't exclude `.env`, create/update it:

```bash
echo ".env" >> .gitignore
```

Explain to the user:
> Your `.env` file holds API keys and secrets. It must never be committed to git.
> I've added it to `.gitignore` to prevent accidental commits. The `.env.example`
> file documents what keys are needed — that one IS committed so collaborators
> (including future you) know what to set up.

4. Ask: **What credentials does your project need?** (API keys, database URLs, etc.)
   - If they're unsure, suggest based on the stack detected in Step 2
   - Always include `GEMINI_API_KEY` for the SAST scanner

5. Create `.env.example` with descriptive comments and placeholder values
6. If credentials are available, create `.env` with actual values
7. If the user provides actual API keys, remind them:
   > These are now safely in your `.env` file, which git will ignore. Never paste
   > these into code files, commit messages, or documentation.

## Step 4 — SAST scanner setup

Every deployment in this project includes a security scan powered by Google's
Gemini 2.5 Pro. This is a different AI model from Claude — having a second pair of
eyes from a different model family catches things that Claude might miss in its own
code. The scan is free for most projects.

1. Check if `GEMINI_API_KEY` is already in `.env` or environment
2. If not, explain and ask the user to set one up:

> Before we go further, let's set up your security scanner. Every time you deploy,
> Armature runs a SAST (Static Application Security Testing) scan using Google's
> Gemini. This catches vulnerabilities before they reach production.
>
> You'll need a free Gemini API key:
> 1. Go to https://aistudio.google.com/apikey
> 2. Sign in with a Google account
> 3. Click "Create API Key"
> 4. Copy the key
>
> I'll add it to your `.env` file (which is never committed to git, so it stays
> private).

3. Once the user provides the key, add it to `.env` and verify it works:

```bash
GEMINI_API_KEY="<key>" python3 scripts/sast_scan.py --mode full 2>&1 | head -5
```

If the API call succeeds (any output from Gemini), confirm:
> Security scanner is working. Every `/deploy` will now include a SAST scan.

If it fails, troubleshoot (expired key, wrong key, network issue) and retry.

Do NOT let the user skip this step. The security scanner is not optional — it is a
core part of the Armature workflow. If they cannot get a key right now, note it as a
blocking setup item and remind them that `/deploy` will not work without it.

## Step 5 — Security surfaces

Based on the stack and project description, identify and document security surfaces
in CLAUDE.md. Ask the user to confirm or add to the list.

Common surfaces by project type:
- **Web apps**: User input handling, authentication, file uploads, CORS, CSP
- **APIs**: Authentication, rate limiting, input validation, SSRF
- **Data processing**: Input validation, injection, resource exhaustion
- **Mobile backends**: Token management, push notifications, device trust

Write these into the Security Surfaces section of CLAUDE.md.

Also create a `SECURITY.md` file documenting:
- Known security surfaces (from above)
- An empty "Outstanding" section for accepted risks
- An empty "Remediated" section for fixed findings

## Step 6 — Test structure

Detect existing test infrastructure:

```bash
# Look for test directories and config
find . -maxdepth 3 -name "test*" -o -name "spec*" -o -name "jest.config*" -o -name "pytest.ini" -o -name "vitest.config*" -o -name ".rspec" 2>/dev/null | head -20
```

If tests exist:
- Identify the test runner and commands
- Document them in CLAUDE.md's Testing section
- Note the current test count if possible

If no tests exist, suggest an appropriate structure based on the stack:

| Stack | Suggested tools |
|-------|----------------|
| Python | ruff (lint) + mypy (types) + pytest |
| Node/JS | eslint (lint) + jest or vitest |
| TypeScript | eslint (lint) + tsc (types) + jest or vitest |
| Rust | cargo clippy (lint) + cargo test |
| Go | go vet (lint) + go test |
| Ruby | rubocop (lint) + rspec |
| Java/Kotlin | checkstyle/ktlint (lint) + JUnit |

Ask the user: **Shall I set up the test infrastructure now, or would you prefer
to do it later?**

If yes, install the tools and create:
- A test directory with a single smoke test
- Test configuration file(s)
- Document the test commands in CLAUDE.md

Update the Testing section of CLAUDE.md with:
- Lint command
- Type check command (if applicable)
- Test command
- Current test count

## Step 7 — CI/CD and deployment

Ask the user:

1. **How do you deploy?** Options:
   - Push to a branch triggers auto-deploy (e.g. Vercel, Netlify, DO App Platform)
   - CI/CD pipeline (GitHub Actions, GitLab CI, CircleCI, etc.)
   - Manual deployment (SSH, FTP, cloud console)
   - Not sure yet / haven't set this up

2. **What's your deployment target?** (Cloud platform, VPS, serverless, etc.)

3. **Do you have CI/CD already?** (Detect `.github/workflows/`, `.gitlab-ci.yml`,
   `Jenkinsfile`, `.circleci/`, etc.)

Based on answers, configure the Deployment section of CLAUDE.md:
- Branch that triggers deployment
- Deployment monitoring command (if applicable)
- CI/CD pipeline details

If they want CI/CD but don't have it, offer to create a basic GitHub Actions workflow
that runs lint + type check + tests on pull requests.

## Step 8 — Conventions

Ask the user about preferences:
1. **Any code style preferences?** (Formatting, naming conventions, etc.)
   - If none, suggest sensible defaults for their stack
2. **Preferred language for documentation?** (English, etc.)
3. **Any other conventions I should know about?**

Update the Conventions section of CLAUDE.md.

## Step 9 — Initial files

Create any files that don't yet exist:
- `CHANGELOG.md` (from template, with today's date)
- `lessons.md` (empty template with format example)
- `SECURITY.md` (from Step 4)
- `.env.example` (from Step 3)
- `.gitignore` updates (from Step 3)

Ensure `scripts/sast_scan.py` is present and executable.

## Step 10 — Verify and report

Read back the completed CLAUDE.md to verify it's coherent. Then summarise:

- Project: [name] — [description]
- Stack: [language/framework]
- Tests: [configured/not yet]
- Deployment: [method]
- Credentials: [N keys in .env]
- SAST: [ready / blocked — user needs to provide GEMINI_API_KEY before /deploy will work]

Tell the user:
> Your project is configured. Use `/test` after code changes, and `/deploy`
> when you're ready to ship. I'll maintain the documentation as we work.
