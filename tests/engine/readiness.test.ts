import { describe, expect, it } from "vitest";
import { computeReadiness } from "../../src/engine/readiness.js";
import type { ActivitySummary, NightlyHealth, WellnessRecord } from "../../src/engine/types.js";

function makeWellness(overrides: Partial<WellnessRecord> = {}): WellnessRecord {
	return {
		id: "2026-03-23",
		ctl: 50,
		atl: 40,
		restingHR: 52,
		hrv: 55,
		sleepSecs: 28800,
		sleepScore: 85,
		readiness: null,
		weight: 84,
		soreness: null,
		fatigue: null,
		stress: null,
		...overrides,
	};
}

function makeActivity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
	return {
		id: "a1",
		start_date_local: "2026-03-21T08:00:00",
		type: "Run",
		moving_time: 2400,
		distance: 8000,
		icu_training_load: 60,
		icu_atl: 40,
		icu_ctl: 50,
		average_heartrate: 145,
		max_heartrate: 170,
		icu_hr_zone_times: [300, 600, 900, 400, 200, 0, 0],
		perceived_exertion: null,
		power_load: null,
		hr_load: null,
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
		session_rpe: null,
		kg_lifted: null,
		...overrides,
	};
}

const NOW = new Date("2026-03-23T12:00:00");

describe("computeReadiness", () => {
	it("returns high readiness when well-rested", () => {
		// Good sleep, HRV above mean, positive TSB, 36h since last activity
		const wellness = [
			makeWellness({ id: "2026-03-17", hrv: 50 }),
			makeWellness({ id: "2026-03-18", hrv: 52 }),
			makeWellness({ id: "2026-03-19", hrv: 48 }),
			makeWellness({ id: "2026-03-20", hrv: 53 }),
			makeWellness({ id: "2026-03-21", hrv: 51 }),
			makeWellness({ id: "2026-03-22", hrv: 54 }),
			makeWellness({ id: "2026-03-23", ctl: 50, atl: 30, hrv: 60, sleepScore: 92 }),
		];
		const activities = [
			makeActivity({ start_date_local: "2026-03-21T20:00:00", moving_time: 3600 }),
		];

		const result = computeReadiness(wellness, activities, NOW);
		// Renormalisation across present components when subjective is null
		// (post-fix) lifts the well-rested ceiling slightly compared to the
		// old behaviour that defaulted subjective → NEUTRAL.
		expect(result.score).toBeGreaterThanOrEqual(75);
		expect(result.score).toBeLessThanOrEqual(100);
		expect(result.warnings).toHaveLength(0);
	});

	it("returns low readiness when fatigued", () => {
		// Poor sleep, HRV below mean, negative TSB, 8h since last activity
		const wellness = [
			makeWellness({ id: "2026-03-17", hrv: 55 }),
			makeWellness({ id: "2026-03-18", hrv: 58 }),
			makeWellness({ id: "2026-03-19", hrv: 54 }),
			makeWellness({ id: "2026-03-20", hrv: 56 }),
			makeWellness({ id: "2026-03-21", hrv: 57 }),
			makeWellness({ id: "2026-03-22", hrv: 53 }),
			makeWellness({
				id: "2026-03-23",
				ctl: 30,
				atl: 45,
				hrv: 42,
				sleepSecs: 14400,
				sleepScore: null,
				fatigue: 8,
			}),
		];
		const activities = [
			makeActivity({ start_date_local: "2026-03-23T04:00:00", moving_time: 3600 }),
		];

		const result = computeReadiness(wellness, activities, NOW);
		expect(result.score).toBeGreaterThanOrEqual(10);
		expect(result.score).toBeLessThanOrEqual(30);
		// Should emit at least HRV and/or sleep warnings
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("handles missing data gracefully with warning", () => {
		// Only TSB and sleep available
		const wellness = [
			makeWellness({
				id: "2026-03-23",
				ctl: 45,
				atl: 35,
				hrv: null,
				sleepScore: 80,
				fatigue: null,
				soreness: null,
				readiness: null,
			}),
		];

		const result = computeReadiness(wellness, [], NOW);
		expect(result.score).toBeGreaterThanOrEqual(40);
		expect(result.score).toBeLessThanOrEqual(70);
		expect(result.warnings).toContain("Limited wellness data — suggestion may be less accurate");
	});

	it("handles no activities in 14 days", () => {
		const wellness = [
			makeWellness({ id: "2026-03-23", ctl: 40, atl: 10, hrv: 55, sleepScore: 85 }),
		];

		// No activities at all — recency defaults to neutral
		const result = computeReadiness(wellness, [], NOW);
		// TSB is strongly positive (40-10=+30), sleep good, but only 1 HRV value
		expect(result.score).toBeGreaterThanOrEqual(55);
	});

	it("handles empty wellness array", () => {
		const result = computeReadiness([], [], NOW);
		// All components default to neutral 50
		expect(result.score).toBe(50);
		expect(result.warnings).toContain("Limited wellness data — suggestion may be less accurate");
	});

	it("emits HRV warning when clearly below baseline", () => {
		const wellness = [
			makeWellness({ id: "2026-03-17", hrv: 65 }),
			makeWellness({ id: "2026-03-18", hrv: 68 }),
			makeWellness({ id: "2026-03-19", hrv: 64 }),
			makeWellness({ id: "2026-03-20", hrv: 66 }),
			makeWellness({ id: "2026-03-21", hrv: 66 }),
			makeWellness({ id: "2026-03-22", hrv: 70 }),
			makeWellness({
				id: "2026-03-23",
				ctl: 21,
				atl: 22,
				hrv: 50,
				sleepSecs: 28800,
				sleepScore: 85,
			}),
		];
		const activities = [
			makeActivity({ start_date_local: "2026-03-22T07:00:00", moving_time: 3600 }),
		];

		const result = computeReadiness(wellness, activities, NOW);
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringContaining("HRV below 7-day baseline")]),
		);
	});

	it("emits sleep warning when sleepScore is low", () => {
		// sleepSecs null so the loop falls through to the sleepScore check
		const wellness = [
			makeWellness({
				id: "2026-03-23",
				ctl: 50,
				atl: 40,
				hrv: 55,
				sleepSecs: null,
				sleepScore: 45,
			}),
		];
		const activities = [
			makeActivity({ start_date_local: "2026-03-22T07:00:00", moving_time: 3600 }),
		];

		const result = computeReadiness(wellness, activities, NOW);
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringContaining("Sleep score low")]),
		);
	});

	it("emits sleep duration warning when sleepSecs is below 7 hours", () => {
		const wellness = [
			makeWellness({
				id: "2026-03-23",
				ctl: 50,
				atl: 40,
				hrv: 55,
				sleepSecs: 18000,
				sleepScore: null,
			}),
		];
		const activities = [
			makeActivity({ start_date_local: "2026-03-22T07:00:00", moving_time: 3600 }),
		];

		const result = computeReadiness(wellness, activities, NOW);
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringContaining("Sleep below 7 hours")]),
		);
	});

	it("emits TSB warning when deeply negative", () => {
		const wellness = [
			makeWellness({
				id: "2026-03-23",
				ctl: 30,
				atl: 50,
				hrv: 55,
				sleepScore: 85,
			}),
		];

		const result = computeReadiness(wellness, [], NOW);
		expect(result.warnings).toContain(
			"Training stress balance is negative — fatigue exceeds fitness",
		);
	});

	// ── TSB rebuild flag ──────────────────────────────────────────────
	// Low CTL + intact FTP indicates an athlete returning from a layoff with
	// underlying fitness preserved. The TSB component shouldn't read them as
	// suppressed just because CTL hasn't rebuilt yet.

	it("lifts TSB component to floor when athlete is rebuilding (low CTL, high FTP)", () => {
		const wellness = [
			makeWellness({ id: "2026-03-17", hrv: 55 }),
			makeWellness({ id: "2026-03-18", hrv: 58 }),
			makeWellness({ id: "2026-03-19", hrv: 54 }),
			makeWellness({ id: "2026-03-20", hrv: 56 }),
			makeWellness({ id: "2026-03-21", hrv: 57 }),
			makeWellness({ id: "2026-03-22", hrv: 55 }),
			// CTL 20, ATL 24 → TSB -4 (raw component would be ~40)
			// FTP 286 / CTL 20 = 14.3 W per CTL-point > 12 threshold → rebuild
			makeWellness({ id: "2026-03-23", ctl: 20, atl: 24, hrv: 58, sleepScore: 80 }),
		];
		const activities = [
			makeActivity({ start_date_local: "2026-03-22T07:00:00", moving_time: 3600 }),
		];

		const baseline = computeReadiness(wellness, activities, NOW);
		const rebuilt = computeReadiness(wellness, activities, NOW, { ftp: 286 });

		expect(baseline.rebuild).toBe(false);
		expect(rebuilt.rebuild).toBe(true);
		// Rebuild lifts TSB component from ~40 to floor 60 → overall readiness higher
		expect(rebuilt.score).toBeGreaterThan(baseline.score);
		expect(rebuilt.components.tsb).toBeGreaterThanOrEqual(60);
	});

	it("does NOT lift TSB when CTL is high enough to be trusted", () => {
		const wellness = [
			makeWellness({ id: "2026-03-22", ctl: 60, atl: 64, hrv: 55, sleepScore: 80 }),
			// TSB -4 same raw as rebuild test, but CTL 60 ≥ ceiling → no rebuild
			makeWellness({ id: "2026-03-23", ctl: 60, atl: 64, hrv: 55, sleepScore: 80 }),
		];

		const result = computeReadiness(wellness, [], NOW, { ftp: 286 });
		expect(result.rebuild).toBe(false);
	});

	it("does NOT lift TSB when FTP/CTL ratio is below threshold (true beginner)", () => {
		const wellness = [
			// CTL 20, ATL 24 → TSB -4. But FTP 200 / CTL 20 = 10 W per point < 12 → no rebuild
			makeWellness({ id: "2026-03-23", ctl: 20, atl: 24, hrv: 55, sleepScore: 80 }),
		];

		const result = computeReadiness(wellness, [], NOW, { ftp: 200 });
		expect(result.rebuild).toBe(false);
	});

	// ── Sport-specific recency ────────────────────────────────────────
	// A swim or ride shouldn't suppress a Run prescription's readiness, and
	// vice versa. Without a sport filter, all activities count (original
	// behaviour preserved for backward compat).

	it("ignores cross-sport activities for recency when sport filter is on", () => {
		const wellness = [
			makeWellness({ id: "2026-03-23", ctl: 30, atl: 28, hrv: 55, sleepScore: 85 }),
		];
		// A morning ride 3h before NOW (should drag recency to near-zero unfiltered)
		const activities = [
			makeActivity({
				id: "ride1",
				type: "Ride",
				start_date_local: "2026-03-23T09:00:00",
				moving_time: 900,
			}),
		];

		const unfiltered = computeReadiness(wellness, activities, NOW);
		const runFiltered = computeReadiness(wellness, activities, NOW, { sport: "Run" });

		// Unfiltered: recency hit from the ride
		expect(unfiltered.components.recency).toBeLessThan(50);
		// Run-filtered: no qualifying Run activity → fully rested for Run (100)
		expect(runFiltered.components.recency).toBe(100);
		// Filtered readiness is materially higher
		expect(runFiltered.score).toBeGreaterThan(unfiltered.score);
	});

	it("still counts same-sport activity when sport filter is on", () => {
		const wellness = [
			makeWellness({ id: "2026-03-23", ctl: 30, atl: 28, hrv: 55, sleepScore: 85 }),
		];
		const activities = [
			makeActivity({
				type: "Run",
				start_date_local: "2026-03-23T09:00:00",
				moving_time: 1800,
			}),
		];

		const result = computeReadiness(wellness, activities, NOW, { sport: "Run" });
		// 3h after a Run → recency component low
		expect(result.components.recency).toBeLessThan(50);
	});

	// ── Subjective renormalisation ────────────────────────────────────
	// When subjective is null but ≥ 3 components are present, the score
	// should reflect what we know rather than being pulled toward 50 by
	// the missing-value default.

	it("renormalises across present components when subjective is missing", () => {
		const wellness = [
			makeWellness({ id: "2026-03-17", hrv: 55 }),
			makeWellness({ id: "2026-03-18", hrv: 56 }),
			makeWellness({ id: "2026-03-19", hrv: 54 }),
			// All present components are at the high end; subjective is null
			makeWellness({
				id: "2026-03-23",
				ctl: 50,
				atl: 30,
				hrv: 60,
				sleepScore: 95,
				fatigue: null,
				soreness: null,
				readiness: null,
			}),
		];
		const activities = [
			makeActivity({ start_date_local: "2026-03-21T20:00:00", moving_time: 3600 }),
		];

		const result = computeReadiness(wellness, activities, NOW);
		// Without renormalisation, subjective→NEUTRAL would cap score around 90.
		// With renormalisation, present-components average is much higher.
		expect(result.score).toBeGreaterThan(90);
	});
});

describe("computeReadiness — Promus WHOOP health source", () => {
	const restedActivities = [
		makeActivity({ start_date_local: "2026-03-21T20:00:00", moving_time: 3600 }),
	];

	function healthSeries(): NightlyHealth[] {
		// 7 nights, all ~7h45m sleep, RMSSD steady around 60, today slightly up.
		return [
			{ date: "2026-03-17", sleepSecs: 27900, hrvRmssd: 58 },
			{ date: "2026-03-18", sleepSecs: 27900, hrvRmssd: 60 },
			{ date: "2026-03-19", sleepSecs: 27900, hrvRmssd: 59 },
			{ date: "2026-03-20", sleepSecs: 27900, hrvRmssd: 61 },
			{ date: "2026-03-21", sleepSecs: 27900, hrvRmssd: 60 },
			{ date: "2026-03-22", sleepSecs: 27900, hrvRmssd: 62 },
			{ date: "2026-03-23", sleepSecs: 27900, hrvRmssd: 66 },
		];
	}

	it("derives Sleep and HRV from WHOOP when health is supplied", () => {
		const wellness = [makeWellness({ id: "2026-03-23", ctl: 50, atl: 30 })];
		const result = computeReadiness(wellness, restedActivities, NOW, { health: healthSeries() });
		// Good sleep (7h45m) and HRV above 7-day mean → both components high.
		expect(result.components.sleep).toBeGreaterThan(80);
		expect(result.components.hrv).toBeGreaterThan(75);
	});

	it("REGRESSION: a corrupt intervals.icu sleepSecs does not influence readiness when WHOOP health is present", () => {
		// The 2026-06-03 bug: intervals.icu carried an 18-minute (1080s) sleep
		// that suppressed the prescription. With the WHOOP source, that value
		// must be ignored entirely.
		const poisoned = [
			makeWellness({ id: "2026-03-23", ctl: 50, atl: 30, sleepSecs: 1080, sleepScore: null }),
		];
		const withHealth = computeReadiness(poisoned, restedActivities, NOW, {
			health: healthSeries(),
		});
		const cleanWellness = [
			makeWellness({ id: "2026-03-23", ctl: 50, atl: 30, sleepSecs: 27900, sleepScore: null }),
		];
		const baseline = computeReadiness(cleanWellness, restedActivities, NOW, {
			health: healthSeries(),
		});
		// Identical: the poisoned intervals value never reaches the Sleep component.
		expect(withHealth.components.sleep).toBe(baseline.components.sleep);
		expect(withHealth.components.sleep).toBeGreaterThan(80);
		// And no "Sleep below 7 hours (0h18m)" warning is emitted.
		expect(withHealth.warnings.some((w) => w.includes("0h18m"))).toBe(false);
	});

	it("emits a duration-based sleep warning from WHOOP on a genuinely short night", () => {
		const wellness = [makeWellness({ id: "2026-03-23", ctl: 50, atl: 30 })];
		const shortNight = healthSeries();
		shortNight[shortNight.length - 1] = { date: "2026-03-23", sleepSecs: 16200, hrvRmssd: 66 }; // 4h30m
		const result = computeReadiness(wellness, restedActivities, NOW, { health: shortNight });
		expect(result.warnings.some((w) => w.includes("Sleep below 7 hours (4h30m)"))).toBe(true);
	});

	it("falls back to intervals.icu wellness when health is empty", () => {
		const wellness = [
			makeWellness({ id: "2026-03-23", ctl: 50, atl: 30, sleepScore: 92, hrv: 60 }),
		];
		const result = computeReadiness(wellness, restedActivities, NOW, { health: [] });
		expect(result.components.sleep).toBe(92);
	});
});
