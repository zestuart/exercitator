import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../../src/engine/types.js";
import { selectWorkoutCategory } from "../../src/engine/workout-selector.js";

const NOW = new Date("2026-03-23T12:00:00");

function makeActivity(
	type: string,
	daysAgo: number,
	load = 50,
	rpe: number | null = null,
	hrZones: number[] | null = null,
): ActivitySummary {
	const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
	return {
		id: `a-${daysAgo}`,
		start_date_local: d.toISOString().slice(0, 19),
		type,
		moving_time: 2400,
		distance: 8000,
		icu_training_load: load,
		icu_atl: 40,
		icu_ctl: 50,
		average_heartrate: 145,
		max_heartrate: 170,
		icu_hr_zone_times: hrZones ?? [300, 600, 900, 400, 200, 0, 0],
		perceived_exertion: rpe,
		power_load: load,
		hr_load: load,
		icu_weighted_avg_watts: null,
		icu_average_watts: null,
		icu_ftp: null,
		icu_rolling_ftp: null,
		power_field: null,
		stream_types: null,
		device_name: null,
		total_elevation_gain: null,
	};
}

describe("selectWorkoutCategory", () => {
	it("returns rest for very low readiness", () => {
		expect(selectWorkoutCategory(15, [], "Run", NOW)).toBe("rest");
	});

	it("returns recovery for low readiness", () => {
		expect(selectWorkoutCategory(25, [], "Run", NOW)).toBe("recovery");
	});

	it("returns base for moderate readiness", () => {
		// With activities to prevent long-session trigger
		const activities = [makeActivity("Run", 2, 50, null, null)];
		// Need a long session to prevent 'long' override
		activities.push({
			...makeActivity("Run", 5, 60),
			moving_time: 6000, // 100min — above 90min threshold
		});
		expect(selectWorkoutCategory(45, activities, "Run", NOW)).toBe("base");
	});

	it("returns tempo when readiness 60 and no hard session in 2+ days", () => {
		// Only easy sessions recently
		const activities = [
			makeActivity("Run", 3, 20), // Easy session 3 days ago
			makeActivity("Run", 5, 20),
		];
		expect(selectWorkoutCategory(60, activities, "Run", NOW)).toBe("tempo");
	});

	it("returns base when readiness 60 but hard session yesterday", () => {
		// Hard session yesterday (high RPE), plus a long session this week to prevent 'long' trigger
		const activities = [
			makeActivity("Run", 1, 80, 8),
			{ ...makeActivity("Run", 4, 60), moving_time: 6000 }, // 100min long run
		];
		expect(selectWorkoutCategory(60, activities, "Run", NOW)).toBe("base");
	});

	it("returns intervals when readiness 75 and no hard session in 2+ days", () => {
		const activities = [makeActivity("Run", 4, 20)];
		expect(selectWorkoutCategory(75, activities, "Run", NOW)).toBe("intervals");
	});

	it("returns tempo when readiness 90 but hard session yesterday", () => {
		const activities = [makeActivity("Run", 1, 80, 8)];
		expect(selectWorkoutCategory(90, activities, "Run", NOW)).toBe("tempo");
	});

	it("bumps base to tempo when zone distribution is too low-aerobic", () => {
		const lowZones = [2000, 1800, 100, 50, 50, 0, 0];
		const activitiesWithHard = [
			makeActivity("Run", 1, 80, 8, lowZones),
			makeActivity("Run", 3, 40, null, lowZones),
			{ ...makeActivity("Run", 5, 60, null, lowZones), moving_time: 6000 },
		];
		// Readiness 55 + hard session yesterday → base, but >70% low zones + readiness > 50 → bumped to tempo
		expect(selectWorkoutCategory(55, activitiesWithHard, "Run", NOW)).toBe("tempo");
	});

	it("triggers long session when no >90min session in 7 days", () => {
		// All short sessions, moderate readiness
		const activities = [
			makeActivity("Run", 2, 40),
			makeActivity("Run", 4, 40),
			// Hard session yesterday to push category to base (not tempo)
			makeActivity("Run", 1, 80, 8),
		];
		// Readiness 48 → base, no long session → upgrades to long
		expect(selectWorkoutCategory(48, activities, "Run", NOW)).toBe("long");
	});
});
