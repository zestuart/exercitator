# CLAUDE-INDEX

Index of all subsidiary documentation files. See `CLAUDE.md` for core rules, workflow, and conventions.

| File | Description |
|------|-------------|
| `CLAUDE.md` | Core rules, workflow, conventions — slim operating manual with pointers |
| `architecture.md` | File map, module responsibilities, key patterns (extracted from CLAUDE.md 2026-05-12) |
| `decision-model.md` | How a workout is chosen — readiness weights, data sources, category ladder + guards, vendor swap (human-facing + Claude reference) |
| `deployment.md` | Cogitator deploy procedure, networking, container/volume layout (extracted from CLAUDE.md 2026-05-12) |
| `CHANGELOG.md` | Keep a Changelog format, all user-visible changes |
| `lessons.md` | Chronological post-mortem log (append-only) |
| `SECURITY.md` | Security surfaces, outstanding findings, remediation history |
| `stryd-api.md` | Stryd PowerCenter API reference (auth, endpoints, FIT fields) |
| `phase2/exercitator-http-api-spec.md` | HTTP API for native clients — wire contract (v0.2, superseded by phase3 delta) |
| `phase2/exercitator-http-api-plan.md` | HTTP API implementation plan + decisions |
| `phase2/dsw-spec.md` | Daily Suggested Workout — original implementation specification (v1, historical) |
| `phase2/dsw-spec-v2.md` | Daily Suggested Workout — implementation specification v2 (current reference for `suggest_workout` MCP tool) |
| `phase2/injury-warning-spec.md` | Vigil biomechanical injury warning system specification |
| `phase2/2026-03-28_vigil-injury-research.md` | Pre-implementation research notes for Vigil |
| `phase2/exercitator-structured-steps-feature.md` | Backlog spec — structured `workout_doc.steps[]` for Suunto/Garmin sync (low priority, not yet implemented) |
| `phase2/promus-calibration-migration-resume-2026-05-08.md` | Session-resume prompt for the Promus calibration migration (paused 2026-05-08; six interview questions answered) |
| `phase2/cross-training-muscle-group-research-2026-05-12.md` | Decision document for cross-training muscle-group awareness — variant comparison, literature, Phase 1 / Phase 2 split (issues #33 / #34) |
| `phase2/research-2026-05-12/README.md` | Raw research artefacts companion to the 2026-05-12 cross-training decision doc (Promus + intervals.icu data pull, analysis script) |
| `phase3/exercitator-http-api-v0.3-delta.md` | HTTP API v0.3 — canonical wire contract (push-to-stryd, form-text) |
| `phase3/exercitator-http-api-v0.3-amendment-proposal-2026-05-03.md` | Excubitor amendment proposal + §7 team response (calendar_id type drift) |
| `phase3/exercitator-http-api-v0.3-amendment-resolution-2026-05-03.md` | Resolution memo for Excubitor team — types, struct template, verification (commit `bf1393b`) |
| `notes/excubitor/api-0.2.0.md` | Cross-repo migration note for Excubitor/Nunc: decode `status: "already_trained"` + `rest_message` block |
| `notes/excubitor/api-0.2.1.md` | Cross-repo migration note for Excubitor/Nunc: decode `invocation` block on every `ready` response |
| `notes/excubitor/api-0.2.2.md` | Cross-repo migration note for Excubitor/Nunc: decode `status: "health_unavailable"` (503) + whole-athlete readiness + WHOOP-sourced Sleep/HRV |
| `praescriptor-web-spec.md` | Praescriptor web UI specification |
| `exercitator-api-spec.md` | HTTP API v0.1 draft (superseded — historical scaffolding only) |
