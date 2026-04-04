/**
 * Compliance assessment: compare prescribed workout segments against
 * actual activity laps from intervals.icu.
 *
 * Binary scoring: a metric either passes or fails. No tolerance on
 * zone/power/pace targets. Duration has 15% tolerance for lap button timing.
 */

import type { WorkoutSegment } from "../engine/types.js";
import type { SegmentCompliance, TrafficLight } from "./types.js";

/** Minimal lap structure from intervals.icu activity response. */
export interface ActivityLap {
	/** Lap duration in seconds. */
	total_elapsed_time: number;
	/** Average heart rate in bpm (may be null for rest laps). */
	average_heartrate: number | null;
	/** Average power in watts (may be null for swim or no power). */
	average_watts: number | null;
	/** Average speed in m/s (may be null). */
	avg_speed: number | null;
}

/** Flattened prescription segment (repeats expanded into individual entries). */
interface FlatSegment {
	index: number; // original segment index (for reporting)
	name: string;
	durationSecs: number;
	targetHrZone: number | null;
	targetPowerLow: number | null;
	targetPowerHigh: number | null;
	targetPaceLow: number | null; // secs/km
	targetPaceHigh: number | null; // secs/km
	isRest: boolean;
}

const MIN_LAP_SECS = 30;
const DURATION_TOLERANCE = 0.15;

/**
 * Flatten prescription segments: expand repeats into individual work + rest entries.
 */
export function flattenSegments(segments: WorkoutSegment[]): FlatSegment[] {
	const result: FlatSegment[] = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];

		if (seg.repeats && seg.repeats > 1 && seg.work_duration_secs) {
			for (let r = 0; r < seg.repeats; r++) {
				result.push({
					index: i,
					name: `${seg.name} (rep ${r + 1}/${seg.repeats})`,
					durationSecs: seg.work_duration_secs,
					targetHrZone: seg.target_hr_zone ?? null,
					targetPowerLow: seg.target_power_low ?? null,
					targetPowerHigh: seg.target_power_high ?? null,
					targetPaceLow: seg.target_pace_secs_low ?? null,
					targetPaceHigh: seg.target_pace_secs_high ?? null,
					isRest: false,
				});
				if (seg.rest_duration_secs && r < seg.repeats - 1) {
					result.push({
						index: i,
						name: `${seg.name} (rest)`,
						durationSecs: seg.rest_duration_secs,
						targetHrZone: null,
						targetPowerLow: null,
						targetPowerHigh: null,
						targetPaceLow: null,
						targetPaceHigh: null,
						isRest: true,
					});
				}
			}
		} else {
			result.push({
				index: i,
				name: seg.name,
				durationSecs: seg.duration_secs,
				targetHrZone: seg.target_hr_zone ?? null,
				targetPowerLow: seg.target_power_low ?? null,
				targetPowerHigh: seg.target_power_high ?? null,
				targetPaceLow: seg.target_pace_secs_low ?? null,
				targetPaceHigh: seg.target_pace_secs_high ?? null,
				isRest: false,
			});
		}
	}

	return result;
}

/**
 * Determine the HR zone for a given heart rate using zone ceilings.
 * Zone ceilings array: index 0 = Z1 ceiling, index 1 = Z2 ceiling, etc.
 * Returns 1-based zone number.
 */
export function hrToZone(hr: number, zoneCeilings: number[]): number {
	for (let z = 0; z < zoneCeilings.length; z++) {
		if (hr <= zoneCeilings[z]) return z + 1;
	}
	return zoneCeilings.length + 1;
}

/**
 * Assess compliance by matching flattened prescription segments to activity laps.
 *
 * Uses greedy sequential matching: walk through usable laps (>30s) in order,
 * matching each to the next expected prescription segment.
 */
export function assessCompliance(
	segments: WorkoutSegment[],
	laps: ActivityLap[],
	hrZoneCeilings: number[] | null,
): {
	segments: SegmentCompliance[];
	overallPass: boolean;
	segmentsTotal: number;
	segmentsPassed: number;
} {
	const flat = flattenSegments(segments);
	const usableLaps = laps.filter((l) => l.total_elapsed_time >= MIN_LAP_SECS);

	const results: SegmentCompliance[] = [];
	let segmentsPassed = 0;

	for (let i = 0; i < flat.length; i++) {
		const seg = flat[i];
		const lap = i < usableLaps.length ? usableLaps[i] : null;

		if (seg.isRest) {
			// Rest segments: no compliance scoring
			results.push({
				segmentIndex: seg.index,
				segmentName: seg.name,
				actualAvgHr: lap?.average_heartrate ?? null,
				actualAvgPower: lap?.average_watts ?? null,
				actualAvgPace: lap?.avg_speed ? 1000 / lap.avg_speed : null,
				actualDurationSecs: lap?.total_elapsed_time ?? null,
				hrZonePass: null,
				powerPass: null,
				pacePass: null,
				durationPass: null,
				hrZoneActual: null,
				powerDeviationPct: null,
				paceDeviationPct: null,
				segmentPass: true, // rest segments always pass
				light: "green",
			});
			segmentsPassed++;
			continue;
		}

		if (!lap) {
			// No matching lap — unassessed (not penalised, but not passed)
			results.push(unassessedSegment(seg));
			continue;
		}

		const compliance = scoreSegment(seg, lap, hrZoneCeilings);
		results.push(compliance);
		if (compliance.segmentPass) segmentsPassed++;
	}

	const scoredSegments = results.filter((r) => !flat[results.indexOf(r)]?.isRest || true);
	const segmentsTotal = flat.filter((s) => !s.isRest).length;
	const overallPass = segmentsPassed === results.length;

	return { segments: results, overallPass, segmentsTotal, segmentsPassed };
}

function scoreSegment(
	seg: FlatSegment,
	lap: ActivityLap,
	hrZoneCeilings: number[] | null,
): SegmentCompliance {
	const actualPace = lap.avg_speed && lap.avg_speed > 0 ? 1000 / lap.avg_speed : null;

	// HR zone compliance
	let hrZonePass: boolean | null = null;
	let hrZoneActual: number | null = null;
	if (seg.targetHrZone != null && hrZoneCeilings && lap.average_heartrate) {
		hrZoneActual = hrToZone(lap.average_heartrate, hrZoneCeilings);
		hrZonePass = hrZoneActual <= seg.targetHrZone;
	}

	// Power compliance
	let powerPass: boolean | null = null;
	let powerDeviationPct: number | null = null;
	if (seg.targetPowerLow != null && seg.targetPowerHigh != null && lap.average_watts != null) {
		powerPass = lap.average_watts >= seg.targetPowerLow && lap.average_watts <= seg.targetPowerHigh;
		const midpoint = (seg.targetPowerLow + seg.targetPowerHigh) / 2;
		const halfRange = (seg.targetPowerHigh - seg.targetPowerLow) / 2;
		powerDeviationPct = halfRange > 0 ? ((lap.average_watts - midpoint) / halfRange) * 100 : 0;
	}

	// Pace compliance
	let pacePass: boolean | null = null;
	let paceDeviationPct: number | null = null;
	if (seg.targetPaceLow != null && seg.targetPaceHigh != null && actualPace != null) {
		// Lower pace = faster. targetPaceLow is the faster target, targetPaceHigh is slower.
		pacePass = actualPace >= seg.targetPaceLow && actualPace <= seg.targetPaceHigh;
		const midpoint = (seg.targetPaceLow + seg.targetPaceHigh) / 2;
		const halfRange = (seg.targetPaceHigh - seg.targetPaceLow) / 2;
		paceDeviationPct = halfRange > 0 ? ((actualPace - midpoint) / halfRange) * 100 : 0;
	}

	// Duration compliance (15% tolerance)
	let durationPass: boolean | null = null;
	if (seg.durationSecs > 0) {
		const ratio = lap.total_elapsed_time / seg.durationSecs;
		durationPass = ratio >= 1 - DURATION_TOLERANCE && ratio <= 1 + DURATION_TOLERANCE;
	}

	// Overall: pass iff all targeted (non-null) metrics pass
	const targeted: boolean[] = [];
	if (hrZonePass !== null) targeted.push(hrZonePass);
	if (powerPass !== null) targeted.push(powerPass);
	if (pacePass !== null) targeted.push(pacePass);
	if (durationPass !== null) targeted.push(durationPass);

	const segmentPass = targeted.length === 0 || targeted.every(Boolean);

	let light: TrafficLight;
	if (segmentPass) {
		light = "green";
	} else if (targeted.some(Boolean)) {
		light = "amber";
	} else {
		light = "red";
	}

	return {
		segmentIndex: seg.index,
		segmentName: seg.name,
		actualAvgHr: lap.average_heartrate,
		actualAvgPower: lap.average_watts,
		actualAvgPace: actualPace,
		actualDurationSecs: lap.total_elapsed_time,
		hrZonePass,
		powerPass,
		pacePass,
		durationPass,
		hrZoneActual,
		powerDeviationPct,
		paceDeviationPct,
		segmentPass,
		light,
	};
}

function unassessedSegment(seg: FlatSegment): SegmentCompliance {
	return {
		segmentIndex: seg.index,
		segmentName: seg.name,
		actualAvgHr: null,
		actualAvgPower: null,
		actualAvgPace: null,
		actualDurationSecs: null,
		hrZonePass: null,
		powerPass: null,
		pacePass: null,
		durationPass: null,
		hrZoneActual: null,
		powerDeviationPct: null,
		paceDeviationPct: null,
		segmentPass: false,
		light: "red",
	};
}
