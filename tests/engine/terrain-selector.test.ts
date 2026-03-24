import { describe, expect, it } from "vitest";
import { selectTerrain } from "../../src/engine/terrain-selector.js";
import type { ActivitySummary } from "../../src/engine/types.js";

const NOW = new Date("2026-03-23T12:00:00");

function makeRunActivity(
	daysAgo: number,
	type = "Run",
	elevationGain: number | null = 25,
): ActivitySummary {
	const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
	return {
		id: `a-${daysAgo}`,
		start_date_local: d.toISOString().slice(0, 19),
		type,
		moving_time: 2400,
		distance: 8000,
		icu_training_load: 50,
		icu_atl: 40,
		icu_ctl: 50,
		average_heartrate: 145,
		max_heartrate: 170,
		icu_hr_zone_times: [300, 600, 900, 400, 200, 0, 0],
		perceived_exertion: null,
		power_load: 50,
		hr_load: 40,
		icu_weighted_avg_watts: null,
		icu_average_watts: null,
		icu_ftp: null,
		icu_rolling_ftp: null,
		power_field: null,
		stream_types: null,
		device_name: null,
		total_elevation_gain: elevationGain,
	};
}

describe("selectTerrain", () => {
	it("recommends flat for base category", () => {
		const result = selectTerrain("base", [], NOW);
		expect(result.terrain).toBe("flat");
	});

	it("recommends flat for recovery category", () => {
		const result = selectTerrain("recovery", [], NOW);
		expect(result.terrain).toBe("flat");
	});

	it("recommends flat for intervals category", () => {
		const result = selectTerrain("intervals", [], NOW);
		expect(result.terrain).toBe("flat");
	});

	it("recommends trail for long category when >50% trail runs in 14 days", () => {
		const activities = [
			makeRunActivity(1, "TrailRun", 120),
			makeRunActivity(3, "TrailRun", 95),
			makeRunActivity(5, "TrailRun", 80),
			makeRunActivity(7, "Run", 15),
		];
		const result = selectTerrain("long", activities, NOW);
		expect(result.terrain).toBe("trail");
	});

	it("recommends flat for long category when <50% trail runs", () => {
		const activities = [
			makeRunActivity(1, "Run", 15),
			makeRunActivity(3, "Run", 20),
			makeRunActivity(5, "TrailRun", 80),
			makeRunActivity(7, "Run", 10),
		];
		const result = selectTerrain("long", activities, NOW);
		expect(result.terrain).toBe("flat");
	});

	it("recommends rolling for tempo when all recent runs are flat", () => {
		const activities = [
			makeRunActivity(1, "Run", 10),
			makeRunActivity(3, "Run", 15),
			makeRunActivity(5, "Run", 8),
		];
		const result = selectTerrain("tempo", activities, NOW);
		expect(result.terrain).toBe("rolling");
	});

	it("recommends flat for tempo when recent runs have elevation", () => {
		const activities = [
			makeRunActivity(1, "Run", 80),
			makeRunActivity(3, "Run", 15),
			makeRunActivity(5, "Run", 8),
		];
		const result = selectTerrain("tempo", activities, NOW);
		expect(result.terrain).toBe("flat");
	});

	it("returns any for rest category", () => {
		const result = selectTerrain("rest", [], NOW);
		expect(result.terrain).toBe("any");
	});

	it("returns pool for swim workouts regardless of category", () => {
		for (const cat of ["recovery", "base", "tempo", "intervals", "long"] as const) {
			const result = selectTerrain(cat, [], NOW, "Swim");
			expect(result.terrain).toBe("pool");
			expect(result.rationale).toContain("Pool");
		}
	});
});
