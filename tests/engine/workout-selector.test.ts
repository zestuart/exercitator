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
	overrides: Partial<ActivitySummary> = {},
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
		icu_intensity: null,
		external_id: null,
		source: null,
		...overrides,
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

	it("does not bump base to tempo when hard-session guard is active", () => {
		const lowZones = [2000, 1800, 100, 50, 50, 0, 0];
		const activitiesWithHard = [
			makeActivity("Run", 1, 80, 8, lowZones), // Hard session yesterday
			makeActivity("Run", 3, 40, null, lowZones),
			{ ...makeActivity("Run", 5, 60, null, lowZones), moving_time: 6000 },
		];
		// Readiness 55 + hard session yesterday → base (guarded), >70% low zones should NOT override
		expect(selectWorkoutCategory(55, activitiesWithHard, "Run", NOW)).toBe("base");
	});

	it("bumps base to tempo when >70% Z1-Z2 and no recent hard session", () => {
		const lowZones = [2000, 1800, 100, 50, 50, 0, 0];
		const activities = [
			makeActivity("Run", 3, 40, null, lowZones), // Hard 3 days ago
			makeActivity("Run", 5, 40, null, lowZones),
			{ ...makeActivity("Run", 7, 60, null, lowZones), moving_time: 6000 },
		];
		// Readiness 55 + daysSinceHard >= 2 → tempo (not base, so the lowPct check doesn't apply)
		expect(selectWorkoutCategory(55, activities, "Run", NOW)).toBe("tempo");
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

	it("detects hard session via icu_intensity > 85 (no RPE)", () => {
		// High-intensity session: icu_intensity 90, no RPE, moderate load.
		// Use null HR zones to isolate the intensity signal (avoids highPct rebalancing).
		const activities = [
			makeActivity("Run", 1, 42, null, null, { icu_intensity: 90.07 }),
			{ ...makeActivity("Run", 4, 60), moving_time: 6000 }, // prevent long trigger
		];
		// Readiness 75 + hard session yesterday (via intensity) → tempo, not intervals
		expect(selectWorkoutCategory(75, activities, "Run", NOW)).toBe("tempo");
	});

	it("detects hard session via HR zone distribution (>25% in Z4+)", () => {
		// High Z4+ time: 502+264+171+500 = 1437 out of ~2220 total = 64.7%
		const highZones = [120, 180, 483, 502, 264, 171, 500];
		// Include enough easy activities to keep overall highPct < 40% (avoids rebalancing)
		const easyZones = [1500, 600, 200, 50, 50, 0, 0];
		const activities = [
			makeActivity("Run", 1, 42, null, highZones),
			makeActivity("Run", 3, 40, null, easyZones),
			{ ...makeActivity("Run", 5, 60, null, easyZones), moving_time: 6000 },
		];
		// Readiness 75 + hard session yesterday (via HR zones) → tempo
		expect(selectWorkoutCategory(75, activities, "Run", NOW)).toBe("tempo");
	});

	it("does not flag easy session as hard via intensity or HR zones", () => {
		// Low intensity, low HR zones — should NOT be detected as hard.
		// Include multiple activities so sportCtl is high enough that load 30 doesn't
		// trigger the load-based check (sportCtl = (30+50+50+50)/2 = 90, threshold = 63).
		const easyZones = [1500, 600, 200, 50, 50, 0, 0];
		const activities = [
			makeActivity("Run", 1, 30, null, easyZones, { icu_intensity: 65.0 }),
			makeActivity("Run", 3, 50),
			makeActivity("Run", 5, 50),
			makeActivity("Run", 7, 50),
		];
		// Readiness 75 + no hard session → intervals
		expect(selectWorkoutCategory(75, activities, "Run", NOW)).toBe("intervals");
	});

	it("zone rebalancing does not override hard-session guard (issue #11 scenario)", () => {
		// Readiness 64, VO2max yesterday (intensity 90), 14d dominated by Z1-Z2
		const lowZones = [2000, 1800, 100, 50, 50, 0, 0];
		const activities = [
			makeActivity("Run", 1, 42, null, null, { icu_intensity: 90.07 }), // VO2max yesterday
			makeActivity("Run", 4, 40, null, lowZones),
			{ ...makeActivity("Run", 6, 50, null, lowZones), moving_time: 6000 }, // long run within 7d
		];
		// Hard session yesterday → base (guarded). >70% Z1-Z2 should NOT bump to tempo.
		expect(selectWorkoutCategory(64, activities, "Run", NOW)).toBe("base");
	});

	it("prevents back-to-back intense sessions (2026-03-27/28 scenario)", () => {
		// Day 1: VO2max intervals — high intensity, no RPE logged.
		// Use null HR zones on the hard session to isolate the intensity signal.
		const vo2maxSession = makeActivity("Run", 1, 42, null, null, {
			icu_intensity: 90.07,
		});
		// Older easy runs with low HR zones
		const easyZones = [1200, 600, 300, 100, 0, 0, 0];
		const easyRun = makeActivity("Run", 4, 30, null, easyZones, { icu_intensity: 65.0 });
		const longRun = { ...makeActivity("Run", 6, 60, null, easyZones), moving_time: 6000 };

		const activities = [vo2maxSession, easyRun, longRun];

		// Readiness 71 (66–80 band): should be tempo (hard yesterday), NOT intervals
		expect(selectWorkoutCategory(71, activities, "Run", NOW)).toBe("tempo");
	});

	it("uses enriched activity icu_intensity when original is deleted", () => {
		// Post-enrichment state: only the Stryd FIT activity exists with full metrics
		const enrichedStrydRun = makeActivity(
			"Run",
			1,
			49,
			null,
			[1096, 212, 158, 170, 130, 264, 171],
			{ icu_intensity: 90.07 },
		);
		const olderEasyRun = makeActivity("Run", 4, 30);
		const longRun = { ...makeActivity("Run", 6, 50), moving_time: 6000 };

		// Readiness 64 + hard session yesterday (via intensity) → base, not tempo
		expect(selectWorkoutCategory(64, [enrichedStrydRun, olderEasyRun, longRun], "Run", NOW)).toBe(
			"base",
		);
	});
});
