/**
 * Detects how stale an athlete's sport-specific thresholds are
 * based on time since last activity in that sport.
 *
 * Staleness tiers:
 *   normal   (0–27 days)  — no adjustment
 *   moderate (28–60 days) — downgrade one category, +10s pace buffer, warning
 *   severe   (>60 days)   — force base/recovery, +15s pace buffer, HR-only, warning
 *   no_history             — treat as severe
 */

import type { ActivitySummary, WorkoutCategory } from "./types.js";

const RUN_TYPES = ["Run", "VirtualRun", "TrailRun", "Treadmill"];
const SWIM_TYPES = ["Swim", "OpenWaterSwim", "VirtualSwim"];

export type StalenessTier = "normal" | "moderate" | "severe" | "no_history";

export interface StalenessResult {
	tier: StalenessTier;
	daysSinceLast: number | null;
	/** Seconds to add to pace targets (per 100m for swim, per km for run). */
	paceBufferSecs: number;
	/** When true, suppress pace/power targets — use HR zones only. */
	hrOnly: boolean;
	warnings: string[];
}

function isSportActivity(a: ActivitySummary, sport: "Run" | "Swim"): boolean {
	return sport === "Run" ? RUN_TYPES.includes(a.type) : SWIM_TYPES.includes(a.type);
}

/** Minimum sessions in 14-day window to consider an athlete "current" in a sport.
 *  One session after a long break shouldn't clear staleness — need consistent activity. */
const MIN_SESSIONS_FOR_CURRENT = 3;

export function computeStaleness(
	activities: ActivitySummary[],
	sport: "Run" | "Swim",
	now: Date = new Date(),
): StalenessResult {
	const sportActivities = activities.filter((a) => isSportActivity(a, sport));

	if (sportActivities.length === 0) {
		const sportName = sport.toLowerCase();
		return {
			tier: "no_history",
			daysSinceLast: null,
			paceBufferSecs: 15,
			hrOnly: true,
			warnings: [
				`No ${sportName} history found — prescribing conservative return-to-sport session`,
			],
		};
	}

	// Find most recent activity for this sport
	const sorted = [...sportActivities].sort((a, b) =>
		b.start_date_local.localeCompare(a.start_date_local),
	);
	const lastDate = new Date(sorted[0].start_date_local);
	const daysSince = (now.getTime() - lastDate.getTime()) / (1000 * 86400);

	// Check for return-to-sport pattern: recent activity exists but insufficient
	// session count to consider the athlete current. A single session after a long
	// break should not clear staleness — thresholds need recalibration.
	const sportName = sport.toLowerCase();
	const unit = sport === "Swim" ? "100m" : "km";

	if (daysSince <= 27 && sportActivities.length >= MIN_SESSIONS_FOR_CURRENT) {
		return {
			tier: "normal",
			daysSinceLast: Math.round(daysSince),
			paceBufferSecs: 0,
			hrOnly: false,
			warnings: [],
		};
	}

	// Return-to-sport: recent activity but too few sessions — treat as moderate
	if (daysSince <= 27 && sportActivities.length < MIN_SESSIONS_FOR_CURRENT) {
		return {
			tier: "moderate",
			daysSinceLast: Math.round(daysSince),
			paceBufferSecs: 10,
			hrOnly: false,
			warnings: [
				`Return to ${sportName}: only ${sportActivities.length} session${sportActivities.length === 1 ? "" : "s"} in 14 days — easing back in. Adding 10s/${unit} buffer.`,
			],
		};
	}

	if (daysSince <= 60) {
		return {
			tier: "moderate",
			daysSinceLast: Math.round(daysSince),
			paceBufferSecs: 10,
			hrOnly: false,
			warnings: [
				`Last ${sportName} was ${Math.round(daysSince)} days ago — thresholds may have regressed. Adding 10s/${unit} buffer.`,
			],
		};
	}

	return {
		tier: "severe",
		daysSinceLast: Math.round(daysSince),
		paceBufferSecs: 15,
		hrOnly: true,
		warnings: [
			`Last ${sportName} was ${Math.round(daysSince)} days ago — using HR-only targets with 15s/${unit} pace ceiling for return-to-sport safety.`,
		],
	};
}

/** Downgrade category mapping for moderate staleness. */
const DOWNGRADE: Record<WorkoutCategory, WorkoutCategory> = {
	rest: "rest",
	recovery: "recovery",
	base: "recovery",
	progression: "base",
	tempo: "base",
	threshold: "tempo",
	intervals: "threshold",
	long: "base",
};

/** Apply staleness ceiling to a workout category. Returns the same or a more conservative category. */
export function applyStaleness(category: WorkoutCategory, tier: StalenessTier): WorkoutCategory {
	if (tier === "normal") return category;

	if (tier === "severe" || tier === "no_history") {
		// Cap at base — anything above base is forced down
		const safe: WorkoutCategory[] = ["rest", "recovery", "base"];
		return safe.includes(category) ? category : "base";
	}

	// Moderate: downgrade one level
	return DOWNGRADE[category];
}
