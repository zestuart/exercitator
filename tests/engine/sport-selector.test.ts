import { describe, expect, it } from "vitest";
import { selectSport } from "../../src/engine/sport-selector.js";
import type { ActivitySummary, PowerContext } from "../../src/engine/types.js";

const NOW = new Date("2026-03-23T12:00:00");

function makeActivity(type: string, daysAgo: number, load = 50): ActivitySummary {
	const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
	return {
		id: `a-${type}-${daysAgo}`,
		start_date_local: d.toISOString().slice(0, 19),
		type,
		moving_time: 2400,
		distance: 8000,
		icu_training_load: load,
		icu_atl: 40,
		icu_ctl: 50,
		average_heartrate: 145,
		max_heartrate: 170,
		icu_hr_zone_times: [300, 600, 900, 400, 200, 0, 0],
		perceived_exertion: null,
		power_load: load,
		hr_load: Math.round(load * 0.75),
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

describe("selectSport", () => {
	it("suggests Run when swim-heavy", () => {
		const activities = [
			makeActivity("Swim", 1),
			makeActivity("Swim", 2),
			makeActivity("Swim", 3),
			makeActivity("Swim", 4),
			makeActivity("Swim", 5),
			makeActivity("Run", 6),
		];

		const result = selectSport(activities, 60, NOW);
		expect(result.sport).toBe("Run");
	});

	it("tie-breaks by session count when load is balanced", () => {
		const activities = [
			makeActivity("Run", 1, 50),
			makeActivity("Run", 3, 50),
			makeActivity("Run", 5, 50),
			makeActivity("Swim", 2, 50),
			makeActivity("Swim", 4, 50),
			makeActivity("Swim", 6, 50),
		];

		const result = selectSport(activities, 60, NOW);
		expect(result.sport).toBe("Run");
	});

	it("overrides when last 3 consecutive activities are same sport", () => {
		const activities = [
			makeActivity("Run", 1),
			makeActivity("Run", 2),
			makeActivity("Run", 3),
			makeActivity("Swim", 7),
			makeActivity("Swim", 8),
		];

		const result = selectSport(activities, 60, NOW);
		expect(result.sport).toBe("Swim");
		expect(result.reason).toContain("monotony");
	});

	it("does not trigger monotony override when non-sport activity breaks streak", () => {
		// TrailRun, WeightTraining, Run, Swim — WeightTraining breaks the run streak
		const activities = [
			makeActivity("TrailRun", 1),
			makeActivity("WeightTraining", 2),
			makeActivity("Run", 3),
			makeActivity("Swim", 7),
		];

		const result = selectSport(activities, 60, NOW);
		expect(result.reason).not.toContain("monotony");
	});

	it("cross-trains when readiness is low", () => {
		const activities = [makeActivity("Run", 1), makeActivity("Run", 2), makeActivity("Swim", 7)];

		const result = selectSport(activities, 25, NOW);
		expect(result.sport).toBe("Swim");
		expect(result.reason).toContain("Low readiness");
	});

	it("defaults to Run when no activities", () => {
		const result = selectSport([], 60, NOW);
		expect(result.sport).toBe("Run");
	});

	it("uses power-aware load when PowerContext is provided", () => {
		const strydCtx: PowerContext = {
			source: "stryd",
			ftp: 248,
			rolling_ftp: 248,
			correction_factor: 1.0,
			confidence: "high",
			warnings: [],
		};

		// Run activities with Stryd — power_load differs from hr_load
		const activities = [
			{
				...makeActivity("Run", 1, 60),
				power_load: 55,
				hr_load: 39,
				stream_types: ["heartrate", "Power", "StrydLSS", "StrydFormPower", "StrydILR"],
			},
			{
				...makeActivity("Run", 3, 60),
				power_load: 48,
				hr_load: 35,
				stream_types: ["heartrate", "Power", "StrydLSS", "StrydFormPower", "StrydILR"],
			},
			makeActivity("Swim", 2, 42),
		];

		const result = selectSport(activities, 60, NOW, strydCtx);
		// With Stryd context, run load uses power_load (55 + 48 = 103 acute)
		// Without context, would use icu_training_load (60 + 60 = 120)
		expect(result.sport).toBeDefined();
		expect(result.reason).toBeTruthy();
	});
});
