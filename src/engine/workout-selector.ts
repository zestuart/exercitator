/**
 * Maps readiness score + training context to a WorkoutCategory.
 */

import type { ActivitySummary, WorkoutCategory } from "./types.js";

const RUN_TYPES = ["Run", "VirtualRun", "TrailRun", "Treadmill"];
const SWIM_TYPES = ["Swim", "OpenWaterSwim", "VirtualSwim"];

function isSportActivity(a: ActivitySummary, sport: "Run" | "Swim"): boolean {
	return sport === "Run" ? RUN_TYPES.includes(a.type) : SWIM_TYPES.includes(a.type);
}

function daysAgo(dateStr: string, now: Date): number {
	return (now.getTime() - new Date(dateStr).getTime()) / (1000 * 86400);
}

/** A "hard session" is one with load > 0.7 * sport CTL or RPE >= 7. */
function isHardSession(a: ActivitySummary, sportCtl: number): boolean {
	if (a.perceived_exertion != null && a.perceived_exertion >= 7) return true;
	return a.icu_training_load > 0.7 * sportCtl;
}

/** Count days since the last hard session for this sport. */
function daysSinceHardSession(
	activities: ActivitySummary[],
	sport: "Run" | "Swim",
	sportCtl: number,
	now: Date,
): number {
	const sportActivities = activities
		.filter((a) => isSportActivity(a, sport))
		.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));

	for (const a of sportActivities) {
		if (isHardSession(a, sportCtl)) {
			return daysAgo(a.start_date_local, now);
		}
	}
	return 999; // No hard session found
}

/** Compute HR zone distribution from 14-day activities. Returns [z1z2_pct, z4z5_pct]. */
function hrZoneDistribution(activities: ActivitySummary[]): { lowPct: number; highPct: number } {
	let totalTime = 0;
	let lowTime = 0; // zones 1-2 (indices 0-1)
	let highTime = 0; // zones 4-5 (indices 3-4+)

	for (const a of activities) {
		if (!a.icu_hr_zone_times) continue;
		const zones = a.icu_hr_zone_times;
		const actTotal = zones.reduce((s, t) => s + t, 0);
		totalTime += actTotal;

		// intervals.icu may have 5, 6, or 7 zones. Z1-Z2 = indices 0-1, Z4+ = indices 3+
		lowTime += (zones[0] ?? 0) + (zones[1] ?? 0);
		for (let i = 3; i < zones.length; i++) {
			highTime += zones[i] ?? 0;
		}
	}

	if (totalTime === 0) return { lowPct: 0, highPct: 0 };
	return {
		lowPct: lowTime / totalTime,
		highPct: highTime / totalTime,
	};
}

/** Check if any session in last 7 days exceeded a duration threshold. */
function hasLongSession(activities: ActivitySummary[], thresholdSecs: number, now: Date): boolean {
	return activities.some(
		(a) => daysAgo(a.start_date_local, now) <= 7 && a.moving_time > thresholdSecs,
	);
}

/** Estimate sport-specific CTL from 14-day activity window. */
function estimateSportCtl(activities: ActivitySummary[], sport: "Run" | "Swim"): number {
	const sportActivities = activities.filter((a) => isSportActivity(a, sport));
	if (sportActivities.length === 0) return 0;

	// Use the most recent activity's icu_ctl as a proxy, or average load / 2
	const totalLoad = sportActivities.reduce((s, a) => s + a.icu_training_load, 0);
	return totalLoad / 2; // 14-day load / 2 as a rough chronic proxy
}

export function selectWorkoutCategory(
	readinessScore: number,
	activities: ActivitySummary[],
	sport: "Run" | "Swim",
	now: Date = new Date(),
): WorkoutCategory {
	// Base category from readiness
	let category: WorkoutCategory;
	const sportCtl = estimateSportCtl(activities, sport);
	const daysSinceHard = daysSinceHardSession(activities, sport, sportCtl, now);

	if (readinessScore <= 20) {
		return "rest";
	}
	if (readinessScore <= 35) {
		return "recovery";
	}
	if (readinessScore <= 50) {
		category = "base";
	} else if (readinessScore <= 65) {
		category = daysSinceHard >= 2 ? "tempo" : "base";
	} else if (readinessScore <= 80) {
		category = daysSinceHard >= 2 ? "intervals" : "tempo";
	} else {
		category = daysSinceHard >= 3 ? "intervals" : "tempo";
	}

	// Load focus balancing
	const { lowPct, highPct } = hrZoneDistribution(activities);
	if (lowPct > 0.7 && category === "base" && readinessScore > 50) {
		category = "tempo";
	} else if (highPct > 0.4 && category === "intervals") {
		category = "tempo";
	} else if (highPct > 0.4 && category === "tempo") {
		category = "base";
	}

	// Long session trigger: no >90min session in 7 days (60min for swim), readiness >= 45
	if (category === "base" && readinessScore >= 45) {
		const longThreshold = sport === "Swim" ? 3600 : 5400; // 60min swim, 90min run
		if (!hasLongSession(activities, longThreshold, now)) {
			category = "long";
		}
	}

	return category;
}
