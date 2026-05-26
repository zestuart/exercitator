/**
 * FORM-DSW replay scaffold (Phase 7 determinism verification).
 *
 * Reconstructs the FORM-text + intervals.icu description bytes from a
 * saved WorkoutSuggestion (or a live regeneration) and hashes them, so
 * we can prove that a workout stored at time T produces the same byte
 * output when replayed at time T+N as long as the inputs are stable.
 *
 * USAGE
 *
 *   # single-input mode: print FORM-text + intervals-description + hashes
 *   tsx scripts/replay-form-dsw.ts <suggestion.json>
 *
 *   # diff mode: compare two saved suggestions, fail if they hash differently
 *   tsx scripts/replay-form-dsw.ts <a.json> <b.json>
 *
 * INPUT SHAPE
 *
 *   <suggestion.json> is a WorkoutSuggestion (the shape exposed by
 *   /api/users/:userId/workouts/suggested -> body.suggestion before
 *   suggestionToApi munges field names, OR the engine output captured
 *   directly). The script extracts:
 *
 *     - sport, category, title
 *     - segments[] (already swapped or engine output)
 *     - formWorkoutId, formWorkoutTitle (provenance)
 *     - power_context (intervals description embeds power band)
 *
 *   To capture a fresh one:
 *
 *     curl -s -H "Authorization: Bearer <key>" \
 *       'https://exercitator.tail7ab379.ts.net/api/users/ze/workouts/suggested?sport=Swim&fresh=1' \
 *       | jq '.suggestion' > /tmp/swim-replay-a.json
 *
 *   The HTTP API exposes a snake_case payload; we lowercase-converted
 *   field names here are tolerant of both shapes (the script accepts
 *   either form_workout_id or formWorkoutId, etc.).
 *
 * FUTURE — Promus #167 wiring
 *
 *   Once Promus's DSW read endpoint lands, add a third mode:
 *
 *     tsx scripts/replay-form-dsw.ts --user ze --date 2026-05-26 --sport Swim
 *
 *   that GETs the DSW row, extracts the vendor_recommendation_set +
 *   picked_workout_id, re-fetches the FORM body via the live
 *   FormClient (workout IDs are stable per Phase 0 verification),
 *   runs the full swap, and diffs against the locally stored
 *   exercitator_context. Divergence = a stale-CSS / float-vs-int /
 *   renamed-helper drift bug to investigate.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WorkoutSegment, WorkoutSuggestion } from "../src/engine/types.js";
import { buildFormDescription } from "../src/web/form-format.js";
import { buildIntervalsDescription } from "../src/web/intervals-format.js";

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

	// If the file is the full /workouts/suggested envelope, unwrap.
	const body = (raw.suggestion ?? raw) as Record<string, unknown>;

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
			? {
					formWorkoutId: String(body.formWorkoutId ?? body.form_workout_id),
				}
			: {}),
		...(body.formWorkoutTitle || body.form_workout_title
			? {
					formWorkoutTitle: String(body.formWorkoutTitle ?? body.form_workout_title),
				}
			: {}),
		...(body.formPickRationale || body.form_pick_rationale
			? {
					formPickRationale: String(body.formPickRationale ?? body.form_pick_rationale),
				}
			: {}),
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

function main(): void {
	const args = process.argv.slice(2);
	if (args.length < 1 || args.length > 2 || args.includes("--help") || args.includes("-h")) {
		console.error("usage: tsx scripts/replay-form-dsw.ts <suggestion.json> [<other.json>]");
		console.error("       see scripts/replay-form-dsw.ts header for capture recipes.");
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
	console.log(`form_text:            ${formEq ? "MATCH" : "DIVERGE"}`);
	console.log(`intervals_description:${intervalsEq ? " MATCH" : " DIVERGE"}`);

	if (!formEq || !intervalsEq) {
		console.error("");
		console.error("Replay diverged. Inspect inputs for: stale CSS / power_context drift");
		console.error("/ renamed mapper helpers / segment-shape mismatch.");
		process.exit(1);
	}
}

main();
