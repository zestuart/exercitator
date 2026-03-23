import { describe, expect, it } from "vitest";
import { selectSport } from "../../src/engine/sport-selector.js";
import type { ActivitySummary } from "../../src/engine/types.js";

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
		// Identical loads — 3 runs, 3 swims, but slightly different session counts this week
		const activities = [
			makeActivity("Run", 1, 50),
			makeActivity("Run", 3, 50),
			makeActivity("Run", 5, 50),
			makeActivity("Swim", 2, 50),
			makeActivity("Swim", 4, 50),
			makeActivity("Swim", 6, 50),
		];

		const result = selectSport(activities, 60, NOW);
		// Both have equal sessions in last 7 days (3 each) and equal load → defaults to Run
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

	it("cross-trains when readiness is low", () => {
		// Low readiness, only ran in last 3 days
		const activities = [makeActivity("Run", 1), makeActivity("Run", 2), makeActivity("Swim", 7)];

		const result = selectSport(activities, 25, NOW);
		expect(result.sport).toBe("Swim");
		expect(result.reason).toContain("Low readiness");
	});

	it("defaults to Run when no activities", () => {
		const result = selectSport([], 60, NOW);
		expect(result.sport).toBe("Run");
	});
});
