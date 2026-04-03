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

	// ≥110% → 100, 100% → 75, 90% → 50, 75% → 20, ≤60% → 0
	if (ratio >= 1.1) return 100;
	if (ratio >= 1.0) return lerp(ratio, 1.0, 1.1, 75, 100);
	if (ratio >= 0.9) return lerp(ratio, 0.9, 1.0, 50, 75);
	if (ratio >= 0.75) return lerp(ratio, 0.75, 0.9, 20, 50);
	if (ratio >= 0.6) return lerp(ratio, 0.6, 0.75, 0, 20);
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

/** Subjective component: average of inverted fatigue, inverted soreness, and readiness.
 *  All values are normalised to 0–100 before averaging.
 *  - fatigue/soreness: intervals.icu 0–10 scale, inverted (10 - value) then × 10
 *  - readiness: Oura/Garmin 0–100 scale, used directly */
function computeSubjective(wellness: WellnessRecord[]): number | null {
	// Use most recent record with any subjective data
	for (let i = wellness.length - 1; i >= 0; i--) {
		const w = wellness[i];
		const values: number[] = [];
		// fatigue/soreness are 0–10 (intervals.icu manual entry) — invert and scale to 0–100
		if (w.fatigue != null) values.push((10 - w.fatigue) * 10);
		if (w.soreness != null) values.push((10 - w.soreness) * 10);
		// readiness is 0–100 (Oura/Garmin) — use directly
		if (w.readiness != null) values.push(w.readiness);

		if (values.length > 0) {
			const avg = values.reduce((a, b) => a + b, 0) / values.length;
			return clamp(avg, 0, 100);
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

	// ── Advisory warnings for individual components ──────────────────
	// These do not change the score or workout selection — they are
	// informational only, surfaced to the athlete via the suggestion.

	if (hrv != null && hrv < 50) {
		const hrvValues = wellness.filter((w) => w.hrv != null).map((w) => w.hrv as number);
		const mean = hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length;
		const today = hrvValues[hrvValues.length - 1];
		warnings.push(
			`HRV below 7-day baseline (${today}ms vs ${Math.round(mean)}ms mean) — recovery may be incomplete`,
		);
	}

	if (sleep != null && sleep < 70) {
		for (let i = wellness.length - 1; i >= 0; i--) {
			const w = wellness[i];
			if (w.sleepSecs != null && w.sleepSecs < 25200) {
				const hours = w.sleepSecs / 3600;
				const h = Math.floor(hours);
				const m = Math.round((hours % 1) * 60)
					.toString()
					.padStart(2, "0");
				warnings.push(`Sleep below 7 hours (${h}h${m}m) — consider lighter intensity`);
				break;
			}
			if (w.sleepScore != null && w.sleepScore < 75) {
				warnings.push(`Sleep score low (${w.sleepScore}) — consider lighter intensity`);
				break;
			}
		}
	}

	// Multi-night sleep trend: 3+ consecutive nights under 7 hours or score < 75
	const recentSleep = wellness.slice(-3).filter((w) => w.sleepSecs != null || w.sleepScore != null);
	if (recentSleep.length >= 3) {
		const poorNights = recentSleep.filter(
			(w) =>
				(w.sleepSecs != null && w.sleepSecs < 25200) || (w.sleepScore != null && w.sleepScore < 75),
		);
		if (poorNights.length >= 3) {
			warnings.push("Sleep debt accumulating — 3+ consecutive nights of poor sleep");
		}
	}

	if (tsb != null && tsb < 30) {
		warnings.push("Training stress balance is negative — fatigue exceeds fitness");
	}

	if (subjective != null && subjective < 40) {
		warnings.push("Self-reported fatigue or soreness is elevated");
	}

	return { score, warnings, components };
}
