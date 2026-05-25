/**
 * Stryd recommendation swap layer.
 *
 * Replaces the engine's run-prescription segments with a Stryd-served workout
 * chosen via {@link pickStrydWorkout}. The engine's category decision drives
 * the Stryd `type` query parameter; the engine's title is replaced by Stryd's;
 * segments are recomputed; everything else (rationale, readiness_score,
 * vigil, warnings, terrain, power_context, estimated_load) is preserved from
 * the engine output.
 *
 * Used only when the caller's user profile has `runRecommendationSource:
 * "stryd"`. On any failure (404 / 401 / 5xx / network / 204 / picker
 * rejection) the original suggestion is returned with `prescriptionSource:
 * "exercitator-fallback"` and a `fallbackReason` so the UI can surface why.
 */

import {
	mapCategoryToStrydType,
	pickStrydWorkout,
	strydWorkoutToSegments,
} from "../engine/stryd-mapper.js";
import type { WorkoutSuggestion } from "../engine/types.js";
import type { StrydClient } from "../stryd/client.js";

/**
 * Apply the Stryd swap to a run suggestion. Pure mutation-free: returns a new
 * suggestion. The engine's `WorkoutSuggestion` is never modified in place.
 */
export async function applyStrydRecommendation(
	suggestion: WorkoutSuggestion,
	strydClient: StrydClient,
	ftp: number,
): Promise<WorkoutSuggestion> {
	if (suggestion.sport !== "Run") {
		// Defensive — swims never reach this path under the current flag, but
		// guard anyway so a future profile-flag generalisation doesn't silently
		// trash swim prescriptions.
		return { ...suggestion, prescriptionSource: "exercitator" };
	}

	const strydType = mapCategoryToStrydType(suggestion.category);
	if (strydType === null) {
		// "rest" — no Stryd workout exists for rest. Engine's segments stand.
		return { ...suggestion, prescriptionSource: "exercitator" };
	}

	let set: Awaited<ReturnType<StrydClient["getRecommendedWorkouts"]>>;
	try {
		set = await strydClient.getRecommendedWorkouts(strydType);
	} catch (err) {
		return { ...suggestion, ...fallback(err) };
	}

	if (set === null) {
		// 204 — empty bucket. For `long` this is the steady state on
		// non-adaptive-plan accounts (per Phase 0 verification).
		return {
			...suggestion,
			prescriptionSource: "exercitator-fallback",
			fallbackReason: `204_no_content_${strydType}`,
		};
	}

	if (set.workouts.length === 0) {
		return {
			...suggestion,
			prescriptionSource: "exercitator-fallback",
			fallbackReason: "empty_workouts_array",
		};
	}

	const result = pickStrydWorkout(suggestion.category, set);
	if (result === null) {
		// `pickStrydWorkout` returns null when:
		//  - category === "recovery" AND every candidate is a stride workout
		//    (we don't want strides on a real recovery day)
		const reason =
			suggestion.category === "recovery"
				? "stride_rejected_on_recovery"
				: "picker_rejected_all_candidates";
		return {
			...suggestion,
			prescriptionSource: "exercitator-fallback",
			fallbackReason: reason,
		};
	}

	const strydWorkout = result.picked.estimated_workout.workout;
	const segments = strydWorkoutToSegments(strydWorkout, ftp);
	const totalSecs = segments.reduce((s, seg) => s + seg.duration_secs, 0);

	return {
		...suggestion,
		title: strydWorkout.title,
		segments,
		total_duration_secs: totalSecs,
		prescriptionSource: "stryd",
		strydWorkoutId: strydWorkout.id,
		strydWorkoutTitle: strydWorkout.title,
		strydPickRationale: result.rationale,
		// estimated_load left at the engine's category-based estimate. Stryd's
		// stress field is on a different scale (Stryd Stress Score, not
		// intervals.icu training load); recomputing here would either be wrong
		// or require its own calibration step.
	};
}

function fallback(err: unknown): {
	prescriptionSource: "exercitator-fallback";
	fallbackReason: string;
} {
	const msg = err instanceof Error ? err.message : String(err);
	let reason = "unknown_error";
	const statusMatch = msg.match(/HTTP (\d{3})/);
	if (statusMatch) {
		reason = `http_${statusMatch[1]}`;
	} else if (/network|fetch|timeout|abort/i.test(msg)) {
		reason = "network_error";
	}
	console.warn(`Stryd recommendation swap failed (${reason}): ${msg}`);
	return { prescriptionSource: "exercitator-fallback", fallbackReason: reason };
}
