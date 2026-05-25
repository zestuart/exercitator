/**
 * Stryd workout-recommendation mapper.
 *
 * Pure bridge between Exercitator's `WorkoutCategory` ladder and Stryd's
 * `/workouts/recommendations` API. Three responsibilities:
 *
 *   1. `mapCategoryToStrydType` — pick the Stryd type bucket for a category
 *      (the query-parameter discriminator: `easy` | `long` | `workout`, or
 *      `null` when Stryd should be skipped entirely).
 *   2. `pickStrydWorkout`       — pick one candidate from a server response by
 *      `intensity_zones` profile match (NOT by `labels[0] === "Best match"`,
 *      which rotates day-to-day per phase0-verification-2026-05-25.md).
 *   3. `strydWorkoutToSegments` — flatten Stryd blocks/segments into the
 *      Exercitator `WorkoutSegment[]` shape used everywhere else.
 *
 * No I/O. No async. No `Date.now()`. The HTTP client (Phase 1) lives in
 * `src/stryd/client.ts`; logging (Phase 4) and Praescriptor integration
 * (Phase 3) are out of scope.
 */

import type {
	StrydRecommendationSet,
	StrydRecommendedWorkout,
	StrydWorkout,
} from "../stryd/client.js";
import type { WorkoutCategory, WorkoutSegment } from "./types.js";

// ---------------------------------------------------------------------------
// (1) Category → Stryd type bucket
// ---------------------------------------------------------------------------

/**
 * Map an Exercitator `WorkoutCategory` to the Stryd `type` query parameter.
 * `null` means Exercitator should not call Stryd for this category at all.
 */
export function mapCategoryToStrydType(
	category: WorkoutCategory,
): "easy" | "long" | "workout" | null {
	switch (category) {
		case "rest":
			return null;
		case "recovery":
		case "base":
		case "progression":
			return "easy";
		case "tempo":
		case "threshold":
		case "intervals":
			return "workout";
		case "long":
			return "long";
	}
}

// ---------------------------------------------------------------------------
// (2) pickStrydWorkout
// ---------------------------------------------------------------------------

/**
 * Expected `estimated_workout.average.intensity` (= average power / CP) per
 * category. Used as a tiebreak when two candidates have identical
 * primary-zone scores. Values are calibrated against the Stryd zone targets
 * encoded in `architecture.md` line 90:
 *   recovery     Stryd Z1 Easy 65–75% CP   → midpoint ~0.70 (rounded to 0.72 for the
 *                                              easier-end-of-Z1 sweet spot)
 *   base         Stryd Z1 Easy 65–80%      → midpoint ~0.73 (use 0.75)
 *   progression  Stryd Z1→Z2 thirds        → time-weighted ~0.78
 *   tempo        Stryd Z2 Moderate 80–90%  → midpoint 0.85
 *   threshold    Stryd Z3 Threshold 90–100% → midpoint 0.95
 *   intervals    Stryd Z4 Interval 100–115% → midpoint ~1.07 (use 1.05 — repeats
 *                                              are short, work-rest dilutes average)
 *   long         Stryd Z1 Easy with optional Z2 pickup → ~0.75
 */
const EXPECTED_INTENSITY: Record<WorkoutCategory, number> = {
	rest: 0,
	recovery: 0.72,
	base: 0.75,
	progression: 0.78,
	tempo: 0.85,
	threshold: 0.95,
	intervals: 1.05,
	long: 0.75,
};

/** Score function: bigger is better. Per-category zone-target encoding. */
function categoryScore(
	category: WorkoutCategory,
	zones: readonly [number, number, number, number, number],
): number {
	switch (category) {
		case "recovery":
		case "base":
		case "progression":
		case "long":
			// Easy/long bucket — usually trivial because the easy/long buckets
			// return a single workout, but we still score by Z1 seconds.
			return zones[0];
		case "tempo":
			return zones[1]; // Z2 (Stryd Moderate)
		case "threshold":
			return zones[2]; // Z3 (Stryd Threshold)
		case "intervals":
			return zones[3] + zones[4]; // Z4 + Z5 (Interval + Repetition)
		case "rest":
			return 0;
	}
}

/** Short human-readable score label for the rationale string. */
function scoreLabel(category: WorkoutCategory): string {
	switch (category) {
		case "tempo":
			return "Z2";
		case "threshold":
			return "Z3";
		case "intervals":
			return "Z4+Z5";
		default:
			return "Z1";
	}
}

/**
 * Pick the best-matching Stryd recommendation for the given category.
 *
 * Returns `null` when:
 *   - the recommendation set is empty
 *   - `category === "recovery"` AND the only candidate is `workout.type === "stride"`
 *     (strides are fine on base/progression but inappropriate on a true recovery day)
 *
 * Scoring:
 *   1. Per-category zone-seconds — bigger primary-zone count wins.
 *   2. Tiebreak: candidate whose `average.intensity` is closest to the
 *      category's expected value (see EXPECTED_INTENSITY).
 *   3. Final tiebreak: server order (lower index wins).
 *
 * The rationale string names the chosen workout, its score, and (when present)
 * the runner-up — so a log line is enough to audit the choice without dumping
 * the full payload.
 */
export function pickStrydWorkout(
	category: WorkoutCategory,
	recommendationSet: StrydRecommendationSet,
): { picked: StrydRecommendedWorkout; rationale: string } | null {
	const candidates = recommendationSet.workouts;
	if (!candidates || candidates.length === 0) return null;

	// Recovery-day stride rejection: only if the SOLE candidate is a stride
	// workout. (Strides are fine on base/progression — only block them when
	// recovery was explicitly prescribed.)
	if (category === "recovery") {
		const allStrides = candidates.every((c) => c.estimated_workout.workout.type === "stride");
		if (allStrides) {
			return null;
		}
	}

	const expectedIntensity = EXPECTED_INTENSITY[category];

	// Score each candidate; keep original server index for the final tiebreak.
	const scored = candidates.map((c, index) => ({
		candidate: c,
		index,
		zoneScore: categoryScore(category, c.estimated_workout.intensity_zones),
		intensityDelta: Math.abs(c.estimated_workout.average.intensity - expectedIntensity),
	}));

	// Primary sort: zone score descending; tiebreak: intensity delta ascending;
	// final tiebreak: server order ascending.
	scored.sort((a, b) => {
		if (a.zoneScore !== b.zoneScore) return b.zoneScore - a.zoneScore;
		if (a.intensityDelta !== b.intensityDelta) return a.intensityDelta - b.intensityDelta;
		return a.index - b.index;
	});

	const winner = scored[0];
	const runnerUp = scored.length > 1 ? scored[1] : null;
	const label = scoreLabel(category);
	const winnerTitle = winner.candidate.estimated_workout.workout.title;

	let rationale: string;
	if (runnerUp) {
		const runnerUpTitle = runnerUp.candidate.estimated_workout.workout.title;
		rationale =
			`${category}: picked '${winnerTitle}' (${winner.zoneScore} s ${label}) ` +
			`over '${runnerUpTitle}' (${runnerUp.zoneScore} s ${label})`;
	} else {
		rationale = `${category}: picked '${winnerTitle}' (${winner.zoneScore} s ${label})`;
	}

	return { picked: winner.candidate, rationale };
}

// ---------------------------------------------------------------------------
// (3) strydWorkoutToSegments
// ---------------------------------------------------------------------------

/**
 * Map a Stryd `intensity_class` to an Exercitator segment name.
 *
 * `workout-builder.ts` uses "Warm-up", "Main set", "Cool-down" as segment
 * names. Stryd has a per-segment `intensity_class` of `warmup | work | rest |
 * cooldown` — we keep the closest equivalent so downstream rendering /
 * compliance code can recognise the role.
 */
function classToSegmentName(cls: "warmup" | "work" | "rest" | "cooldown"): string {
	switch (cls) {
		case "warmup":
			return "Warm-up";
		case "cooldown":
			return "Cool-down";
		case "work":
			return "Work";
		case "rest":
			return "Recovery";
	}
}

/**
 * Convert a Stryd workout into Exercitator's `WorkoutSegment[]` shape.
 *
 * Repeat strategy: **flatten**. `WorkoutSegment` does not model a structural
 * "repeat a list of segments N times" loop — its `repeats` / `work_duration_secs`
 * / `rest_duration_secs` fields describe a single (work,rest) pair, not an
 * arbitrary segment list. Flattening preserves fidelity for Stryd's
 * multi-segment blocks (e.g. Hill Hustle's work + rest + sprint triple) and
 * keeps each segment's own power band, name, and `intensity_class`-derived
 * role intact. Block[2] of *Easy + Strides* (`repeat=3`, segments = work@105%
 * 20 s + rest@75% 60 s) produces 6 emitted segments here.
 *
 * Distance-based segments (`duration_type === "distance"`) are not observed
 * in any captured payload; we set `duration_secs = 0` and emit a TODO
 * comment in the source — the field is plumbed but not yet exercised.
 *
 * `target_hr_zone` is intentionally unset. Stryd recommendations are
 * power-prescribed; HR is not in the response. Layering an HR cap belongs
 * upstream of this module.
 */
/**
 * Defensive cap on `block.repeat` from the Stryd API. Real workouts top out
 * around 12 reps; this caps at 100 to defend against a compromised or
 * malformed upstream response that could otherwise exhaust memory by
 * flattening a billion-rep block. Inputs above the cap are rejected with
 * a console warning so an audit trail exists.
 */
const MAX_BLOCK_REPEAT = 100;

export function strydWorkoutToSegments(workout: StrydWorkout, ftp: number): WorkoutSegment[] {
	const segments: WorkoutSegment[] = [];

	for (const block of workout.blocks) {
		const rawRepeat = Math.max(1, block.repeat);
		if (rawRepeat > MAX_BLOCK_REPEAT) {
			console.warn(
				`strydWorkoutToSegments: clamping block.repeat ${rawRepeat} to ${MAX_BLOCK_REPEAT}`,
			);
		}
		const repeat = Math.min(rawRepeat, MAX_BLOCK_REPEAT);

		for (let r = 0; r < repeat; r++) {
			for (const seg of block.segments) {
				const powerLow = Math.round((seg.intensity_percent.min * ftp) / 100);
				const powerHigh = Math.round((seg.intensity_percent.max * ftp) / 100);

				let durationSecs: number;
				if (seg.duration_type === "distance") {
					// TODO: distance-based segments not yet supported (not observed
					// in captures). Carry the field through as 0 s so downstream
					// code can detect and either skip or render a placeholder.
					durationSecs = 0;
				} else {
					durationSecs =
						seg.duration_time.hour * 3600 +
						seg.duration_time.minute * 60 +
						seg.duration_time.second;
				}

				const name = classToSegmentName(seg.intensity_class);
				const targetDescription =
					`Stryd ${seg.intensity_percent.min}–${seg.intensity_percent.max}% CP ` +
					`(${powerLow}–${powerHigh}W)`;

				segments.push({
					name,
					duration_secs: durationSecs,
					target_description: targetDescription,
					target_power_low: powerLow,
					target_power_high: powerHigh,
				});
			}
		}
	}

	return segments;
}
