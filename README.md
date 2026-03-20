# Armature

A framework for AI-assisted software development with Claude Code.

Armature provides structure for projects where Claude is the primary developer:
automated testing, security scanning, deployment workflows, and self-maintaining
documentation. It is designed for both experienced engineers and citizen developers
building their first project.

## What you get

- **CLAUDE.md** — a living operating manual that Claude maintains as your project grows
- **`/setup`** — an interview that configures your project on first run
- **`/test`** — language-agnostic test runner that grows with your code
- **`/deploy`** — pre-flight checks, SAST security scan, and deployment
- **`/sast`** — static application security testing via Gemini 2.5 Pro
- **`sast_scan.py`** — zero-dependency security scanner (Python stdlib only)

## Quick start

1. Copy the contents of this repository into your project root:

   ```bash
   cp CLAUDE.md /path/to/your/project/
   cp CHANGELOG.md /path/to/your/project/
   cp -r .claude /path/to/your/project/
   cp -r scripts /path/to/your/project/
   cp .env.example /path/to/your/project/
   ```

2. Open your project in Claude Code and run:

   ```
   /setup
   ```

   Claude will interview you about your project, configure the CLAUDE.md, set up
   your `.env`, suggest a test structure, and configure deployment.

3. Start building. Use `/test` after changes and `/deploy` when ready.

## Requirements

- [Claude Code](https://claude.ai/claude-code) CLI
- Python 3.8+ (for the SAST scanner)
- A Gemini API key (free at https://aistudio.google.com/apikey)
- Git

## The name

In sculpture, the armature is the internal skeleton built before the clay goes on —
the hidden structure that makes the work possible. In a motor, it's the core that
makes the machine turn. Armature is the framework that gives AI-assisted development
its shape.

## Philosophy

- **Security is non-negotiable** — no deploy without a clean SAST scan
- **Tests grow with the project** — every bug becomes a test
- **Documentation is code** — Claude maintains it, not as a chore, but as self-care
- **Lessons are permanent** — every failure prevents a future one
- **Never commit secrets** — `.env` is canonical, always

## Licence

MIT
