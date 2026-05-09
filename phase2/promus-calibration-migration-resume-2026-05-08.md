# Promus calibration migration — resume prompt

**Created**: 2026-05-08
**Replaces interview state in**: `~/.claude/projects/-Users-ze-Documents-claude-exercitator/memory/project_promus_calibration_migration.md` (§3)

## Resume instruction (paste into a fresh session)

> Resume the Promus calibration migration. The six interview questions are now answered (below). Read this whole file, then read `/Users/ze/Documents/claude/promus/docs/backend-spec.md` and the Promus migrations dir as **read-only**. Then draft a plan with chain-of-reasoning + devil's advocate covering Exercitator-side and Promus-side changes. Submit for review before filing any issues or writing code.

## Decisions (from interview, 2026-05-08)

### 1. Scope of "the data" — **(c) calibrated values + audit trail + underlying activity data**

Rationale: centralise on one point of truth. Promus eventually owns:
- Calibrated thresholds: `threshold_pace`, `lthr`, `hr_zones`, `ftp`, derived zones
- Recompute audit trail: drift-detector runs, observed delta, source sessions
- Underlying activity data: swim streams length-by-length, HR series, lap structure

This is bigger than the original Tier-2 scope. Plan must phase it: thresholds first, audit trail next, activity streams last.

### 2. Flow direction during transition — **(c) dual-write during deprecation window**

Exercitator dual-writes to Promus and intervals.icu while consumers migrate. After the window, Exercitator reads from Promus only and intervals.icu drops out as a source-of-truth (it may still be a *destination* for athlete-facing display until Praescriptor switches off it).

Promus does **not** need to mirror outbound to intervals.icu — Exercitator handles both writes during the window.

### 3. Activity data sourcing — **Promus should eventually own swim streams**

Long-term: Exercitator stops calling intervals.icu for activity stream data and pulls from Promus instead. This composes with answer (1c). Acknowledged that stream ingestion is a much larger schema than threshold storage — phase it after thresholds + audit trail are stable.

### 4. Schema versioning philosophy — **Open an issue on `zestuart/promus` to ask**

Do **not** guess house style. File an issue on the Promus repo asking: "What's the canonical pattern for versioned/historical rows? E.g. one row per `(user, sport, metric, effective_date)`, event-sourced, `_history` companion tables, etc.? I want to match house style for the calibration migration."

This question blocks the schema design issue. Wait for the answer before drafting migrations.

### 5. Auth model — **dedicated Exercitator key, stored in `.env`**

Exercitator-as-Promus-client gets its own bearer token in `PROMUS_API_KEYS` on the Promus side, value held in Exercitator's `.env` (e.g. `PROMUS_API_KEY=...`). If Promus's current auth model doesn't support per-client scoping, that's a separate Promus-side feature request — flag it but don't block on it for v1 (a shared key is acceptable as long as the secret is dedicated to Exercitator's identity).

Add the new env var to `.env.example` with a placeholder when implementation starts. Never commit the real value.

### 6. Compliance data home — **stays in Exercitator's SQLite**

The prescribed-vs-actual dataset stays where it is. Reasoning: it's downstream of the prescription engine, low usage right now, and moving it adds scope without payoff. Revisit if compliance becomes a primary feature.

## Plan structure (when resuming)

1. **Read-only audit**:
   - `/Users/ze/Documents/claude/promus/docs/backend-spec.md`
   - `/Users/ze/Documents/claude/promus/migrations/` (latest is `0016_whoop_burst_hrv.sql` per memory; verify)
   - `/Users/ze/Documents/claude/promus/README.md`

2. **Draft plan covering**:
   - **Phase A — Thresholds**: Promus schema for calibrated values, dual-write from Exercitator, read path migration. Exercitator changes: new Promus client module, dual-write hooks, read-from-Promus toggle.
   - **Phase B — Audit trail**: drift-detector runs as first-class records (Tier 2 of the five-tier defence — see memory entry §2). Schema for `(detector_run, metric, observed_value, prior_value, delta, source_session_ids[])`.
   - **Phase C — Activity streams**: swim streams length-by-length, HR series, lap structure. Largest schema. Last to land.
   - For each phase: Exercitator changes + Promus changes + cutover criteria.

3. **Issues to file** (in order):
   - Promus issue: "What's the canonical schema versioning pattern?" (blocks A.)
   - Promus issue: "Phase A schema — calibration thresholds + audit trail" (after Q4 answered)
   - Promus issue: "Phase C schema — activity streams" (much later)
   - Exercitator issues: only after corresponding Promus issue closes.

4. **Devil's advocate prompts to address in plan**:
   - What breaks if Promus is unreachable mid-prescription? (Cache fallback? Stale-tolerant read?)
   - How does dual-write fail safely? (Promus write fails → log + continue, never block the intervals.icu write?)
   - Migration of existing thresholds: import once, or compute fresh from history?
   - Praescriptor still reads thresholds via Exercitator — does it ever talk to Promus directly? (Probably no in Phase A; revisit later.)
   - Test strategy for dual-write — golden-file vs end-to-end?

## Constraints (do not violate)

- `/Users/ze/Documents/claude/promus` is **read-only** for this work. Promus changes go via issues on `zestuart/promus`, not direct edits.
- Exercitator implementation does **not** start until the corresponding Promus issue closes (i.e. schema and migration live).
- Never invent commit SHAs, PR numbers, or `file:line` citations.
- Never commit `PROMUS_API_KEY` value.

## Pointers (from prior session memory, verify before citing)

- Calibrated swim values already in intervals.icu and `reference_swim_thresholds.md`: CSS 0.94 m/s, LTHR 140, hr_zones [118, 125, 131, 139, 143, 147, 161].
- DSW unit-mismatch fix shipped commit `413daf8` — `swimPaceDesc` uses `100 / threshold_pace`.
- Promus stack: Rust + axum + sqlx + Postgres on Cogitator, port 8080, bearer auth (`PROMUS_API_KEYS`).
- Promus memory dir: `/Users/ze/.claude/projects/-Users-ze-Documents-claude-promus/memory/` — has WHOOP MG / HRV burst / Cogitator / Nunc-Excubitor split context.

## Five-tier defence status (recap from memory §2)

| Tier | Mechanism | Status after migration |
|---|---|---|
| 1 | Auto-maintained (Stryd CP, Vigil baselines) | live; unchanged |
| 2 | Monthly drift detector (recompute CSS/LTHR, write if Δ > threshold) | **target of this migration; Promus owns the data** |
| 3 | Quarterly TT calendar prompt | not yet scheduled |
| 4 | Compliance-driven self-correction | needs more compliance data; stays in Exercitator |
| 5 | Brand types (`SpeedMps`/`PacePer100m`) | optional codebase hardening |
