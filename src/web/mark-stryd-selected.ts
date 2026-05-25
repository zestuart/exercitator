/**
 * Fire-and-forget PATCH to Stryd marking a recommended workout as selected.
 *
 * Called from both `sendToStryd` and `sendToIntervals` after a successful
 * push, so Stryd's recommendation engine learns the user picked this
 * workout regardless of which execution channel was chosen. The PATCH is
 * state-only on Stryd's side (no calendar entry, no schedule) — verified
 * 2026-05-25, see `notes/stryd-api/spec-recommendations.md` in the retextor
 * repo.
 *
 * Never blocks the sender. Errors are logged via console.warn and dropped.
 */

import type { WorkoutSuggestion } from "../engine/types.js";
import type { StrydClient } from "../stryd/client.js";

/**
 * Fire the PATCH if (and only if) the suggestion carries both the
 * recommendation-set id AND the picked workout id — i.e. came from a
 * successful Stryd swap on a Stryd-enabled profile. Engine-built /
 * fallback / swim suggestions short-circuit.
 *
 * Returns a Promise<void> for testability; production callers can ignore.
 */
export function markStrydRecommendationSelected(
	strydClient: StrydClient | null | undefined,
	suggestion: WorkoutSuggestion | null,
): Promise<void> {
	if (!strydClient || !suggestion) return Promise.resolve();
	const setId = suggestion.strydRecommendationSetId;
	const workoutId = suggestion.strydWorkoutId;
	if (!setId || workoutId === undefined) return Promise.resolve();

	return strydClient.markRecommendationSelected(setId, workoutId).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		const sanitised = msg.replace(/[\r\n\t\v\f]/g, " ");
		console.warn(
			`markStrydRecommendationSelected: PATCH failed for set ${setId} workout ${workoutId}: ${sanitised}`,
		);
	});
}
