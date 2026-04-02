/**
 * Maps readiness score + training context to a WorkoutCategory.
 */

import type { CrossTrainingStrain } from "./cross-training-strain.js";
import { localDateStr } from "./date-utils.js";
import { getActivityLoad } from "./power-source.js";
import type { ActivitySummary, PowerContext, WorkoutCategory } from "./types.js";
import type { VigilAlert } from "./vigil/types.js";

const RUN_TYPES = ["Run", "VirtualRun", "TrailRun", "Treadmill"];
const SWIM_TYPES = ["Swim", "OpenWaterSwim", "VirtualSwim"];

function isSportActivity(a: ActivitySummary, sport: "Run" | "Swim"): boolean {
	return sport === "Run" ? RUN_TYPES.includes(a.type) : SWIM_TYPES.includes(a.type);
}

function daysAgo(dateStr: string, now: Date): number {
	return (now.getTime() - new Date(dateStr).getTime()) / (1000 * 86400);
}

/** A "hard session" is one detected by any of: RPE, intensity ratio, HR zone
 *  distribution, or absolute load. Multiple signals provide robustness when
 *  individual metrics are missing (e.g. RPE not logged, power ecosystem mismatch). */
function isHardSession(a: ActivitySummary, sportCtl: number, powerContext: PowerContext): boolean {
	// Subjective: athlete rated it hard
	if (a.perceived_exertion != null && a.perceived_exertion >= 7) return true;

	// Intensity ratio: normalised power > 85% of FTP (hard tempo and above)
	if (a.icu_intensity != null && a.icu_intensity > 85) return true;

	// HR zone distribution: >25% of session in Z4+ is physiologically hard
	if (a.icu_hr_zone_times) {
		const total = a.icu_hr_zone_times.reduce((s, t) => s + t, 0);
		if (total > 0) {
			let highZoneTime = 0;
			for (let i = 3; i < a.icu_hr_zone_times.length; i++) {
				highZoneTime += a.icu_hr_zone_times[i] ?? 0;
			}
			if (highZoneTime / total > 0.25) return true;
		}
	}

	// Load-based: original fallback — catches long endurance sessions
	const load = getActivityLoad(a, powerContext);
	return load > 0.7 * sportCtl;
}

/** Count days since the last hard session for this sport. */
function daysSinceHardSession(
	activities: ActivitySummary[],
	sport: "Run" | "Swim",
	sportCtl: number,
	now: Date,
	powerContext: PowerContext,
): number {
	const sportActivities = activities
		.filter((a) => isSportActivity(a, sport))
		.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));

	for (const a of sportActivities) {
		if (isHardSession(a, sportCtl, powerContext)) {
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

/** Count days since a moderate or hard cross-training session. */
function daysSinceHardCrossTraining(
	crossTrainingStrains: Map<string, CrossTrainingStrain>,
	now: Date,
	activities: ActivitySummary[],
): number {
	let minDays = 999;
	for (const [activityId, strain] of crossTrainingStrains) {
		if (strain.level !== "moderate" && strain.level !== "hard") continue;
		const activity = activities.find((a) => a.id === activityId);
		if (!activity) continue;
		const days = daysAgo(activity.start_date_local, now);
		if (days < minDays) minDays = days;
	}
	return minDays;
}

/** Get same-day cross-training cap. Returns null if no cap applies. */
function sameDayCrossTrainingCap(
	crossTrainingStrains: Map<string, CrossTrainingStrain>,
	activities: ActivitySummary[],
	now: Date,
	tz?: string,
): WorkoutCategory | null {
	const today = localDateStr(now, tz);
	let worstLevel: "light" | "moderate" | "hard" | "unknown" = "light";

	for (const [activityId, strain] of crossTrainingStrains) {
		const activity = activities.find((a) => a.id === activityId);
		if (!activity) continue;
		if (activity.start_date_local.slice(0, 10) !== today) continue;
		// Track worst strain seen today
		if (strain.level === "hard") worstLevel = "hard";
		else if (strain.level === "moderate" && worstLevel !== "hard") worstLevel = "moderate";
		// unknown is handled upstream in suggest.ts (prescription gating)
	}

	if (worstLevel === "hard") return "recovery";
	if (worstLevel === "moderate") return "base";
	return null; // light or no same-day activity → no cap
}

/** Estimate sport-specific CTL from 14-day activity window. */
function estimateSportCtl(
	activities: ActivitySummary[],
	sport: "Run" | "Swim",
	powerContext: PowerContext,
): number {
	const sportActivities = activities.filter((a) => isSportActivity(a, sport));
	if (sportActivities.length === 0) return 0;

	const totalLoad = sportActivities.reduce((s, a) => s + getActivityLoad(a, powerContext), 0);
	return totalLoad / 2; // 14-day load / 2 as a rough chronic proxy
}

export function selectWorkoutCategory(
	readinessScore: number,
	activities: ActivitySummary[],
	sport: "Run" | "Swim",
	now: Date = new Date(),
	powerContext?: PowerContext,
	vigilAlert?: VigilAlert,
	crossTrainingStrains?: Map<string, CrossTrainingStrain>,
	tz?: string,
): WorkoutCategory {
	// Default power context if not provided (backward compatibility)
	const ctx: PowerContext = powerContext ?? {
		source: "none",
		ftp: 0,
		rolling_ftp: null,
		correction_factor: 1.0,
		confidence: "low",
		warnings: [],
	};

	// Base category from readiness
	let category: WorkoutCategory;
	const sportCtl = estimateSportCtl(activities, sport, ctx);
	let daysSinceHard = daysSinceHardSession(activities, sport, sportCtl, now, ctx);

	// Cross-training hard-session guard: moderate/hard weights count as a hard session (#20)
	if (crossTrainingStrains && crossTrainingStrains.size > 0) {
		const daysSinceHardCT = daysSinceHardCrossTraining(crossTrainingStrains, now, activities);
		daysSinceHard = Math.min(daysSinceHard, daysSinceHardCT);
	}

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
		category = daysSinceHard >= 2 ? "intervals" : "base";
	} else {
		category = daysSinceHard >= 3 ? "intervals" : "tempo";
	}

	// Track whether category was downshifted due to a recent hard session.
	// Zone rebalancing must not override this protection.
	const hardSessionGuard = readinessScore > 50 && daysSinceHard < 2;

	// Load focus balancing — hard-session guard blocks upward shifts only.
	// Downward shifts (tempo→base when too much high-zone work) are always allowed.
	const { lowPct, highPct } = hrZoneDistribution(activities);
	if (lowPct > 0.7 && category === "base" && readinessScore > 50 && !hardSessionGuard) {
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

	// Same-day cross-training cap (#21): limit category after weights today
	if (crossTrainingStrains && crossTrainingStrains.size > 0) {
		const cap = sameDayCrossTrainingCap(crossTrainingStrains, activities, now, tz);
		if (cap) {
			const capOrder: WorkoutCategory[] = [
				"rest",
				"recovery",
				"base",
				"tempo",
				"intervals",
				"long",
			];
			const catIdx = capOrder.indexOf(category);
			const capIdx = capOrder.indexOf(cap);
			if (catIdx > capIdx) {
				category = cap;
			}
		}
	}

	// Vigil protective downshift — biomechanical deviation alert.
	// Applied last so it overrides all upstream category selection.
	// vigilDownshift flag prevents any downstream rebalancing (none exists yet,
	// but protects against future additions).
	if (vigilAlert && vigilAlert.severity >= 2) {
		const downshiftMap: Record<string, WorkoutCategory> = {
			intervals: "tempo",
			tempo: "base",
			long: "base",
			base: "base",
			recovery: "recovery",
			rest: "rest",
		};
		category = downshiftMap[category] ?? "base";

		if (vigilAlert.severity === 3) {
			// Force base regardless of what upstream selected
			if (category !== "rest" && category !== "recovery") {
				category = "base";
			}
		}
	}

	return category;
}
