/**
 * Cross-training strain assessment for weight training and climbing activities.
 *
 * Three-tier cascade:
 *   Tier 1: In-session HRV (RMSSD from R-R intervals) — most objective
 *   Tier 2: session_rpe (duration × RPE) vs rolling baseline
 *   Tier 3: Unknown — prescription blocked until user provides RPE
 *
 * Cross-training strain feeds into workout-selector for:
 *   - Hard-session guard (prevents back-to-back intensity)
 *   - Same-day cap (limits endurance prescription after weights)
 */

import { localDateStr } from "./date-utils.js";
import type { ActivitySummary } from "./types.js";

// ---------------------------------------------------------------------------
// Classification (#18)
// ---------------------------------------------------------------------------

export const CROSS_TRAINING_TYPES = ["WeightTraining", "RockClimbing", "IndoorClimbing"] as const;
export type CrossTrainingType = (typeof CROSS_TRAINING_TYPES)[number];

export function isCrossTraining(type: string): boolean {
	return (CROSS_TRAINING_TYPES as readonly string[]).includes(type);
}

export function findTodayCrossTraining(
	activities: ActivitySummary[],
	now: Date,
	tz?: string,
): ActivitySummary[] {
	const today = localDateStr(now, tz);
	return activities.filter(
		(a) => isCrossTraining(a.type) && a.start_date_local.slice(0, 10) === today,
	);
}

// ---------------------------------------------------------------------------
// Strain result type (#19, #23)
// ---------------------------------------------------------------------------

export type StrainLevel = "light" | "moderate" | "hard" | "unknown";

export interface CrossTrainingStrain {
	activityId: string;
	activityType: string;
	level: StrainLevel;
	source: "hrv" | "session_rpe" | "awaiting_input";
	sessionRpe?: number;
	sessionRmssd?: number;
	baselineSessionRpe?: { mean: number; sd: number; n: number };
	baselineRmssd?: { mean: number; sd: number; n: number };
	summary: string;
}

// ---------------------------------------------------------------------------
// Tier 1: HRV strain (RMSSD from R-R intervals) (#23)
// ---------------------------------------------------------------------------

/**
 * Flatten per-second R-R arrays from intervals.icu HRV stream.
 * Filters artefacts outside physiological range (300–2000ms).
 */
export function flattenHrvStream(stream: (number[] | null)[]): number[] {
	const rr: number[] = [];
	for (const sample of stream) {
		if (sample == null) continue;
		for (const val of sample) {
			if (val >= 300 && val <= 2000) rr.push(val);
		}
	}
	return rr;
}

/**
 * Standard RMSSD: root mean square of successive R-R differences.
 */
export function computeRmssd(rrIntervals: number[]): number {
	if (rrIntervals.length < 2) return 0;
	let sumSq = 0;
	for (let i = 1; i < rrIntervals.length; i++) {
		const diff = rrIntervals[i] - rrIntervals[i - 1];
		sumSq += diff * diff;
	}
	return Math.sqrt(sumSq / (rrIntervals.length - 1));
}

/**
 * Assess strain from in-session RMSSD relative to baseline.
 * Lower RMSSD = more autonomic stress = harder session.
 * Returns null if baseline is insufficient (< 3 activities).
 */
export function assessStrainFromHrv(
	sessionRmssd: number,
	baseline: { mean: number; sd: number; n: number } | null,
): StrainLevel | null {
	if (!baseline || baseline.n < 3 || baseline.sd <= 0) return null;
	if (sessionRmssd > baseline.mean) return "light";
	if (sessionRmssd >= baseline.mean - baseline.sd) return "moderate";
	return "hard";
}

// ---------------------------------------------------------------------------
// Tier 2: session_rpe strain (#19)
// ---------------------------------------------------------------------------

/**
 * Compute rolling baseline from the last N cross-training activities with session_rpe.
 * Returns null if fewer than 3 qualifying activities.
 */
export function computeSessionRpeBaseline(
	activities: ActivitySummary[],
	maxActivities = 10,
): { mean: number; sd: number; n: number } | null {
	const vals = activities
		.filter((a) => isCrossTraining(a.type) && a.session_rpe != null)
		.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local))
		.slice(0, maxActivities)
		.map((a) => a.session_rpe as number);

	if (vals.length < 3) return null;

	const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
	const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
	const sd = Math.sqrt(variance);

	return { mean, sd, n: vals.length };
}

/**
 * Assess strain from session_rpe relative to baseline.
 * Uses absolute fallback thresholds when baseline is insufficient.
 */
export function assessStrainFromSessionRpe(
	sessionRpe: number,
	baseline: { mean: number; sd: number; n: number } | null,
): StrainLevel {
	// Absolute fallback when baseline has < 3 activities
	if (!baseline) {
		if (sessionRpe > 400) return "hard";
		if (sessionRpe > 200) return "moderate";
		return "light";
	}

	if (sessionRpe > baseline.mean + baseline.sd) return "hard";
	if (sessionRpe >= baseline.mean) return "moderate";
	return "light";
}

// ---------------------------------------------------------------------------
// Cascade: assess cross-training strain for a single activity (#19, #23)
// ---------------------------------------------------------------------------

/**
 * Run the three-tier strain cascade for a cross-training activity.
 *
 * @param activity - The cross-training activity to assess
 * @param allActivities - All recent activities (for baseline computation)
 * @param hrvStream - Optional HRV stream data from intervals.icu (tier 1)
 * @param hrvBaseline - Optional rolling RMSSD baseline (tier 1)
 */
export function assessCrossTrainingStrain(
	activity: ActivitySummary,
	allActivities: ActivitySummary[],
	hrvStream?: (number[] | null)[] | null,
	hrvBaseline?: { mean: number; sd: number; n: number } | null,
): CrossTrainingStrain {
	const base = {
		activityId: activity.id,
		activityType: activity.type,
	};

	// Tier 1: HRV (if stream available)
	if (hrvStream && hrvStream.length > 0) {
		const rr = flattenHrvStream(hrvStream);
		if (rr.length >= 10) {
			const rmssd = computeRmssd(rr);
			const level = assessStrainFromHrv(rmssd, hrvBaseline ?? null);
			if (level) {
				return {
					...base,
					level,
					source: "hrv",
					sessionRmssd: rmssd,
					baselineRmssd: hrvBaseline ?? undefined,
					summary: `HRV strain: ${level} (RMSSD ${Math.round(rmssd)}ms)`,
				};
			}
		}
	}

	// Tier 2: session_rpe (if available)
	if (activity.session_rpe != null) {
		const rpeBaseline = computeSessionRpeBaseline(allActivities);
		const level = assessStrainFromSessionRpe(activity.session_rpe, rpeBaseline);
		return {
			...base,
			level,
			source: "session_rpe",
			sessionRpe: activity.session_rpe,
			baselineSessionRpe: rpeBaseline ?? undefined,
			summary: `Session RPE strain: ${level} (sRPE ${activity.session_rpe})`,
		};
	}

	// Tier 3: unknown — prescription should be gated
	return {
		...base,
		level: "unknown",
		source: "awaiting_input",
		summary: `${activity.type} strain unknown — RPE required`,
	};
}
