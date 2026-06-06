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
import type { StrydClient, StrydRecommendationSet } from "../stryd/client.js";
import type { UserProfile } from "../users.js";

/**
 * The result of a swap attempt. `suggestion` is always present (engine output
 * preserved on fallback; Stryd-augmented on success). `strydRecommendationSet`
 * is whatever Stryd returned during the attempt — populated whenever Stryd
 * answered with a body (200, including the stride-rejection-on-recovery
 * fallback path), `null` on 204 / 5xx / network errors / categories that
 * skip Stryd entirely (`rest`).
 *
 * The set is exposed so callers can persist it (the Phase 4c Promus DSW
 * emitter logs the full server response for retrospective analysis).
 */
export interface StrydSwapResult {
	suggestion: WorkoutSuggestion;
	strydRecommendationSet: StrydRecommendationSet | null;
}

/**
 * Apply the Stryd swap to a run suggestion. Pure mutation-free: returns a new
 * suggestion. The engine's `WorkoutSuggestion` is never modified in place.
 *
 * Reads `suggestion.power_context.ftp` for band computation. The engine
 * rounds Stryd's raw float CP to an integer in `src/engine/suggest.ts:171`
 * (`Math.round(strydCp.cp)`), so using `power_context.ftp` keeps the swap
 * deterministic in integer math — the same FTP that flows into every
 * other downstream surface (API responses, intervals.icu push,
 * Stryd push). Avoids the previous float-vs-int drift where the swap
 * computed bands from 285.86 (raw) while the rest of the system reported
 * 286 (rounded), making round-trip replay non-deterministic.
 */
export async function applyStrydRecommendation(
	suggestion: WorkoutSuggestion,
	strydClient: StrydClient,
): Promise<StrydSwapResult> {
	const ftp = suggestion.power_context.ftp;
	if (suggestion.sport !== "Run") {
		// Defensive — swims never reach this path under the current flag, but
		// guard anyway so a future profile-flag generalisation doesn't silently
		// trash swim prescriptions.
		return {
			suggestion: { ...suggestion, prescriptionSource: "exercitator" },
			strydRecommendationSet: null,
		};
	}

	const strydType = mapCategoryToStrydType(suggestion.category);
	if (strydType === null) {
		// "rest" — no Stryd workout exists for rest. Engine's segments stand.
		return {
			suggestion: { ...suggestion, prescriptionSource: "exercitator" },
			strydRecommendationSet: null,
		};
	}

	let set: Awaited<ReturnType<StrydClient["getRecommendedWorkouts"]>>;
	try {
		set = await strydClient.getRecommendedWorkouts(strydType);
	} catch (err) {
		return {
			suggestion: { ...suggestion, ...fallback(err) },
			strydRecommendationSet: null,
		};
	}

	if (set === null) {
		// 204 — empty bucket. `long` is empty on ze's account; the cause is
		// unconfirmed but is NOT plan-gating (Stryd support 2026-06-06 — corrects
		// the earlier RE inference; see retextor spec-recommendations.md §7).
		return {
			suggestion: {
				...suggestion,
				prescriptionSource: "exercitator-fallback",
				fallbackReason: `204_no_content_${strydType}`,
			},
			strydRecommendationSet: null,
		};
	}

	if (set.workouts.length === 0) {
		return {
			suggestion: {
				...suggestion,
				prescriptionSource: "exercitator-fallback",
				fallbackReason: "empty_workouts_array",
			},
			strydRecommendationSet: set,
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
			suggestion: {
				...suggestion,
				prescriptionSource: "exercitator-fallback",
				fallbackReason: reason,
			},
			strydRecommendationSet: set,
		};
	}

	const strydWorkout = result.picked.estimated_workout.workout;

	// Pre-flight: reject responses with an unsafe number of blocks. Real
	// workouts top out around 12 blocks (Hill Hustle); 200 is generous
	// headroom while bounding the per-segment processing cost.
	const MAX_SAFE_BLOCKS = 200;
	if (strydWorkout.blocks.length > MAX_SAFE_BLOCKS) {
		console.warn(
			`Stryd recommendation swap rejected: blocks.length=${strydWorkout.blocks.length} exceeds MAX_SAFE_BLOCKS=${MAX_SAFE_BLOCKS}`,
		);
		return {
			suggestion: {
				...suggestion,
				prescriptionSource: "exercitator-fallback",
				fallbackReason: "unsafe_block_count",
			},
			strydRecommendationSet: set,
		};
	}

	// Pre-flight: reject responses whose blocks claim absurd repeat counts.
	// `strydWorkoutToSegments` also clamps internally (defense in depth),
	// but rejecting up here means the user gets the engine's actual
	// prescription with a clear fallback chip rather than silently being
	// served a clamped version of a malformed upstream response.
	const MAX_SAFE_REPEAT = 100;
	const unsafe = strydWorkout.blocks.find(
		(b) => !Number.isInteger(b.repeat) || b.repeat < 1 || b.repeat > MAX_SAFE_REPEAT,
	);
	if (unsafe) {
		console.warn(
			`Stryd recommendation swap rejected: block.repeat=${unsafe.repeat} out of bounds [1, ${MAX_SAFE_REPEAT}]`,
		);
		return {
			suggestion: {
				...suggestion,
				prescriptionSource: "exercitator-fallback",
				fallbackReason: "unsafe_repeat_count",
			},
			strydRecommendationSet: set,
		};
	}

	// Pre-flight: reject segments with out-of-range duration components.
	// `strydWorkoutToSegments` computes `hour*3600 + minute*60 + second`,
	// so adversarial hour values would propagate as nonsense durations.
	// Bounds chosen as: any single segment ≤ 24 h; minute/second well-formed.
	// Also bound segments-per-block to prevent quadratic iteration on a
	// 1-MB payload skewed to a single block with many segments.
	const MAX_SEGMENTS_PER_BLOCK = 50;
	for (const block of strydWorkout.blocks) {
		if (block.segments.length > MAX_SEGMENTS_PER_BLOCK) {
			console.warn(
				`Stryd recommendation swap rejected: block.segments.length=${block.segments.length} exceeds MAX_SEGMENTS_PER_BLOCK=${MAX_SEGMENTS_PER_BLOCK}`,
			);
			return {
				suggestion: {
					...suggestion,
					prescriptionSource: "exercitator-fallback",
					fallbackReason: "unsafe_segments_per_block",
				},
				strydRecommendationSet: set,
			};
		}
		for (const seg of block.segments) {
			if (seg.duration_type !== "time") continue;
			if (!seg.duration_time || typeof seg.duration_time !== "object") {
				console.warn(
					"Stryd recommendation swap rejected: time-segment missing duration_time object",
				);
				return {
					suggestion: {
						...suggestion,
						prescriptionSource: "exercitator-fallback",
						fallbackReason: "malformed_duration_time",
					},
					strydRecommendationSet: set,
				};
			}
			const { hour, minute, second } = seg.duration_time;
			if (hour < 0 || hour > 24 || minute < 0 || minute >= 60 || second < 0 || second >= 60) {
				console.warn(
					`Stryd recommendation swap rejected: out-of-range duration h:${hour} m:${minute} s:${second}`,
				);
				return {
					suggestion: {
						...suggestion,
						prescriptionSource: "exercitator-fallback",
						fallbackReason: "unsafe_segment_duration",
					},
					strydRecommendationSet: set,
				};
			}
		}
	}

	// Pre-flight: cap the total expanded segment count. Even with the
	// per-block bounds above, the product (blocks × repeat × segs/block)
	// could be large in principle. The 1 MB JSON cap in client.ts is the
	// load-bearing structural defence; this is a final belt-and-braces
	// limit on the loop in strydWorkoutToSegments.
	const MAX_TOTAL_EXPANDED_SEGMENTS = 500;
	const expanded = strydWorkout.blocks.reduce((sum, b) => sum + b.repeat * b.segments.length, 0);
	if (expanded > MAX_TOTAL_EXPANDED_SEGMENTS) {
		console.warn(
			`Stryd recommendation swap rejected: expanded segments=${expanded} exceeds MAX_TOTAL_EXPANDED_SEGMENTS=${MAX_TOTAL_EXPANDED_SEGMENTS}`,
		);
		return {
			suggestion: {
				...suggestion,
				prescriptionSource: "exercitator-fallback",
				fallbackReason: "unsafe_total_segment_count",
			},
			strydRecommendationSet: set,
		};
	}

	const segments = strydWorkoutToSegments(strydWorkout, ftp);
	const totalSecs = segments.reduce((s, seg) => s + seg.duration_secs, 0);

	return {
		suggestion: {
			...suggestion,
			title: strydWorkout.title,
			segments,
			total_duration_secs: totalSecs,
			// Engine narrative replaced with Stryd's own narration of the
			// workout. The engine's rationale ("Sweet-spot tempo...") describes
			// how the engine WOULD have built the session and is superfluous
			// when Stryd's served body replaces it. Stryd's `desc` is the
			// canonical description the user sees in the Stryd app.
			rationale: strydWorkout.desc,
			// Filter out warnings that narrate engine modifications we didn't
			// apply (return-to-sport buffer text). Health-related warnings
			// (sleep, HRV, TSB, Vigil) survive — they apply regardless of who
			// built the workout.
			warnings: filterEngineWarningsForStryd(suggestion.warnings),
			// Engine terrain guidance is irrelevant — Stryd's workout type
			// carries terrain implicitly (hill repeat = hilly, fartlek =
			// flat-friendly, etc.).
			terrain: "any",
			terrain_rationale: "",
			prescriptionSource: "stryd",
			strydWorkoutId: strydWorkout.id,
			strydWorkoutTitle: strydWorkout.title,
			strydPickRationale: result.rationale,
			// Preserve the original Stryd workout payload so push-to-Stryd can
			// round-trip it back with the exact block + intensity structure
			// rather than reconstructing from our flattened segments.
			strydOriginalWorkout: strydWorkout,
			// Recommendation-set id so the send-to-* flows can PATCH the
			// selected_id back to Stryd as a preference signal.
			strydRecommendationSetId: set.id,
			// estimated_load left at the engine's category-based estimate. Stryd's
			// stress field is on a different scale (Stryd Stress Score, not
			// intervals.icu training load); recomputing here would either be wrong
			// or require its own calibration step.
		},
		strydRecommendationSet: set,
	};
}

/**
 * Drop engine-narrative warnings that describe modifications Stryd's served
 * workout doesn't carry. Today the staleness module is the only source — it
 * appends ". Adding 10s/X buffer." to two return-to-sport warning shapes
 * (src/engine/staleness.ts:88,100). When Stryd built the workout, no buffer
 * was applied; the whole warning sentence becomes engine fiction.
 *
 * Other warning sources (sleep / HRV / TSB / Vigil / power-source) survive
 * unchanged — they describe athlete state, not engine output.
 */
function filterEngineWarningsForStryd(warnings: string[]): string[] {
	return warnings.filter((w) => {
		// Staleness markers — match either of the two staleness.ts shapes.
		if (/Adding \d+s\/\w+ buffer/.test(w)) return false;
		if (/easing back in/i.test(w)) return false;
		if (/thresholds may have regressed/i.test(w)) return false;
		return true;
	});
}

/**
 * Wrapper that applies `applyStrydRecommendation` only when the per-user
 * flag + sport + status + client + CP preconditions are all met. Use this
 * from any path that produces a Run WorkoutSuggestion (Praescriptor render,
 * HTTP API /workouts/suggested, /dashboard, etc.) to keep the swap-gating
 * rules centralised. Returns the original suggestion unchanged when any
 * precondition fails. `strydRecommendationSet` is null when the swap was
 * not attempted.
 */
export async function applyStrydSwapIfEnabled(
	suggestion: WorkoutSuggestion,
	profile: UserProfile,
	strydClient: StrydClient | null | undefined,
): Promise<StrydSwapResult> {
	if (
		suggestion.sport !== "Run" ||
		suggestion.status === "awaiting_input" ||
		suggestion.status === "already_trained" ||
		suggestion.status === "health_unavailable" ||
		profile.runRecommendationSource !== "stryd" ||
		!strydClient ||
		!(suggestion.power_context.ftp > 0)
	) {
		return { suggestion, strydRecommendationSet: null };
	}
	return applyStrydRecommendation(suggestion, strydClient);
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
	// Strip control characters before logging — defends against log
	// injection if a compromised Stryd upstream embeds newlines in an
	// error response body (which is then included in the thrown Error
	// message). Cheap defence; matters whenever this log line might be
	// consumed by a downstream parser.
	const sanitisedMsg = msg.replace(/[\r\n\t\v\f]/g, " ");
	console.warn(`Stryd recommendation swap failed (${reason}): ${sanitisedMsg}`);
	return { prescriptionSource: "exercitator-fallback", fallbackReason: reason };
}
