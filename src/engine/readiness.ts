/**
 * Computes a readiness score (0–100) from wellness data.
 * This is the primary gate that determines workout intensity.
 */

import type { ActivitySummary, WellnessRecord } from "./types.js";

const RUN_TYPES = ["Run", "VirtualRun", "TrailRun", "Treadmill"];
const SWIM_TYPES = ["Swim", "OpenWaterSwim", "VirtualSwim"];

/** Rebuild detection: low chronic load + intact power capacity. An athlete
 *  returning to training after a layoff has CTL trailing real fitness; the
 *  TSB-vs-CTL signal flags them as suppressed when they aren't. We lift the
 *  TSB component floor when CTL < 30 AND FTP/CTL > 12 W per CTL-point — the
 *  threshold roughly corresponds to "trained athlete in rebuild" vs "true
 *  beginner at the same CTL". */
const REBUILD_CTL_CEILING = 30;
const REBUILD_FTP_PER_CTL = 12;
const REBUILD_TSB_FLOOR = 60;

export interface ReadinessOptions {
	/** Athlete's current FTP/CP in watts. When provided alongside CTL,
	 *  the rebuild detection can lift the TSB component floor. */
	ftp?: number;
	/** Target sport for the prescription. When provided, recency filters to
	 *  same-sport activities only — a cross-sport activity shouldn't suppress
	 *  readiness for a different prescription. */
	sport?: "Run" | "Swim";
}

export interface ReadinessResult {
	score: number;
	warnings: string[];
	/** When true, 3+ recent nights of poor sleep detected — should cap intensity. */
	sleepDebt: boolean;
	/** When true, the TSB floor was applied (low CTL + intact FTP). */
	rebuild: boolean;
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

/** TSB component: CTL - ATL, normalised. TSB +20 → 100, TSB -20 → 0.
 *  Returns { score, rebuild } where rebuild=true indicates the floor was applied. */
function computeTsb(
	wellness: WellnessRecord[],
	ftp?: number,
): { score: number; rebuild: boolean } | null {
	// Use most recent wellness record with CTL and ATL
	for (let i = wellness.length - 1; i >= 0; i--) {
		const w = wellness[i];
		if (w.ctl != null && w.atl != null) {
			const tsb = w.ctl - w.atl;
			let score = clamp(lerp(tsb, -20, 20, 0, 100), 0, 100);
			let rebuild = false;
			if (
				ftp != null &&
				ftp > 0 &&
				w.ctl > 0 &&
				w.ctl < REBUILD_CTL_CEILING &&
				ftp / w.ctl > REBUILD_FTP_PER_CTL
			) {
				rebuild = true;
				if (score < REBUILD_TSB_FLOOR) score = REBUILD_TSB_FLOOR;
			}
			return { score, rebuild };
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

/** Recency component: hours since last activity. Sigmoid around 24h.
 *
 *  Without `sport`: returns null when no activities at all (no data signal).
 *  With `sport`: only same-sport activities count; returns 100 (fully rested
 *  for this sport) when no same-sport activity exists in the window. A swim or
 *  ride shouldn't suppress readiness for a Run prescription. */
function computeRecency(
	activities: ActivitySummary[],
	now: Date,
	sport?: "Run" | "Swim",
): number | null {
	if (activities.length === 0) return null;

	if (sport) {
		const sportTypes = sport === "Run" ? RUN_TYPES : SWIM_TYPES;
		let latestEnd = 0;
		for (const a of activities) {
			if (!sportTypes.includes(a.type)) continue;
			const start = new Date(a.start_date_local).getTime();
			const end = start + a.moving_time * 1000;
			if (end > latestEnd) latestEnd = end;
		}
		if (latestEnd === 0) return 100; // No same-sport activity → fully rested for this sport
		const hoursSince = (now.getTime() - latestEnd) / (1000 * 3600);
		return 100 / (1 + Math.exp(-0.15 * (hoursSince - 24)));
	}

	let latestEnd = 0;
	for (const a of activities) {
		const start = new Date(a.start_date_local).getTime();
		const end = start + a.moving_time * 1000;
		if (end > latestEnd) latestEnd = end;
	}
	const hoursSince = (now.getTime() - latestEnd) / (1000 * 3600);
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

const WEIGHT_TSB = 0.3;
const WEIGHT_SLEEP = 0.2;
const WEIGHT_HRV = 0.2;
const WEIGHT_RECENCY = 0.15;
const WEIGHT_SUBJECTIVE = 0.15;

export function computeReadiness(
	wellness: WellnessRecord[],
	activities: ActivitySummary[],
	now: Date = new Date(),
	options: ReadinessOptions = {},
): ReadinessResult {
	const warnings: string[] = [];

	const tsbResult = computeTsb(wellness, options.ftp);
	const tsb = tsbResult?.score ?? null;
	const rebuild = tsbResult?.rebuild ?? false;
	const sleep = computeSleep(wellness);
	const hrv = computeHrv(wellness);
	const recency = computeRecency(activities, now, options.sport);
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

	// Weighted aggregation. With ≥ 3 real components, renormalise across present
	// components — a missing component (e.g. subjective when no RPE logged)
	// shouldn't silently drag readiness toward 50. With < 3, fall back to NEUTRAL
	// defaults so a thin-data score stays conservative.
	let score: number;
	if (realCount >= 3) {
		const parts: Array<[number | null, number]> = [
			[tsb, WEIGHT_TSB],
			[sleep, WEIGHT_SLEEP],
			[hrv, WEIGHT_HRV],
			[recency, WEIGHT_RECENCY],
			[subjective, WEIGHT_SUBJECTIVE],
		];
		const presentParts = parts.filter(([v]) => v != null) as Array<[number, number]>;
		const totalWeight = presentParts.reduce((s, [, w]) => s + w, 0);
		score = clamp(
			Math.round(presentParts.reduce((s, [v, w]) => s + v * w, 0) / totalWeight),
			0,
			100,
		);
	} else {
		score = clamp(
			Math.round(
				components.tsb * WEIGHT_TSB +
					components.sleep * WEIGHT_SLEEP +
					components.hrv * WEIGHT_HRV +
					components.recency * WEIGHT_RECENCY +
					components.subjective * WEIGHT_SUBJECTIVE,
			),
			0,
			100,
		);
	}

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

	// Multi-night sleep trend: 3+ recent nights of poor sleep (< 7h or score < 75).
	// Only considers the last 3 wellness records that have sleep data — these are
	// typically consecutive nights, but we don't enforce strict date adjacency since
	// wellness records may have gaps (e.g. no device worn one night).
	let sleepDebt = false;
	const recentSleep = wellness.filter((w) => w.sleepSecs != null || w.sleepScore != null).slice(-3);
	if (recentSleep.length >= 3) {
		const poorNights = recentSleep.filter(
			(w) =>
				(w.sleepSecs != null && w.sleepSecs < 25200) || (w.sleepScore != null && w.sleepScore < 75),
		);
		if (poorNights.length >= 3) {
			sleepDebt = true;
			warnings.push("Sleep debt accumulating — 3+ recent nights of poor sleep");
		}
	}

	if (tsb != null && tsb < 30) {
		warnings.push("Training stress balance is negative — fatigue exceeds fitness");
	}

	if (subjective != null && subjective < 40) {
		warnings.push("Self-reported fatigue or soreness is elevated");
	}

	return { score, warnings, sleepDebt, rebuild, components };
}
