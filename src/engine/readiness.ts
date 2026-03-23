/**
 * Computes a readiness score (0–100) from wellness data.
 * This is the primary gate that determines workout intensity.
 */

import type { ActivitySummary, WellnessRecord } from "./types.js";

export interface ReadinessResult {
	score: number;
	warnings: string[];
	components: {
		tsb: number;
		sleep: number;
		hrv: number;
		recency: number;
		subjective: number;
	};
}

/** Clamp a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Linear interpolation: maps value from [inMin, inMax] to [outMin, outMax]. */
function lerp(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
	const t = (value - inMin) / (inMax - inMin);
	return outMin + t * (outMax - outMin);
}

/** TSB component: CTL - ATL, normalised. TSB +20 → 100, TSB -20 → 0. */
function computeTsb(wellness: WellnessRecord[]): number | null {
	// Use most recent wellness record with CTL and ATL
	for (let i = wellness.length - 1; i >= 0; i--) {
		const w = wellness[i];
		if (w.ctl != null && w.atl != null) {
			const tsb = w.ctl - w.atl;
			return clamp(lerp(tsb, -20, 20, 0, 100), 0, 100);
		}
	}
	return null;
}

/** Sleep component: sleepScore direct, or sleepSecs (5h→0, 8h→100). */
function computeSleep(wellness: WellnessRecord[]): number | null {
	// Use most recent (last entry is typically today or yesterday)
	for (let i = wellness.length - 1; i >= 0; i--) {
		const w = wellness[i];
		if (w.sleepScore != null) {
			return clamp(w.sleepScore, 0, 100);
		}
		if (w.sleepSecs != null) {
			const hours = w.sleepSecs / 3600;
			return clamp(lerp(hours, 5, 8, 0, 100), 0, 100);
		}
	}
	return null;
}

/** HRV component: today's HRV vs 7-day mean. */
function computeHrv(wellness: WellnessRecord[]): number | null {
	const hrvValues = wellness.filter((w) => w.hrv != null).map((w) => w.hrv as number);
	if (hrvValues.length === 0) return null;

	const mean = hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length;
	if (mean === 0) return null;

	const today = hrvValues[hrvValues.length - 1];
	const ratio = today / mean;

	// ≥110% → 100, 100% → 75, 90% → 50, ≤75% → 0
	if (ratio >= 1.1) return 100;
	if (ratio >= 1.0) return lerp(ratio, 1.0, 1.1, 75, 100);
	if (ratio >= 0.9) return lerp(ratio, 0.9, 1.0, 50, 75);
	if (ratio >= 0.75) return lerp(ratio, 0.75, 0.9, 0, 50);
	return 0;
}

/** Recency component: hours since last activity. Sigmoid around 24h. */
function computeRecency(activities: ActivitySummary[], now: Date): number | null {
	if (activities.length === 0) return null;

	// Find most recent activity by start_date_local + moving_time
	let latestEnd = 0;
	for (const a of activities) {
		const start = new Date(a.start_date_local).getTime();
		const end = start + a.moving_time * 1000;
		if (end > latestEnd) latestEnd = end;
	}

	const hoursSince = (now.getTime() - latestEnd) / (1000 * 3600);
	// Sigmoid: 100 / (1 + exp(-0.15 * (hours - 24)))
	return 100 / (1 + Math.exp(-0.15 * (hoursSince - 24)));
}

/** Subjective component: average of inverted fatigue, inverted soreness, and readiness. */
function computeSubjective(wellness: WellnessRecord[]): number | null {
	// Use most recent record with any subjective data
	for (let i = wellness.length - 1; i >= 0; i--) {
		const w = wellness[i];
		const values: number[] = [];
		if (w.fatigue != null) values.push(10 - w.fatigue);
		if (w.soreness != null) values.push(10 - w.soreness);
		if (w.readiness != null) values.push(w.readiness);

		if (values.length > 0) {
			const avg = values.reduce((a, b) => a + b, 0) / values.length;
			return clamp((avg / 10) * 100, 0, 100);
		}
	}
	return null;
}

const NEUTRAL = 50;

export function computeReadiness(
	wellness: WellnessRecord[],
	activities: ActivitySummary[],
	now: Date = new Date(),
): ReadinessResult {
	const warnings: string[] = [];

	const tsb = computeTsb(wellness);
	const sleep = computeSleep(wellness);
	const hrv = computeHrv(wellness);
	const recency = computeRecency(activities, now);
	const subjective = computeSubjective(wellness);

	const components = {
		tsb: tsb ?? NEUTRAL,
		sleep: sleep ?? NEUTRAL,
		hrv: hrv ?? NEUTRAL,
		recency: recency ?? NEUTRAL,
		subjective: subjective ?? NEUTRAL,
	};

	// Count how many components have real data
	const realCount = [tsb, sleep, hrv, recency, subjective].filter((c) => c != null).length;
	if (realCount < 3) {
		warnings.push("Limited wellness data — suggestion may be less accurate");
	}

	const score = clamp(
		Math.round(
			components.tsb * 0.3 +
				components.sleep * 0.2 +
				components.hrv * 0.2 +
				components.recency * 0.15 +
				components.subjective * 0.15,
		),
		0,
		100,
	);

	return { score, warnings, components };
}
