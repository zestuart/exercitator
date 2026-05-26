# Graph Report - /Users/ze/Documents/claude/exercitator  (2026-05-02)

## Corpus Check
- 113 files · ~104,044 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 793 nodes · 1475 edges · 64 communities detected
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 262 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Docs Hub & Research Citations|Docs Hub & Research Citations]]
- [[_COMMUNITY_Compliance Aggregation Pipeline|Compliance Aggregation Pipeline]]
- [[_COMMUNITY_DSW Engine & Compliance Scoring|DSW Engine & Compliance Scoring]]
- [[_COMMUNITY_API Cache & Error Envelope|API Cache & Error Envelope]]
- [[_COMMUNITY_Compliance Wire API Layer|Compliance Wire API Layer]]
- [[_COMMUNITY_SQLite DB Access Layer|SQLite DB Access Layer]]
- [[_COMMUNITY_Test Mocks & Fixtures|Test Mocks & Fixtures]]
- [[_COMMUNITY_Workout Formatting & Deity Invocations|Workout Formatting & Deity Invocations]]
- [[_COMMUNITY_SAST Scanner (Gemini)|SAST Scanner (Gemini)]]
- [[_COMMUNITY_MCP Entry & External API Clients|MCP Entry & External API Clients]]
- [[_COMMUNITY_Vigil Pipeline Modules|Vigil Pipeline Modules]]
- [[_COMMUNITY_Praescriptor Render & FORM Output|Praescriptor Render & FORM Output]]
- [[_COMMUNITY_Workout Builder Segments|Workout Builder Segments]]
- [[_COMMUNITY_OAuth Handler Internals|OAuth Handler Internals]]
- [[_COMMUNITY_Intervals Workout Formatter|Intervals Workout Formatter]]
- [[_COMMUNITY_HTTP API Bearer Auth|HTTP API Bearer Auth]]
- [[_COMMUNITY_Readiness Scoring Engine|Readiness Scoring Engine]]
- [[_COMMUNITY_Stryd PowerCenter Client|Stryd PowerCenter Client]]
- [[_COMMUNITY_DSW Orchestrator & Prescriptions|DSW Orchestrator & Prescriptions]]
- [[_COMMUNITY_Vigil DB & Scorer Tests|Vigil DB & Scorer Tests]]
- [[_COMMUNITY_Workout Send Targets (Intervals + Stryd)|Workout Send Targets (Intervals + Stryd)]]
- [[_COMMUNITY_OAuth Security Primitives|OAuth Security Primitives]]
- [[_COMMUNITY_Stryd FIT Enrichment Pipeline|Stryd FIT Enrichment Pipeline]]
- [[_COMMUNITY_Workout Format Outputs|Workout Format Outputs]]
- [[_COMMUNITY_Cache Helpers|Cache Helpers]]
- [[_COMMUNITY_Stryd External API|Stryd External API]]
- [[_COMMUNITY_Staleness Detection|Staleness Detection]]
- [[_COMMUNITY_Terrain Selection|Terrain Selection]]
- [[_COMMUNITY_Render Layer|Render Layer]]
- [[_COMMUNITY_Vigil Metrics|Vigil Metrics]]
- [[_COMMUNITY_Intervals Client|Intervals Client]]
- [[_COMMUNITY_Deity Invocations|Deity Invocations]]
- [[_COMMUNITY_Send to Intervals|Send to Intervals]]
- [[_COMMUNITY_ApiKey Interface|ApiKey Interface]]
- [[_COMMUNITY_Intervals Probe|Intervals Probe]]
- [[_COMMUNITY_Stryd Probe|Stryd Probe]]
- [[_COMMUNITY_Enrichment Tracking|Enrichment Tracking]]
- [[_COMMUNITY_Terrain Selector File|Terrain Selector File]]
- [[_COMMUNITY_Engine Type Defs|Engine Type Defs]]
- [[_COMMUNITY_WorkoutCategory Type|WorkoutCategory Type]]
- [[_COMMUNITY_Vigil Backfill File|Vigil Backfill File]]
- [[_COMMUNITY_Vigil Baseline File|Vigil Baseline File]]
- [[_COMMUNITY_Vigil Fit-Parser File|Vigil Fit-Parser File]]
- [[_COMMUNITY_Vigil Index File|Vigil Index File]]
- [[_COMMUNITY_Vigil Scorer File|Vigil Scorer File]]
- [[_COMMUNITY_Vigil Types File|Vigil Types File]]
- [[_COMMUNITY_Workout Builder File|Workout Builder File]]
- [[_COMMUNITY_Workout Selector File|Workout Selector File]]
- [[_COMMUNITY_Stryd Client File|Stryd Client File]]
- [[_COMMUNITY_Stryd Enricher File|Stryd Enricher File]]
- [[_COMMUNITY_Activities Tool|Activities Tool]]
- [[_COMMUNITY_Athlete Tool|Athlete Tool]]
- [[_COMMUNITY_Compliance Tool|Compliance Tool]]
- [[_COMMUNITY_Events Tool|Events Tool]]
- [[_COMMUNITY_Suggest Tool|Suggest Tool]]
- [[_COMMUNITY_Wellness Tool|Wellness Tool]]
- [[_COMMUNITY_Form-Format File|Form-Format File]]
- [[_COMMUNITY_Invocations File|Invocations File]]
- [[_COMMUNITY_Prescriptions File|Prescriptions File]]
- [[_COMMUNITY_Routes File|Routes File]]
- [[_COMMUNITY_Auth Test File|Auth Test File]]
- [[_COMMUNITY_Power-Source Test File|Power-Source Test File]]
- [[_COMMUNITY_Readiness Test File|Readiness Test File]]
- [[_COMMUNITY_Sport-Selector Test File|Sport-Selector Test File]]

## God Nodes (most connected - your core abstractions)
1. `getDb()` - 28 edges
2. `handleDashboard()` - 18 edges
3. `localDateStr()` - 18 edges
4. `Daily Suggested Workout engine` - 18 edges
5. `handleRoutes()` - 17 edges
6. `handleStatus()` - 17 edges
7. `suggestWorkoutFromData()` - 17 edges
8. `handleWorkoutsSuggested()` - 15 edges
9. `generatePrescriptions()` - 14 edges
10. `apiError()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `src/api/auth.ts — bearer auth middleware` --semantically_similar_to--> `MCP OAuth (PKCE S256) middleware`  [INFERRED] [semantically similar]
  src/api/auth.ts → CLAUDE.md
- `SAST scanner script (Gemini 2.5 Pro)` --rationale_for--> `CLAUDE.md operating manual`  [INFERRED]
  scripts/sast_scan.py → CLAUDE.md
- `src/api/cache.ts — per-user response cache` --implements--> `Exercitator HTTP API spec v0.2`  [INFERRED]
  src/api/cache.ts → phase2/exercitator-http-api-spec.md
- `runVigilPipeline()` --conceptually_related_to--> `Vigil biomechanical injury warning pipeline`  [INFERRED]
  src/engine/vigil/index.ts → phase2/injury-warning-spec.md
- `runBackfill()` --conceptually_related_to--> `Vigil biomechanical injury warning pipeline`  [INFERRED]
  src/engine/vigil/backfill.ts → phase2/injury-warning-spec.md

## Hyperedges (group relationships)
- **Three Tailscale sidecars + co-resident HTTP listeners on Cogitator** — docker_compose_exercitator_service, docker_compose_praescriptor_service, docker_compose_tailscale_exercitator, docker_compose_tailscale_praescriptor, docker_compose_tailscale_exercitator_api [EXTRACTED 0.95]
- **Vigil pipeline: research → spec → implementation concepts** — vigil_research_doc, injury_warning_spec_doc, concept_vigil_pipeline, concept_stryd_fit_enrichment, vigil_research_principle_personal_baseline [EXTRACTED 0.90]
- **HTTP API request chain: bearer auth + cache + error envelope** — api_auth_requirebearer, api_cache_get, api_errors_apierror, api_auth_matchbearer [INFERRED 0.85]
- **Daily Suggested Workout pipeline** — suggest_orchestrator, power_source_detect, readiness_compute, staleness_compute, ct_strain_assess, sport_selector_select [EXTRACTED 0.95]
- **Compliance assessment + aggregation pipeline** — compliance_persist_prescription, compliance_assess_compliance, compliance_persist_save_assessment, compliance_aggregate_recompute, compliance_aggregate_build_trend [EXTRACTED 0.90]
- **HTTP API request lifecycle (auth -> resolve -> handler -> payload)** — server_start_api, router_handle_api_request, router_resolve_user, payload_suggestion_to_api, api_types_dto [EXTRACTED 0.90]
- **Vigil pipeline: parse → baseline → score** — vigil_fitparser_extract_metrics, vigil_baseline_compute_baselines, vigil_scorer_score_deviations [EXTRACTED 0.95]
- **Stryd enrichment: download → upload → record** — stryd_client_download_fit, src_intervals_client, stryd_enricher_enrich_low_fidelity [EXTRACTED 0.90]
- **MCP tool registration in createMcpServer** — src_index_create_mcp_server, tools_athlete_register, tools_activities_register, tools_suggest_register, tools_compliance_register [EXTRACTED 1.00]
- **Praescriptor request pipeline (route -> prescription -> render)** — routes_handle_main_page, prescriptions_generate, render_page [INFERRED 0.90]
- **Workout send targets (intervals.icu and Stryd)** — send_intervals_func, send_stryd_func, prescriptions_generate [INFERRED 0.85]
- **Deity invocation fallback chain (API -> static -> plain)** — invocations_generate, invocations_generate_from_api, invocations_static_fallback [EXTRACTED 1.00]
- **Vigil testing pipeline (parser → metrics → baseline → scorer)** — tests_engine_vigil_fit_parser, tests_engine_vigil_metrics, tests_engine_vigil_baseline, tests_engine_vigil_scorer [INFERRED 0.85]
- **DSW engine selector tests (staleness, terrain, workout, suggest)** — tests_engine_staleness, tests_engine_terrain_selector, tests_engine_workout_selector, tests_engine_suggest [INFERRED 0.80]
- **Praescriptor output format tests (FORM, intervals.icu, send, prescriptions)** — tests_web_form_format, tests_web_intervals_format, tests_web_send, tests_web_prescriptions [INFERRED 0.80]

## Communities

### Community 0 - "Docs Hub & Research Citations"
Cohesion: 0.04
Nodes (76): src/api/auth.ts — bearer auth middleware, src/api/cache.ts — per-user response cache, src/api/errors.ts — JSON error envelope, HTTP API release notes, Unreleased changelog entries, Vigil phases 1–5 release log, Davis & Gruber 2021 — leg/joint stiffness unrelated to injury, Encarnación-Martínez et al. 2025 — fatigue kinematic clustering (+68 more)

### Community 1 - "Compliance Aggregation Pipeline"
Cohesion: 0.06
Nodes (57): parseBindAddr(), startApiServer(), buildComplianceTrend(), monthStart(), recomputeAggregates(), weekStart(), boolToInt(), getComplianceAggregates() (+49 more)

### Community 2 - "DSW Engine & Compliance Scoring"
Cohesion: 0.04
Nodes (31): assessCompliance(), flattenSegments(), hrToZone(), scoreSegment(), unassessedSegment(), assessCrossTrainingStrain(), assessStrainFromHrv(), assessStrainFromSessionRpe() (+23 more)

### Community 3 - "API Cache & Error Envelope"
Cohesion: 0.08
Nodes (49): cacheGet(), cacheInvalidate(), cacheKey(), cacheSet(), ttlMs(), apiError(), jsonResponse(), advisoryForTier() (+41 more)

### Community 4 - "Compliance Wire API Layer"
Cohesion: 0.05
Nodes (66): API wire DTOs, buildComplianceTrend, recomputeAggregates, assessCompliance, flattenSegments, handleComplianceDetail, handleComplianceSummary, hrToZone (+58 more)

### Community 5 - "SQLite DB Access Layer"
Cohesion: 0.09
Nodes (35): cacheDel(), cacheGet(), cachePrune(), cacheSet(), countVigilMetrics(), delStmt(), getDb(), getDbPath() (+27 more)

### Community 6 - "Test Mocks & Fixtures"
Cohesion: 0.08
Nodes (13): createMockClient(), loadFixture(), loadFixture(), makeMockIntervals(), createMcpServer(), IntervalsClient, getAthleteTz(), registerActivityTools() (+5 more)

### Community 7 - "Workout Formatting & Deity Invocations"
Cohesion: 0.06
Nodes (37): Anthropic Messages API, buildIntervalsDescription, formatHrTarget, formatRunTarget, formatSwimStep, generateInvocations, generateFromApi, plainInvocations (+29 more)

### Community 8 - "SAST Scanner (Gemini)"
Cohesion: 0.1
Nodes (34): _api_request(), _api_url(), build_audit_instruction(), build_cached_content(), build_source_bundle(), build_system_instruction(), call_gemini_with_cache(), create_cache() (+26 more)

### Community 9 - "MCP Entry & External API Clients"
Cohesion: 0.08
Nodes (27): intervals.icu external API, Stryd FIT enrichment, createMcpServer(), src/index.ts (entry point), IntervalsClient class, StrydClient.downloadFit(), enrichLowFidelityActivities(), registerActivityTools() (+19 more)

### Community 10 - "Vigil Pipeline Modules"
Cohesion: 0.1
Nodes (13): computeBaselines(), computeBaselinesFromData(), computeMetricBaseline(), daysAgoStr(), mean(), stddev(), makeDuoRecord(), makeRecord() (+5 more)

### Community 11 - "Praescriptor Render & FORM Output"
Cohesion: 0.14
Nodes (23): buildFormDescription(), extractDistance(), formatRest(), formatSegment(), inferStroke(), toSetType(), zoneToEffort(), clientJs() (+15 more)

### Community 12 - "Workout Builder Segments"
Cohesion: 0.27
Nodes (23): buildRationale(), buildRunBase(), buildRunIntervals(), buildRunLong(), buildRunRecovery(), buildRunTempo(), buildSwimBase(), buildSwimIntervals() (+15 more)

### Community 13 - "OAuth Handler Internals"
Cohesion: 0.16
Nodes (12): authoriseFormHtml(), clientIp(), createOAuthHandler(), html(), isLockedOut(), isRateLimited(), json(), readBody() (+4 more)

### Community 14 - "Intervals Workout Formatter"
Cohesion: 0.23
Nodes (10): buildIntervalsDescription(), extractSwimCue(), extractSwimDistance(), extractSwimPace(), formatDuration(), formatHrTarget(), formatRunTarget(), formatSwimStep() (+2 more)

### Community 15 - "HTTP API Bearer Auth"
Cohesion: 0.21
Nodes (6): extractBearer(), loadApiKeys(), matchBearer(), parseApiKeys(), requireBearer(), makeContext()

### Community 16 - "Readiness Scoring Engine"
Cohesion: 0.35
Nodes (8): clamp(), computeHrv(), computeReadiness(), computeRecency(), computeSleep(), computeSubjective(), computeTsb(), lerp()

### Community 17 - "Stryd PowerCenter Client"
Cohesion: 0.29
Nodes (1): StrydClient

### Community 18 - "DSW Orchestrator & Prescriptions"
Cohesion: 0.25
Nodes (8): src/engine/suggest.ts, src/engine/workout-builder.ts, src/engine/workout-selector.ts, src/web/prescriptions.ts, tests/engine/suggest.test.ts, tests/engine/workout-builder.test.ts, tests/engine/workout-selector.test.ts, tests/web/prescriptions.test.ts

### Community 19 - "Vigil DB & Scorer Tests"
Cohesion: 0.29
Nodes (8): src/db.ts, src/engine/vigil/baseline.ts, src/engine/vigil/index.ts, src/engine/vigil/scorer.ts, tests/engine/vigil/baseline.test.ts, tests/engine/vigil/db.test.ts, tests/engine/vigil/integration.test.ts, tests/engine/vigil/scorer.test.ts

### Community 20 - "Workout Send Targets (Intervals + Stryd)"
Cohesion: 0.29
Nodes (7): src/web/intervals-format.ts, intervals.icu workout builder syntax, src/web/send.ts, src/web/send-stryd.ts, Stryd PowerCenter API reference, src/web/stryd-format.ts, tests/api/auth.test.ts

### Community 21 - "OAuth Security Primitives"
Cohesion: 0.33
Nodes (6): createOAuthHandler, PKCE S256 (sha256Base64Url), Rate limit + lockout buckets, ALLOWED_REDIRECT_URIS, signToken / verifyToken (HMAC-SHA256), validateBearer (MCP)

### Community 22 - "Stryd FIT Enrichment Pipeline"
Cohesion: 0.33
Nodes (6): src/engine/vigil/fit-parser.ts, src/stryd/client.ts, src/stryd/enricher.ts, tests/engine/vigil/fit-parser.test.ts, tests/stryd/client.test.ts, tests/stryd/enricher.test.ts

### Community 23 - "Workout Format Outputs"
Cohesion: 0.5
Nodes (4): src/web/form-format.ts, src/web/intervals-format.ts, tests/web/form-format.test.ts, tests/web/intervals-format.test.ts

### Community 24 - "Cache Helpers"
Cohesion: 0.67
Nodes (3): cacheGet function, cacheInvalidate function, cacheSet function

### Community 25 - "Stryd External API"
Cohesion: 1.0
Nodes (2): Stryd PowerCenter external API, StrydClient class

### Community 26 - "Staleness Detection"
Cohesion: 1.0
Nodes (2): src/engine/staleness.ts, tests/engine/staleness.test.ts

### Community 27 - "Terrain Selection"
Cohesion: 1.0
Nodes (2): src/engine/terrain-selector.ts, tests/engine/terrain-selector.test.ts

### Community 28 - "Render Layer"
Cohesion: 1.0
Nodes (2): src/web/render.ts, tests/web/vigil-render.test.ts

### Community 29 - "Vigil Metrics"
Cohesion: 1.0
Nodes (2): src/engine/vigil/metrics.ts, tests/engine/vigil/metrics.test.ts

### Community 30 - "Intervals Client"
Cohesion: 1.0
Nodes (2): src/intervals.ts, tests/intervals.test.ts

### Community 31 - "Deity Invocations"
Cohesion: 1.0
Nodes (2): src/web/invocations.ts, tests/web/invocations.test.ts

### Community 32 - "Send to Intervals"
Cohesion: 1.0
Nodes (2): src/web/send.ts, tests/web/send.test.ts

### Community 35 - "ApiKey Interface"
Cohesion: 1.0
Nodes (1): ApiKey interface

### Community 36 - "Intervals Probe"
Cohesion: 1.0
Nodes (1): probeIntervals

### Community 37 - "Stryd Probe"
Cohesion: 1.0
Nodes (1): probeStryd

### Community 38 - "Enrichment Tracking"
Cohesion: 1.0
Nodes (1): isAlreadyEnriched/recordEnrichment

### Community 39 - "Terrain Selector File"
Cohesion: 1.0
Nodes (1): engine/terrain-selector.ts

### Community 40 - "Engine Type Defs"
Cohesion: 1.0
Nodes (1): engine/types.ts

### Community 41 - "WorkoutCategory Type"
Cohesion: 1.0
Nodes (1): WorkoutCategory type

### Community 42 - "Vigil Backfill File"
Cohesion: 1.0
Nodes (1): engine/vigil/backfill.ts

### Community 43 - "Vigil Baseline File"
Cohesion: 1.0
Nodes (1): engine/vigil/baseline.ts

### Community 44 - "Vigil Fit-Parser File"
Cohesion: 1.0
Nodes (1): engine/vigil/fit-parser.ts

### Community 45 - "Vigil Index File"
Cohesion: 1.0
Nodes (1): engine/vigil/index.ts

### Community 46 - "Vigil Scorer File"
Cohesion: 1.0
Nodes (1): engine/vigil/scorer.ts

### Community 47 - "Vigil Types File"
Cohesion: 1.0
Nodes (1): engine/vigil/types.ts

### Community 48 - "Workout Builder File"
Cohesion: 1.0
Nodes (1): engine/workout-builder.ts

### Community 49 - "Workout Selector File"
Cohesion: 1.0
Nodes (1): engine/workout-selector.ts

### Community 51 - "Stryd Client File"
Cohesion: 1.0
Nodes (1): stryd/client.ts

### Community 53 - "Stryd Enricher File"
Cohesion: 1.0
Nodes (1): stryd/enricher.ts

### Community 54 - "Activities Tool"
Cohesion: 1.0
Nodes (1): tools/activities.ts

### Community 55 - "Athlete Tool"
Cohesion: 1.0
Nodes (1): tools/athlete.ts

### Community 56 - "Compliance Tool"
Cohesion: 1.0
Nodes (1): tools/compliance.ts

### Community 57 - "Events Tool"
Cohesion: 1.0
Nodes (1): tools/events.ts

### Community 58 - "Suggest Tool"
Cohesion: 1.0
Nodes (1): tools/suggest.ts

### Community 59 - "Wellness Tool"
Cohesion: 1.0
Nodes (1): tools/wellness.ts

### Community 61 - "Form-Format File"
Cohesion: 1.0
Nodes (1): web/form-format.ts

### Community 62 - "Invocations File"
Cohesion: 1.0
Nodes (1): src/web/invocations.ts

### Community 63 - "Prescriptions File"
Cohesion: 1.0
Nodes (1): src/web/prescriptions.ts

### Community 64 - "Routes File"
Cohesion: 1.0
Nodes (1): src/web/routes.ts

### Community 65 - "Auth Test File"
Cohesion: 1.0
Nodes (1): tests/auth.test.ts

### Community 66 - "Power-Source Test File"
Cohesion: 1.0
Nodes (1): tests/engine/power-source.test.ts

### Community 67 - "Readiness Test File"
Cohesion: 1.0
Nodes (1): tests/engine/readiness.test.ts

### Community 68 - "Sport-Selector Test File"
Cohesion: 1.0
Nodes (1): tests/engine/sport-selector.test.ts

## Ambiguous Edges - Review These
- `src/web/intervals-format.ts` → `tests/api/auth.test.ts`  [AMBIGUOUS]
  tests/api/auth.test.ts · relation: semantically_similar_to
- `sendToIntervals` → `tests/api/payload.test.ts`  [AMBIGUOUS]
  tests/api/payload.test.ts · relation: semantically_similar_to

## Knowledge Gaps
- **148 isolated node(s):** `Build the SAST methodology prompt, incorporating project-specific context.`, `Collect all scannable source files.`, `Get list of files changed since baseline tag.`, `Build source code text and compute content hash.`, `Build the content to cache: security docs + full source code.` (+143 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Stryd PowerCenter Client`** (11 nodes): `StrydClient`, `.authHeaders()`, `.constructor()`, `.createWorkout()`, `.deleteCalendarEntry()`, `.downloadFit()`, `.getLatestCriticalPower()`, `.isAuthenticated()`, `.listActivities()`, `.login()`, `.scheduleWorkout()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Stryd External API`** (2 nodes): `Stryd PowerCenter external API`, `StrydClient class`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Staleness Detection`** (2 nodes): `src/engine/staleness.ts`, `tests/engine/staleness.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Terrain Selection`** (2 nodes): `src/engine/terrain-selector.ts`, `tests/engine/terrain-selector.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Render Layer`** (2 nodes): `src/web/render.ts`, `tests/web/vigil-render.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Vigil Metrics`** (2 nodes): `src/engine/vigil/metrics.ts`, `tests/engine/vigil/metrics.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Intervals Client`** (2 nodes): `src/intervals.ts`, `tests/intervals.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Deity Invocations`** (2 nodes): `src/web/invocations.ts`, `tests/web/invocations.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Send to Intervals`** (2 nodes): `src/web/send.ts`, `tests/web/send.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `ApiKey Interface`** (1 nodes): `ApiKey interface`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Intervals Probe`** (1 nodes): `probeIntervals`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Stryd Probe`** (1 nodes): `probeStryd`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Enrichment Tracking`** (1 nodes): `isAlreadyEnriched/recordEnrichment`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Terrain Selector File`** (1 nodes): `engine/terrain-selector.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Engine Type Defs`** (1 nodes): `engine/types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `WorkoutCategory Type`** (1 nodes): `WorkoutCategory type`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Vigil Backfill File`** (1 nodes): `engine/vigil/backfill.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Vigil Baseline File`** (1 nodes): `engine/vigil/baseline.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Vigil Fit-Parser File`** (1 nodes): `engine/vigil/fit-parser.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Vigil Index File`** (1 nodes): `engine/vigil/index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Vigil Scorer File`** (1 nodes): `engine/vigil/scorer.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Vigil Types File`** (1 nodes): `engine/vigil/types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Workout Builder File`** (1 nodes): `engine/workout-builder.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Workout Selector File`** (1 nodes): `engine/workout-selector.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Stryd Client File`** (1 nodes): `stryd/client.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Stryd Enricher File`** (1 nodes): `stryd/enricher.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Activities Tool`** (1 nodes): `tools/activities.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Athlete Tool`** (1 nodes): `tools/athlete.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Compliance Tool`** (1 nodes): `tools/compliance.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Events Tool`** (1 nodes): `tools/events.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Suggest Tool`** (1 nodes): `tools/suggest.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Wellness Tool`** (1 nodes): `tools/wellness.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Form-Format File`** (1 nodes): `web/form-format.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Invocations File`** (1 nodes): `src/web/invocations.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Prescriptions File`** (1 nodes): `src/web/prescriptions.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Routes File`** (1 nodes): `src/web/routes.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Auth Test File`** (1 nodes): `tests/auth.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Power-Source Test File`** (1 nodes): `tests/engine/power-source.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Readiness Test File`** (1 nodes): `tests/engine/readiness.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Sport-Selector Test File`** (1 nodes): `tests/engine/sport-selector.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `src/web/intervals-format.ts` and `tests/api/auth.test.ts`?**
  _Edge tagged AMBIGUOUS (relation: semantically_similar_to) - confidence is low._
- **What is the exact relationship between `sendToIntervals` and `tests/api/payload.test.ts`?**
  _Edge tagged AMBIGUOUS (relation: semantically_similar_to) - confidence is low._
- **Why does `StrydClient` connect `Stryd PowerCenter Client` to `Compliance Aggregation Pipeline`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `Vigil biomechanical injury warning pipeline` connect `Docs Hub & Research Citations` to `MCP Entry & External API Clients`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Are the 13 inferred relationships involving `getDb()` (e.g. with `persistPrescription()` and `getPrescription()`) actually correct?**
  _`getDb()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **Are the 16 inferred relationships involving `handleDashboard()` (e.g. with `handleApiRequest()` and `localDateStr()`) actually correct?**
  _`handleDashboard()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **Are the 17 inferred relationships involving `localDateStr()` (e.g. with `runComplianceBackfill()` and `handleMainPage()`) actually correct?**
  _`localDateStr()` has 17 INFERRED edges - model-reasoned connections that need verification._