/**
 * Converts Praescriptor WorkoutSegment[] to Stryd workout API format.
 *
 * Stryd power targets use percentage of critical power (CP).
 * Our zone model: Z1=0–55%, Z2=55–75%, Z3=75–90%, Z4=90–105%, Z5=105–120%.
 */

import { localDateStr } from "../engine/date-utils.js";
import type { WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";
import type {
	StrydWorkoutBlock,
	StrydWorkoutPayload,
	StrydWorkoutSegment,
} from "../stryd/client.js";

/** Zone → CP percentage mapping: [min, max, centre]. */
const ZONE_CP_PCT: Record<number, [number, number, number]> = {
	1: [0, 55, 28],
	2: [55, 75, 65],
	3: [75, 90, 83],
	4: [90, 105, 98],
	5: [105, 120, 113],
};

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
	zone: number,
	desc: string,
): StrydWorkoutSegment {
	const [min, max, value] = ZONE_CP_PCT[zone] ?? ZONE_CP_PCT[2];
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
	const zone = seg.target_hr_zone ?? 2;

	// Interval block: work + rest segments repeated N times
	if (reps > 1 && seg.work_duration_secs && seg.rest_duration_secs) {
		return {
			repeat: reps,
			segments: [
				makeSegment(seg.work_duration_secs, "work", zone, seg.target_description),
				makeSegment(seg.rest_duration_secs, "rest", 1, "Easy jog recovery"),
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

/** Convert a Praescriptor workout suggestion to a Stryd workout payload. */
export function toStrydWorkout(suggestion: WorkoutSuggestion, tz?: string): StrydWorkoutPayload {
	return {
		type: suggestion.category,
		title: suggestion.title,
		desc: `Praescriptor ${localDateStr(new Date(), tz)} \u2014 ${suggestion.rationale}`,
		blocks: suggestion.segments.map(segmentToBlock),
	};
}
