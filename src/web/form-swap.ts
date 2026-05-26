/**
 * FORM Athletica recommendation swap layer.
 *
 * Mirror of `stryd-swap.ts`, applied to Swim suggestions. The engine
 * still decides the category (readiness, sleep debt, cross-training,
 * staleness); FORM replaces the segments with a personalised swim
 * workout chosen via content scoring on the effort-level zone buckets.
 *
 * On any failure (network / 401 / picker rejection / oversize) the
 * original suggestion is returned with `prescriptionSource:
 * "exercitator-fallback"` + `fallbackVendor: "form"` + a `fallbackReason`
 * so the UI can surface why.
 *
 * Vigil does not apply to swim — skipped throughout.
 */

import {
	formWorkoutToSegments,
	mapCategoryToFormType,
	pickFormWorkout,
} from "../engine/form-mapper.js";
import type { SportSettings, WorkoutSuggestion } from "../engine/types.js";
import type { FormClient, FormRecommendationSet, FormWorkoutBody } from "../form/client.js";
import type { UserProfile } from "../users.js";

/**
 * The result of a swap attempt. `suggestion` is always present (engine
 * output preserved on fallback; FORM-augmented on success).
 * `formRecommendationSet` is whatever FORM returned during the attempt;
 * `null` on errors / categories that skip FORM (`rest`).
 *
 * `formBodies` is the per-workout body map fetched alongside the set
 * (FORM's two-call pattern — the personalised list has no segments).
 * Exposed so callers can persist it (Phase 4 DSW emitter logs the full
 * server-side recommendation context).
 */
export interface FormSwapResult {
	suggestion: WorkoutSuggestion;
	formRecommendationSet: FormRecommendationSet | null;
	formBodies: Map<string, FormWorkoutBody> | null;
}

/** Defensive caps applied on the swap-layer side. The mapper also clamps
 *  internally (defence in depth); rejecting up here means the user gets
 *  the engine's actual prescription with a clear fallback chip rather
 *  than being served a clamped version of a malformed upstream response. */
const MAX_SETGROUPS = 20;
const MAX_SETS_PER_GROUP = 20;
const MAX_ROUNDS = 20;
const MAX_INTERVALS = 100;
const MAX_TOTAL_EXPANDED_SEGMENTS = 500;

/**
 * Apply the FORM swap to a swim suggestion. Pure mutation-free: returns
 * a new suggestion. The engine's `WorkoutSuggestion` is never modified
 * in place.
 *
 * Reads `swimSettings.threshold_pace` (CSS in m/s) for pace-band
 * derivation. When CSS is null/zero the swap is skipped (gated by the
 * `applyFormSwapIfEnabled` wrapper).
 */
export async function applyFormRecommendation(
	suggestion: WorkoutSuggestion,
	formClient: FormClient,
	swimSettings: SportSettings,
): Promise<FormSwapResult> {
	if (suggestion.sport !== "Swim") {
		return {
			suggestion: { ...suggestion, prescriptionSource: "exercitator" },
			formRecommendationSet: null,
			formBodies: null,
		};
	}

	const formType = mapCategoryToFormType(suggestion.category);
	if (formType === null) {
		// "rest" — no FORM workout exists for rest. Engine's segments stand.
		return {
			suggestion: { ...suggestion, prescriptionSource: "exercitator" },
			formRecommendationSet: null,
			formBodies: null,
		};
	}

	let set: FormRecommendationSet;
	let bodies: Map<string, FormWorkoutBody>;
	try {
		const fetched = await formClient.getPersonalizedWithBodies();
		set = fetched.set;
		bodies = fetched.bodies;
	} catch (err) {
		return {
			suggestion: { ...suggestion, ...fallback(err) },
			formRecommendationSet: null,
			formBodies: null,
		};
	}

	if (!set.workouts || set.workouts.length === 0) {
		return {
			suggestion: {
				...suggestion,
				prescriptionSource: "exercitator-fallback",
				fallbackVendor: "form",
				fallbackReason: "empty_workouts_array",
			},
			formRecommendationSet: set,
			formBodies: bodies,
		};
	}

	const css = swimSettings.threshold_pace ?? 0;
	const result = pickFormWorkout(suggestion.category, set, bodies, css);
	if (result === null) {
		return {
			suggestion: {
				...suggestion,
				prescriptionSource: "exercitator-fallback",
				fallbackVendor: "form",
				fallbackReason: "picker_rejected_all_candidates",
			},
			formRecommendationSet: set,
			formBodies: bodies,
		};
	}

	const formBody = result.picked;

	// Pre-flight: reject responses with an unsafe structure.
	if (formBody.setGroups.length > MAX_SETGROUPS) {
		console.warn(
			`FORM recommendation swap rejected: setGroups.length=${formBody.setGroups.length} exceeds MAX_SETGROUPS=${MAX_SETGROUPS}`,
		);
		return {
			suggestion: { ...suggestion, ...fallbackReason("unsafe_setgroup_count") },
			formRecommendationSet: set,
			formBodies: bodies,
		};
	}
	let expanded = 0;
	for (const group of formBody.setGroups) {
		if (group.sets.length > MAX_SETS_PER_GROUP) {
			console.warn(
				`FORM swap rejected: group.sets.length=${group.sets.length} exceeds MAX_SETS_PER_GROUP=${MAX_SETS_PER_GROUP}`,
			);
			return {
				suggestion: { ...suggestion, ...fallbackReason("unsafe_sets_per_group") },
				formRecommendationSet: set,
				formBodies: bodies,
			};
		}
		const rounds = Number.isFinite(group.roundsCount) ? group.roundsCount : 1;
		if (rounds < 1 || rounds > MAX_ROUNDS) {
			console.warn(`FORM swap rejected: roundsCount=${rounds} out of bounds [1, ${MAX_ROUNDS}]`);
			return {
				suggestion: { ...suggestion, ...fallbackReason("unsafe_rounds_count") },
				formRecommendationSet: set,
				formBodies: bodies,
			};
		}
		for (const s of group.sets) {
			const ic = Number.isFinite(s.intervalsCount) ? s.intervalsCount : 1;
			if (ic < 0 || ic > MAX_INTERVALS) {
				console.warn(
					`FORM swap rejected: intervalsCount=${ic} out of bounds [0, ${MAX_INTERVALS}]`,
				);
				return {
					suggestion: { ...suggestion, ...fallbackReason("unsafe_intervals_count") },
					formRecommendationSet: set,
					formBodies: bodies,
				};
			}
			if (s.intervalDistance < 0 || s.intervalDistance > 5000) {
				console.warn(`FORM swap rejected: intervalDistance=${s.intervalDistance} out of bounds`);
				return {
					suggestion: { ...suggestion, ...fallbackReason("unsafe_interval_distance") },
					formRecommendationSet: set,
					formBodies: bodies,
				};
			}
			expanded += rounds * ic;
		}
	}
	if (expanded > MAX_TOTAL_EXPANDED_SEGMENTS) {
		console.warn(
			`FORM swap rejected: expanded=${expanded} exceeds MAX_TOTAL_EXPANDED_SEGMENTS=${MAX_TOTAL_EXPANDED_SEGMENTS}`,
		);
		return {
			suggestion: { ...suggestion, ...fallbackReason("unsafe_total_segment_count") },
			formRecommendationSet: set,
			formBodies: bodies,
		};
	}

	const segments = formWorkoutToSegments(formBody, swimSettings);
	const totalSecs = segments.reduce((s, seg) => s + seg.duration_secs, 0);

	return {
		suggestion: {
			...suggestion,
			title: formBody.name,
			segments,
			total_duration_secs: totalSecs,
			// Engine narrative replaced with FORM's own multi-paragraph
			// description (includes Swimmer Type prelude + per-workout
			// coaching context).
			rationale: formBody.description,
			// FORM doesn't tell us about athlete state — keep engine warnings
			// but filter the engine-modification narrative (same shapes as
			// Stryd-swap path).
			warnings: filterEngineWarningsForForm(suggestion.warnings),
			// Pool is the implicit terrain.
			terrain: "pool",
			terrain_rationale: "",
			prescriptionSource: "form",
			formWorkoutId: formBody.id,
			formWorkoutTitle: formBody.name,
			formPickRationale: result.rationale,
			formOriginalWorkout: formBody,
			// estimated_load left at the engine's category-based estimate —
			// FORM doesn't surface a comparable training-load metric on
			// the recommendation endpoint.
		},
		formRecommendationSet: set,
		formBodies: bodies,
	};
}

function fallbackReason(reason: string): {
	prescriptionSource: "exercitator-fallback";
	fallbackVendor: "form";
	fallbackReason: string;
} {
	return {
		prescriptionSource: "exercitator-fallback",
		fallbackVendor: "form",
		fallbackReason: reason,
	};
}

/**
 * Same warning-filtering policy as the Stryd path — drop engine-modification
 * narrative ("Adding 10s/km buffer", "easing back in", "thresholds may have
 * regressed") because FORM's served body didn't have those buffers applied
 * to it. Keep all health-related warnings (sleep, HRV, TSB, cross-training).
 */
function filterEngineWarningsForForm(warnings: string[]): string[] {
	return warnings.filter((w) => {
		if (/Adding \d+s\/\w+ buffer/.test(w)) return false;
		if (/easing back in/i.test(w)) return false;
		if (/thresholds may have regressed/i.test(w)) return false;
		return true;
	});
}

/**
 * Wrapper that applies `applyFormRecommendation` only when the per-user
 * flag + sport + status + client + CSS preconditions are all met. Use
 * this from every path that produces a Swim WorkoutSuggestion
 * (Praescriptor render, HTTP API /workouts/suggested, /dashboard) to
 * keep swap-gating rules centralised. Returns the original suggestion
 * unchanged when any precondition fails.
 */
export async function applyFormSwapIfEnabled(
	suggestion: WorkoutSuggestion,
	profile: UserProfile,
	formClient: FormClient | null | undefined,
	swimSettings: SportSettings,
): Promise<FormSwapResult> {
	if (
		suggestion.sport !== "Swim" ||
		suggestion.status === "awaiting_input" ||
		profile.swimRecommendationSource !== "form" ||
		!formClient ||
		!(swimSettings.threshold_pace && swimSettings.threshold_pace > 0)
	) {
		return { suggestion, formRecommendationSet: null, formBodies: null };
	}
	return applyFormRecommendation(suggestion, formClient, swimSettings);
}

function fallback(err: unknown): {
	prescriptionSource: "exercitator-fallback";
	fallbackVendor: "form";
	fallbackReason: string;
} {
	const msg = err instanceof Error ? err.message : String(err);
	let reason = "unknown_error";
	const statusMatch = msg.match(/HTTP (\d{3})/);
	if (statusMatch) {
		reason = `http_${statusMatch[1]}`;
	} else if (/network|fetch|timeout|abort/i.test(msg)) {
		reason = "network_error";
	} else if (/response too large/i.test(msg)) {
		reason = "oversize_response";
	}
	// Strip control characters before logging — defends against log
	// injection if a compromised upstream embeds newlines in an error
	// response body included in the thrown Error message.
	const sanitised = msg.replace(/[\r\n\t\v\f]/g, " ");
	console.warn(`FORM recommendation swap failed (${reason}): ${sanitised}`);
	return {
		prescriptionSource: "exercitator-fallback",
		fallbackVendor: "form",
		fallbackReason: reason,
	};
}
