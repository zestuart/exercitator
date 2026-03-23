import { describe, expect, it } from "vitest";
import { computeReadiness } from "../../src/engine/readiness.js";
import type { ActivitySummary, WellnessRecord } from "../../src/engine/types.js";

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
		expect(result.score).toBeGreaterThanOrEqual(75);
		expect(result.score).toBeLessThanOrEqual(95);
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
});
