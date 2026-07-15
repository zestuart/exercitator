/**
 * Converts Praescriptor WorkoutSegment[] to Stryd workout API format.
 *
 * Stryd power targets use percentage of critical power (CP). The zone
 * mapping mirrors Stryd's published 5-zone model:
 *   Z1 Easy        65–80%
 *   Z2 Moderate    80–90%
 *   Z3 Threshold   90–100%
 *   Z4 Interval    100–115%
 *   Z5 Repetition  115–130%
 *
 * Each segment carries an explicit `stryd_zone` (1–5) for working efforts.
 * Warm-up / cool-down / rest segments fall through to the sub-Z1 recovery
 * band so a "5-min easy walk" pre-set isn't pushed up into a jog target.
 */

import { localDateStr } from "../engine/date-utils.js";
import type { WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";
import type {
	StrydRecommendedBlock,
	StrydWorkout,
	StrydWorkoutBlock,
	StrydWorkoutPayload,
	StrydWorkoutSegment,
} from "../stryd/client.js";

/** Stryd 5-zone working bands → CP percentage [min, max, centre]. */
const ZONE_CP_PCT: Record<number, [number, number, number]> = {
	1: [65, 80, 72],
	2: [80, 90, 85],
	3: [90, 100, 95],
	4: [100, 115, 107],
	5: [115, 130, 122],
};

/** Sub-Z1 recovery band — warm-up walks, cool-downs, easy-jog rest steps. */
const RECOVERY_PCT: [number, number, number] = [0, 65, 50];

function toHms(secs: number): { hour: number; minute: number; second: number } {
	return {
		hour: Math.floor(secs / 3600),
		minute: Math.floor((secs % 3600) / 60),
		second: secs % 60,
	};
}

function intensityClass(seg: WorkoutSegment): StrydWorkoutSegment["intensity_class"] {
	const n = seg.name.toLowerCase();
	if (n.includes("warm")) return "warmup";
	if (n.includes("cool")) return "cooldown";
	if (n.includes("recov") || n.includes("rest") || n.includes("easy")) return "rest";
	return "work";
}

function makeSegment(
	durationSecs: number,
	cls: StrydWorkoutSegment["intensity_class"],
	zone: number | null,
	desc: string,
): StrydWorkoutSegment {
	// Warm-up / cool-down / rest steps live below Stryd Z1 — pushing them up
	// into 65–80% would force a jog where a walk-into-easy-build is intended.
	const isRecoveryClass = cls === "warmup" || cls === "cooldown" || cls === "rest";
	const [min, max, value] = isRecoveryClass
		? RECOVERY_PCT
		: zone != null && ZONE_CP_PCT[zone]
			? ZONE_CP_PCT[zone]
			: ZONE_CP_PCT[1];
	return {
		desc,
		desc_no_cp: "",
		duration_type: "time",
		duration_time: toHms(durationSecs),
		intensity_class: cls,
		intensity_type: "percentage",
		intensity_percent: { min, max, value },
		flexible: false,
		incline: 0,
		grade: 0,
		distance_unit_selected: "km",
		duration_distance: 0,
		pdc_target: 0,
		rpe_selected: 1,
		zone_selected: 0,
		uuid: crypto.randomUUID(),
	};
}

function segmentToBlock(seg: WorkoutSegment): StrydWorkoutBlock {
	const reps = seg.repeats ?? 1;
	// Prefer the explicit `stryd_zone` set by the engine. Fall back to
	// `target_hr_zone` for legacy segments (e.g. Swim) and finally to Z1
	// Easy when neither is set.
	const zone = seg.stryd_zone ?? seg.target_hr_zone ?? 1;

	// Interval block: work + rest segments repeated N times
	if (reps > 1 && seg.work_duration_secs && seg.rest_duration_secs) {
		return {
			repeat: reps,
			segments: [
				makeSegment(seg.work_duration_secs, "work", zone, seg.target_description),
				// Inter-rep recovery sits in the sub-Z1 band — `rest`
				// intensity_class triggers RECOVERY_PCT in makeSegment.
				makeSegment(seg.rest_duration_secs, "rest", null, "Easy jog recovery"),
			],
			uuid: crypto.randomUUID(),
		};
	}

	// Distance-based segment. Defensive: Stryd-sourced distance workouts
	// round-trip verbatim via `strydOriginalWorkout` in `toStrydWorkout` and
	// never reach this flattened path, but if a distance segment ever arrives
	// here don't silently drop its distance (which `makeSegment` would, being
	// time-only). Emit metres — Exercitator is metric end-to-end.
	if (seg.duration_type === "distance" && seg.distance_m != null) {
		const base = makeSegment(0, intensityClass(seg), zone, seg.target_description);
		return {
			repeat: 1,
			segments: [
				{
					...base,
					duration_type: "distance",
					duration_time: toHms(0),
					distance_unit_selected: "meter",
					duration_distance: Math.round(seg.distance_m),
				},
			],
			uuid: crypto.randomUUID(),
		};
	}

	// Simple block
	return {
		repeat: 1,
		segments: [makeSegment(seg.duration_secs, intensityClass(seg), zone, seg.target_description)],
		uuid: crypto.randomUUID(),
	};
}

/**
 * Convert a Stryd recommendation segment (from `/workouts/recommendations`)
 * into a Stryd write-API segment. Same shape modulo the `uuid` field which
 * the write API generates fresh for the new workout.
 */
function reconstructWriteSegment(
	src: StrydRecommendedBlock["segments"][number],
): StrydWorkoutSegment {
	return {
		desc: src.desc,
		desc_no_cp: src.desc_no_cp,
		duration_type: src.duration_type,
		duration_time: src.duration_time,
		intensity_class: src.intensity_class,
		intensity_type: "percentage",
		intensity_percent: src.intensity_percent,
		flexible: src.flexible,
		incline: src.incline,
		grade: src.grade,
		distance_unit_selected: src.distance_unit_selected,
		duration_distance: src.duration_distance,
		pdc_target: src.pdc_target,
		rpe_selected: src.rpe_selected,
		zone_selected: src.zone_selected,
		uuid: crypto.randomUUID(),
	};
}

function reconstructWriteBlock(src: StrydRecommendedBlock): StrydWorkoutBlock {
	return {
		repeat: src.repeat,
		segments: src.segments.map(reconstructWriteSegment),
		uuid: crypto.randomUUID(),
	};
}

/** Convert a Praescriptor workout suggestion to a Stryd workout payload. */
export function toStrydWorkout(suggestion: WorkoutSuggestion, tz?: string): StrydWorkoutPayload {
	// Stryd-sourced: round-trip the original Stryd workout payload verbatim
	// (block structure, repeat counts, exact intensity_percent bands). The
	// flattened WorkoutSegment[] would lose the repeat shape and the
	// engine-built converter would substitute Z1 Easy for every burst because
	// Stryd-sourced segments don't carry `stryd_zone`.
	if (suggestion.strydOriginalWorkout) {
		const orig = suggestion.strydOriginalWorkout as StrydWorkout;
		return {
			type: orig.type,
			title: orig.title,
			desc: orig.desc,
			blocks: orig.blocks.map(reconstructWriteBlock),
		};
	}

	// Engine-built (Pam, fallback, swim, rest): build from WorkoutSegment[].
	return {
		type: suggestion.category,
		title: suggestion.title,
		desc: `Praescriptor ${localDateStr(new Date(), tz)} \u2014 ${suggestion.rationale}`,
		blocks: suggestion.segments.map(segmentToBlock),
	};
}
