/**
 * Determines whether today's workout should be Run or Swim.
 */

import { getActivityLoad } from "./power-source.js";
import type { ActivitySummary, PowerContext } from "./types.js";

const RUN_TYPES = ["Run", "VirtualRun", "TrailRun", "Treadmill"];
const SWIM_TYPES = ["Swim", "OpenWaterSwim", "VirtualSwim"];

export interface SportSelection {
	sport: "Run" | "Swim";
	reason: string;
}

function daysAgo(dateStr: string, now: Date): number {
	const d = new Date(dateStr);
	return (now.getTime() - d.getTime()) / (1000 * 86400);
}

function isRun(type: string): boolean {
	return RUN_TYPES.includes(type);
}

function isSwim(type: string): boolean {
	return SWIM_TYPES.includes(type);
}

function sportLoad(activity: ActivitySummary, powerContext: PowerContext): number {
	if (isRun(activity.type)) {
		return getActivityLoad(activity, powerContext);
	}
	// Swim activities always use hr_load (no power source)
	return activity.hr_load ?? activity.icu_training_load;
}

export function selectSport(
	activities: ActivitySummary[],
	readinessScore: number,
	now: Date = new Date(),
	powerContext?: PowerContext,
): SportSelection {
	// Default power context if not provided (backward compatibility)
	const ctx: PowerContext = powerContext ?? {
		source: "none",
		ftp: 0,
		rolling_ftp: null,
		correction_factor: 1.0,
		confidence: "low",
		warnings: [],
	};

	// Filter to run and swim activities only
	const runActivities = activities.filter((a) => isRun(a.type));
	const swimActivities = activities.filter((a) => isSwim(a.type));

	// Override: if last 3 consecutive activities are the same sport, suggest the other.
	// Non-sport activities (weights, yoga, etc.) break the streak — only check the 3
	// most recent activities overall, not just sport-filtered ones.
	const recent3 = [...activities]
		.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local))
		.slice(0, 3);
	const recent3Sports = recent3
		.filter((a) => isRun(a.type) || isSwim(a.type))
		.map((a) => (isRun(a.type) ? "Run" : "Swim"));

	if (
		recent3Sports.length === 3 &&
		recent3.length === 3 &&
		recent3.every((a) => isRun(a.type) || isSwim(a.type)) &&
		recent3Sports.every((s) => s === recent3Sports[0])
	) {
		const other = recent3Sports[0] === "Run" ? "Swim" : "Run";
		return {
			sport: other as "Run" | "Swim",
			reason: `Last 3 sessions were all ${recent3Sports[0]} — switching to ${other} to prevent monotony`,
		};
	}

	// Override: low readiness + only one sport in last 3 days → suggest the other
	if (readinessScore < 30) {
		const last3Days = activities.filter(
			(a) => daysAgo(a.start_date_local, now) <= 3 && (isRun(a.type) || isSwim(a.type)),
		);
		const sportsInLast3Days = new Set(last3Days.map((a) => (isRun(a.type) ? "Run" : "Swim")));
		if (sportsInLast3Days.size === 1) {
			const doneSport = [...sportsInLast3Days][0];
			const other = doneSport === "Run" ? "Swim" : "Run";
			return {
				sport: other as "Run" | "Swim",
				reason: `Low readiness (${readinessScore}) and only ${doneSport} in last 3 days — active recovery via ${other}`,
			};
		}
	}

	// Compute per-sport load deficit using power-aware load
	const last7Days = activities.filter((a) => daysAgo(a.start_date_local, now) <= 7);
	const last14Days = activities.filter((a) => daysAgo(a.start_date_local, now) <= 14);

	const runAcute = last7Days
		.filter((a) => isRun(a.type))
		.reduce((s, a) => s + sportLoad(a, ctx), 0);
	const swimAcute = last7Days
		.filter((a) => isSwim(a.type))
		.reduce((s, a) => s + sportLoad(a, ctx), 0);

	const runChronic =
		last14Days.filter((a) => isRun(a.type)).reduce((s, a) => s + sportLoad(a, ctx), 0) / 2;
	const swimChronic =
		last14Days.filter((a) => isSwim(a.type)).reduce((s, a) => s + sportLoad(a, ctx), 0) / 2;

	const runDeficit = runChronic - runAcute;
	const swimDeficit = swimChronic - swimAcute;

	// If both deficits are within 10% of each other, tie-break by session count
	const maxDeficit = Math.max(Math.abs(runDeficit), Math.abs(swimDeficit), 1);
	const deficitDiff = Math.abs(runDeficit - swimDeficit) / maxDeficit;

	if (deficitDiff < 0.1) {
		const runSessions7d = last7Days.filter((a) => isRun(a.type)).length;
		const swimSessions7d = last7Days.filter((a) => isSwim(a.type)).length;

		if (runSessions7d !== swimSessions7d) {
			const sport = runSessions7d < swimSessions7d ? "Run" : "Swim";
			return {
				sport,
				reason: `Load balance is even — fewer ${sport} sessions (${sport === "Run" ? runSessions7d : swimSessions7d}) in the last 7 days`,
			};
		}

		// Still tied — default to Run
		return {
			sport: "Run",
			reason:
				"Load balance and session count are even — defaulting to Run for higher overall stimulus",
		};
	}

	// Select sport with higher deficit (more undertrained)
	if (runDeficit > swimDeficit) {
		return {
			sport: "Run",
			reason: `Running has a higher load deficit (${runDeficit.toFixed(0)} vs ${swimDeficit.toFixed(0)}) — relatively undertrained`,
		};
	}

	return {
		sport: "Swim",
		reason: `Swimming has a higher load deficit (${swimDeficit.toFixed(0)} vs ${runDeficit.toFixed(0)}) — relatively undertrained`,
	};
}
