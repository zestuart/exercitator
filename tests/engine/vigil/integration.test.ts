import { describe, expect, it } from "vitest";
import type { ActivitySummary, PowerContext } from "../../../src/engine/types.js";
import type { VigilAlert } from "../../../src/engine/vigil/types.js";
import { selectWorkoutCategory } from "../../../src/engine/workout-selector.js";

function makeActivity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
	return {
		id: "a1",
		start_date_local: "2026-03-26T08:00:00",
		type: "Run",
		moving_time: 2400,
		distance: 8000,
		icu_training_load: 60,
		icu_atl: 45,
		icu_ctl: 50,
		average_heartrate: 145,
		max_heartrate: 170,
		icu_hr_zone_times: [600, 600, 600, 300, 300],
		perceived_exertion: null,
		power_load: 60,
		hr_load: 55,
		icu_weighted_avg_watts: 260,
		icu_average_watts: 240,
		icu_ftp: 280,
		icu_rolling_ftp: 280,
		power_field: "Power",
		stream_types: null,
		device_name: "Forerunner 970",
		total_elevation_gain: 50,
		icu_intensity: 72,
		external_id: null,
		source: null,
		session_rpe: null,
		kg_lifted: null,
		...overrides,
	};
}

const defaultPowerCtx: PowerContext = {
	source: "stryd",
	ftp: 280,
	rolling_ftp: 280,
	correction_factor: 1.0,
	confidence: "high",
	warnings: [],
};

function makeVigilAlert(severity: 0 | 1 | 2 | 3): VigilAlert {
	return {
		severity,
		flags:
			severity > 0
				? [
						{
							metric: "avg_gct_ms",
							zScore: 2.5,
							weight: 1.0,
							weightedZ: 2.5,
							concernScore: 2.5,
							direction: "worsening",
							value7d: 255,
							value30d: 235,
						},
						{
							metric: "avg_lss",
							zScore: -2.3,
							weight: 1.0,
							weightedZ: -2.3,
							concernScore: 2.3,
							direction: "worsening",
							value7d: 9.35,
							value30d: 10.5,
						},
					]
				: [],
		summary: severity === 0 ? "No concerns" : `Severity ${severity} alert`,
		recommendation: severity >= 2 ? "Downshifted" : "Normal",
	};
}

describe("Vigil protective downshift in selectWorkoutCategory", () => {
	const now = new Date("2026-03-28T10:00:00Z");

	it("severity 0 does not affect category", () => {
		// Easy activities with no hard session → high readiness should get intervals
		const activities = [
			makeActivity({ start_date_local: "2026-03-24T08:00:00", icu_intensity: 65 }),
			makeActivity({ start_date_local: "2026-03-25T08:00:00", icu_intensity: 60 }),
		];

		const withoutVigil = selectWorkoutCategory(75, activities, "Run", now, defaultPowerCtx);
		const withVigil = selectWorkoutCategory(
			75,
			activities,
			"Run",
			now,
			defaultPowerCtx,
			makeVigilAlert(0),
		);

		expect(withoutVigil).toBe(withVigil);
	});

	it("severity 1 does not affect category", () => {
		const activities = [
			makeActivity({ start_date_local: "2026-03-24T08:00:00", icu_intensity: 65 }),
			makeActivity({ start_date_local: "2026-03-25T08:00:00", icu_intensity: 60 }),
		];

		const withoutVigil = selectWorkoutCategory(75, activities, "Run", now, defaultPowerCtx);
		const withVigil = selectWorkoutCategory(
			75,
			activities,
			"Run",
			now,
			defaultPowerCtx,
			makeVigilAlert(1),
		);

		expect(withoutVigil).toBe(withVigil);
	});

	it("severity 2 downshifts intervals → tempo", () => {
		const activities = [
			makeActivity({ start_date_local: "2026-03-24T08:00:00", icu_intensity: 65 }),
			makeActivity({ start_date_local: "2026-03-25T08:00:00", icu_intensity: 60 }),
		];

		// Without Vigil, readiness 75 + no recent hard → intervals
		const withoutVigil = selectWorkoutCategory(75, activities, "Run", now, defaultPowerCtx);
		expect(withoutVigil).toBe("intervals");

		const withVigil = selectWorkoutCategory(
			75,
			activities,
			"Run",
			now,
			defaultPowerCtx,
			makeVigilAlert(2),
		);
		expect(withVigil).toBe("tempo");
	});

	it("severity 2 downshifts tempo → base", () => {
		const activities = [
			makeActivity({ start_date_local: "2026-03-24T08:00:00", icu_intensity: 65 }),
			makeActivity({ start_date_local: "2026-03-25T08:00:00", icu_intensity: 60 }),
		];

		// Readiness 60 + no recent hard → tempo
		const withoutVigil = selectWorkoutCategory(60, activities, "Run", now, defaultPowerCtx);
		expect(withoutVigil).toBe("tempo");

		const withVigil = selectWorkoutCategory(
			60,
			activities,
			"Run",
			now,
			defaultPowerCtx,
			makeVigilAlert(2),
		);
		expect(withVigil).toBe("base");
	});

	it("severity 3 forces base regardless of upstream category", () => {
		const activities = [
			makeActivity({ start_date_local: "2026-03-24T08:00:00", icu_intensity: 65 }),
			makeActivity({ start_date_local: "2026-03-25T08:00:00", icu_intensity: 60 }),
		];

		// High readiness would normally get intervals
		const category = selectWorkoutCategory(
			85,
			activities,
			"Run",
			now,
			defaultPowerCtx,
			makeVigilAlert(3),
		);
		expect(category).toBe("base");
	});

	it("severity 3 preserves rest and recovery", () => {
		const activities: ActivitySummary[] = [];

		// Very low readiness → rest
		const rest = selectWorkoutCategory(
			15,
			activities,
			"Run",
			now,
			defaultPowerCtx,
			makeVigilAlert(3),
		);
		expect(rest).toBe("rest");

		// Low readiness → recovery
		const recovery = selectWorkoutCategory(
			30,
			activities,
			"Run",
			now,
			defaultPowerCtx,
			makeVigilAlert(3),
		);
		expect(recovery).toBe("recovery");
	});

	it("coexists with hardSessionGuard (both can protect independently)", () => {
		// Hard session yesterday + Vigil severity 2
		const activities = [
			makeActivity({
				start_date_local: "2026-03-27T08:00:00",
				icu_intensity: 92,
				perceived_exertion: 9,
			}),
			// Long run earlier in the week prevents long-session trigger
			makeActivity({
				id: "a2",
				start_date_local: "2026-03-22T08:00:00",
				moving_time: 6000,
				icu_intensity: 65,
			}),
		];

		// Hard session guard alone would give base (readiness 70, hard yesterday)
		const withoutVigil = selectWorkoutCategory(70, activities, "Run", now, defaultPowerCtx);
		expect(withoutVigil).toBe("base");

		// Vigil severity 2 also wants base → no conflict, still base
		const withVigil = selectWorkoutCategory(
			70,
			activities,
			"Run",
			now,
			defaultPowerCtx,
			makeVigilAlert(2),
		);
		expect(withVigil).toBe("base");
	});
});
