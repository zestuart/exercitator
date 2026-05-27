/**
 * FORM-DSW replay scaffold (Phase 7 determinism verification).
 *
 * Reconstructs the FORM-text + intervals.icu description bytes from a
 * saved WorkoutSuggestion or a Promus DSW row and hashes them, so we
 * can prove that a workout stored at time T produces the same byte
 * output when replayed at time T+N as long as the inputs are stable.
 *
 * USAGE
 *
 *   # 1. File mode — print FORM-text + intervals + hashes
 *   tsx scripts/replay-form-dsw.ts <suggestion.json>
 *
 *   # 2. File-diff mode — compare two saved suggestions, fail if hashes differ
 *   tsx scripts/replay-form-dsw.ts <a.json> <b.json>
 *
 *   # 3. Promus mode — GET the DSW row via Promus #167, reconstruct, render
 *   tsx scripts/replay-form-dsw.ts --user ze --date 2026-05-26 \
 *     --sport Swim --source form
 *
 *   # 4. Promus-vs-live diff — compare stored emission against a fresh render
 *   tsx scripts/replay-form-dsw.ts --user ze --date 2026-05-26 \
 *     --sport Swim --source form --vs-live <fresh.json>
 *
 * INPUT SHAPE (file mode)
 *
 *   <suggestion.json> is a WorkoutSuggestion (camelCase) OR a
 *   suggestionToApi snake_case body. Tolerant loader accepts both.
 *
 *   Capture a fresh one:
 *     curl -s -H "Authorization: Bearer <key>" \
 *       'https://exercitator.tail7ab379.ts.net/api/users/ze/workouts/suggested?sport=Swim&fresh=1' \
 *       | jq '.suggestion' > /tmp/swim-replay-a.json
 *
 * PROMUS MODE
 *
 *   Reads `PROMUS_API` + `PROMUS_URL` from environment. The DSW
 *   record's `exercitator_context.picked_workout_body` carries the
 *   full FORM setGroups[]; `exercitator_context.swim_css_m_per_s`
 *   carries the CSS that was active at decision time. Both are
 *   required for byte-equal replay; missing CSS falls back to the
 *   workout's `intensityLevel` heuristic (warns).
 *
 *   For FORM/Swim rows: reconstructed via `formWorkoutToSegments`.
 *   Stryd/Run rows are out of scope for this scaffold today —
 *   `picked_workout_body` is not persisted into `exercitator_context`
 *   on the Stryd path because the body is already inside
 *   `vendor_recommendation_set.workouts[i].estimated_workout.workout`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { formWorkoutToSegments } from "../src/engine/form-mapper.js";
import type { SportSettings, WorkoutSegment, WorkoutSuggestion } from "../src/engine/types.js";
import type { FormWorkoutBody } from "../src/form/client.js";
import { buildFormDescription } from "../src/web/form-format.js";
import { validateFormWorkoutBody } from "../src/web/form-swap.js";
import { buildIntervalsDescription } from "../src/web/intervals-format.js";
import { fetchDswRecord } from "../src/web/promus-dsw.js";

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/**
 * Tolerant loader — accepts either the WorkoutSuggestion shape (camelCase
 * fields) or the ApiSegment-style snake_case shape that /workouts/suggested
 * emits, and produces a canonical WorkoutSuggestion for the converters.
 */
function loadSuggestion(path: string): WorkoutSuggestion {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	const body = (raw.suggestion ?? raw) as Record<string, unknown>;
	return canonicalSuggestion(body);
}

function canonicalSuggestion(body: Record<string, unknown>): WorkoutSuggestion {
	const segments = (body.segments as unknown[]).map((segRaw): WorkoutSegment => {
		const s = segRaw as Record<string, unknown>;
		return {
			name: String(s.name ?? ""),
			duration_secs: Number(s.duration_secs ?? s.duration_s ?? 0),
			target_description: String(s.target_description ?? ""),
			...(s.target_hr_zone != null && { target_hr_zone: Number(s.target_hr_zone) }),
			...(s.target_power_low != null && { target_power_low: Number(s.target_power_low) }),
			...(s.target_power_high != null && { target_power_high: Number(s.target_power_high) }),
			...(s.target_pace_secs_low != null && {
				target_pace_secs_low: Number(s.target_pace_secs_low),
			}),
			...(s.target_pace_secs_high != null && {
				target_pace_secs_high: Number(s.target_pace_secs_high),
			}),
			...(s.repeats != null && { repeats: Number(s.repeats) }),
			...(s.work_duration_secs != null && { work_duration_secs: Number(s.work_duration_secs) }),
			...((s.rest_duration_secs ?? s.rest_duration_s) != null && {
				rest_duration_secs: Number(s.rest_duration_secs ?? s.rest_duration_s),
			}),
			...(s.stryd_zone != null && { stryd_zone: Number(s.stryd_zone) }),
		};
	});

	return {
		sport: (body.sport as WorkoutSuggestion["sport"]) ?? "Swim",
		category: (body.category as WorkoutSuggestion["category"]) ?? "base",
		title: String(body.title ?? ""),
		rationale: String(body.rationale ?? ""),
		total_duration_secs: Number(body.total_duration_secs ?? 0),
		estimated_load: Number(body.estimated_load ?? 0),
		segments,
		readiness_score: Number(body.readiness_score ?? 0),
		sport_selection_reason: String(body.sport_selection_reason ?? ""),
		terrain: (body.terrain as WorkoutSuggestion["terrain"]) ?? "any",
		terrain_rationale: String(body.terrain_rationale ?? ""),
		power_context: (body.power_context as WorkoutSuggestion["power_context"]) ?? {
			source: "none",
			ftp: 0,
			rolling_ftp: null,
			correction_factor: 1,
			confidence: "low",
			warnings: [],
		},
		warnings: (body.warnings as string[]) ?? [],
		...(body.vigil ? { vigil: body.vigil as WorkoutSuggestion["vigil"] } : {}),
		...(body.status ? { status: body.status as WorkoutSuggestion["status"] } : {}),
		...(body.prescriptionSource || body.prescription_source
			? {
					prescriptionSource: (body.prescriptionSource ??
						body.prescription_source) as WorkoutSuggestion["prescriptionSource"],
				}
			: {}),
		...(body.formWorkoutId || body.form_workout_id
			? { formWorkoutId: String(body.formWorkoutId ?? body.form_workout_id) }
			: {}),
		...(body.formWorkoutTitle || body.form_workout_title
			? { formWorkoutTitle: String(body.formWorkoutTitle ?? body.form_workout_title) }
			: {}),
		...(body.formPickRationale || body.form_pick_rationale
			? { formPickRationale: String(body.formPickRationale ?? body.form_pick_rationale) }
			: {}),
	};
}

/**
 * Reconstruct a WorkoutSuggestion from a Promus DSW row. FORM/Swim
 * rows only — see header.
 *
 * Inputs come from the row:
 *  - `category` → suggestion.category
 *  - `picked_workout_title` / `_id` / `picked_strategy_rationale` → provenance
 *  - `exercitator_context.picked_workout_body` → run through
 *    `formWorkoutToSegments` with the persisted CSS to recompute pace
 *    bands. This is the byte-equal-determinism path.
 *  - `exercitator_context.swim_css_m_per_s` → SportSettings.threshold_pace
 *
 * If CSS or picked_workout_body is missing (older rows), the script
 * warns and uses heuristic defaults — replay will then NOT be byte-equal,
 * but the output is still informative for spot-checking.
 */
async function loadSuggestionFromPromus(
	userId: string,
	date: string,
	sport: string,
	source: string,
): Promise<WorkoutSuggestion> {
	const record = await fetchDswRecord(userId, date, sport, source);
	if (!record) {
		throw new Error(`No DSW row for ${userId}/${date}/${sport}/${source}`);
	}

	if (record.source !== "form" || record.sport !== "Swim") {
		throw new Error(
			`Promus mode supports FORM/Swim only; got source=${record.source} sport=${record.sport}`,
		);
	}

	const ctx = (record.exercitator_context ?? {}) as Record<string, unknown>;
	const pickedBody = ctx.picked_workout_body as FormWorkoutBody | undefined;
	const cssMps = typeof ctx.swim_css_m_per_s === "number" ? ctx.swim_css_m_per_s : null;

	if (!pickedBody) {
		throw new Error(
			"DSW row missing exercitator_context.picked_workout_body — cannot reconstruct segments.",
		);
	}
	// Same defensive caps as production form-swap.ts — defends against
	// poisoned DSW rows exhausting memory at replay time (SAST finding
	// 2026-05-27).
	const violation = validateFormWorkoutBody(pickedBody);
	if (violation) {
		throw new Error(
			`DSW row picked_workout_body failed validation: ${violation}. Refusing to flatten; row is poisoned or malformed.`,
		);
	}
	if (cssMps === null) {
		console.warn(
			"WARN: DSW row missing exercitator_context.swim_css_m_per_s — replay will not be byte-equal across CSS recalibration. Falling back to 0.94 m/s (ze's calibrated CSS).",
		);
	}

	const settings: SportSettings = {
		sport: "Swim",
		threshold_pace: cssMps ?? 0.94,
		hr_zones: null,
	} as unknown as SportSettings;

	const segments = formWorkoutToSegments(pickedBody, settings);
	const totalSecs = segments.reduce((s, seg) => s + seg.duration_secs, 0);

	return {
		sport: "Swim",
		category: record.category as WorkoutSuggestion["category"],
		title: record.picked_workout_title ?? pickedBody.name,
		rationale: pickedBody.description,
		total_duration_secs: totalSecs,
		estimated_load: 0,
		segments,
		readiness_score: typeof ctx.readiness_score === "number" ? ctx.readiness_score : 0,
		sport_selection_reason: "promus-replay",
		terrain: "pool",
		terrain_rationale: "",
		power_context: {
			source: "none",
			ftp: 0,
			rolling_ftp: null,
			correction_factor: 1,
			confidence: "low",
			warnings: [],
		} as unknown as WorkoutSuggestion["power_context"],
		warnings: [],
		prescriptionSource: "form",
		formWorkoutId: record.picked_workout_id ?? pickedBody.id,
		formWorkoutTitle: record.picked_workout_title ?? pickedBody.name,
		...(record.picked_strategy_rationale && {
			formPickRationale: record.picked_strategy_rationale,
		}),
		formOriginalWorkout: pickedBody,
	};
}

function renderBoth(suggestion: WorkoutSuggestion): { formText: string; intervals: string } {
	return {
		formText: buildFormDescription(suggestion),
		intervals: buildIntervalsDescription(suggestion),
	};
}

function summary(label: string, suggestion: WorkoutSuggestion): void {
	const { formText, intervals } = renderBoth(suggestion);
	const formHash = sha256(formText);
	const intervalsHash = sha256(intervals);

	console.log(`=== ${label} ===`);
	console.log(`title:                ${suggestion.title}`);
	console.log(`sport / category:     ${suggestion.sport} / ${suggestion.category}`);
	console.log(`prescriptionSource:   ${suggestion.prescriptionSource ?? "(unset)"}`);
	console.log(`formWorkoutId:        ${suggestion.formWorkoutId ?? "(unset)"}`);
	console.log(`segments:             ${suggestion.segments.length}`);
	console.log(`total_duration_secs:  ${suggestion.total_duration_secs}`);
	console.log("");
	console.log("--- FORM-text ---");
	console.log(formText);
	console.log("");
	console.log("--- intervals.icu description ---");
	console.log(intervals);
	console.log("");
	console.log(`form_text_sha256:     ${formHash}`);
	console.log(`intervals_sha256:     ${intervalsHash}`);
	console.log("");
}

interface PromusArgs {
	user: string;
	date: string;
	sport: string;
	source: string;
	vsLive?: string;
}

function parsePromusArgs(args: string[]): PromusArgs | null {
	if (!args.includes("--user")) return null;
	const result: Partial<PromusArgs> = {};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		const value = args[i + 1];
		if (flag === "--user") result.user = value;
		else if (flag === "--date") result.date = value;
		else if (flag === "--sport") result.sport = value;
		else if (flag === "--source") result.source = value;
		else if (flag === "--vs-live") result.vsLive = value;
	}
	if (!result.user || !result.date || !result.sport || !result.source) {
		console.error("--user, --date, --sport, --source are all required in Promus mode");
		process.exit(2);
	}
	return result as PromusArgs;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length < 1 || args.includes("--help") || args.includes("-h")) {
		console.error("usage:");
		console.error("  tsx scripts/replay-form-dsw.ts <suggestion.json>");
		console.error("  tsx scripts/replay-form-dsw.ts <a.json> <b.json>");
		console.error(
			"  tsx scripts/replay-form-dsw.ts --user ze --date YYYY-MM-DD --sport Swim --source form [--vs-live <fresh.json>]",
		);
		process.exit(2);
	}

	// Promus mode
	const promus = parsePromusArgs(args);
	if (promus) {
		const stored = await loadSuggestionFromPromus(
			promus.user,
			promus.date,
			promus.sport,
			promus.source,
		);
		const label = `promus:${promus.user}/${promus.date}/${promus.sport}/${promus.source}`;
		summary(label, stored);

		if (!promus.vsLive) return;

		const fresh = loadSuggestion(promus.vsLive);
		summary(`live:${promus.vsLive}`, fresh);

		const storedRendered = renderBoth(stored);
		const freshRendered = renderBoth(fresh);
		const formEq = storedRendered.formText === freshRendered.formText;
		const intervalsEq = storedRendered.intervals === freshRendered.intervals;
		console.log("=== diff (Promus vs live) ===");
		console.log(`form_text:             ${formEq ? "MATCH" : "DIVERGE"}`);
		console.log(`intervals_description: ${intervalsEq ? "MATCH" : "DIVERGE"}`);
		if (!formEq || !intervalsEq) process.exit(1);
		return;
	}

	// File / file-diff mode
	if (args.length > 2) {
		console.error("file mode takes 1 or 2 paths");
		process.exit(2);
	}
	const [pathA, pathB] = args;
	const a = loadSuggestion(pathA);
	summary(pathA, a);

	if (!pathB) return;

	const b = loadSuggestion(pathB);
	summary(pathB, b);

	const renderedA = renderBoth(a);
	const renderedB = renderBoth(b);
	const formEq = renderedA.formText === renderedB.formText;
	const intervalsEq = renderedA.intervals === renderedB.intervals;

	console.log("=== diff ===");
	console.log(`form_text:             ${formEq ? "MATCH" : "DIVERGE"}`);
	console.log(`intervals_description: ${intervalsEq ? "MATCH" : "DIVERGE"}`);

	if (!formEq || !intervalsEq) {
		console.error("");
		console.error("Replay diverged. Inspect inputs for: stale CSS / power_context drift");
		console.error("/ renamed mapper helpers / segment-shape mismatch.");
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
