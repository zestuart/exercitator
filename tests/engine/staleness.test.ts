import { describe, expect, it } from "vitest";
import { applyStaleness, computeStaleness } from "../../src/engine/staleness.js";
import type { ActivitySummary } from "../../src/engine/types.js";

const NOW = new Date("2026-03-26T12:00:00");

function makeActivity(
	type: string,
	dateLocal: string,
	overrides: Partial<ActivitySummary> = {},
): ActivitySummary {
	return {
		id: `a-${dateLocal}`,
		start_date_local: dateLocal,
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

describe("computeStaleness", () => {
	it("returns normal for recent activity (<= 27 days)", () => {
		const activities = [
			makeActivity("Swim", "2026-03-20T08:00:00"),
			makeActivity("Run", "2026-03-25T07:00:00"),
		];

		const result = computeStaleness(activities, "Swim", NOW);
		expect(result.tier).toBe("normal");
		expect(result.daysSinceLast).toBe(6);
		expect(result.paceBufferSecs).toBe(0);
		expect(result.hrOnly).toBe(false);
		expect(result.warnings).toHaveLength(0);
	});

	it("returns moderate for 28-60 day gap", () => {
		// Last swim 35 days ago
		const activities = [
			makeActivity("Swim", "2026-02-19T08:00:00"),
			makeActivity("Run", "2026-03-25T07:00:00"),
		];

		const result = computeStaleness(activities, "Swim", NOW);
		expect(result.tier).toBe("moderate");
		expect(result.daysSinceLast).toBe(35);
		expect(result.paceBufferSecs).toBe(10);
		expect(result.hrOnly).toBe(false);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("35 days ago");
		expect(result.warnings[0]).toContain("10s/100m");
	});

	it("returns severe for >60 day gap", () => {
		// Last swim 61 days ago (2026-01-24)
		const activities = [
			makeActivity("Swim", "2026-01-24T08:00:00"),
			makeActivity("Run", "2026-03-25T07:00:00"),
		];

		const result = computeStaleness(activities, "Swim", NOW);
		expect(result.tier).toBe("severe");
		expect(result.daysSinceLast).toBe(61);
		expect(result.paceBufferSecs).toBe(15);
		expect(result.hrOnly).toBe(true);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("HR-only");
		expect(result.warnings[0]).toContain("15s/100m");
	});

	it("returns no_history when no activities for the sport exist", () => {
		const activities = [
			makeActivity("Run", "2026-03-25T07:00:00"),
			makeActivity("Run", "2026-03-20T07:00:00"),
		];

		const result = computeStaleness(activities, "Swim", NOW);
		expect(result.tier).toBe("no_history");
		expect(result.daysSinceLast).toBeNull();
		expect(result.paceBufferSecs).toBe(15);
		expect(result.hrOnly).toBe(true);
		expect(result.warnings[0]).toContain("No swim history");
	});

	it("computes staleness per sport independently", () => {
		// Recent run but stale swim
		const activities = [
			makeActivity("Run", "2026-03-25T07:00:00"),
			makeActivity("Swim", "2026-02-10T08:00:00"), // 44 days ago
		];

		const runResult = computeStaleness(activities, "Run", NOW);
		const swimResult = computeStaleness(activities, "Swim", NOW);

		expect(runResult.tier).toBe("normal");
		expect(swimResult.tier).toBe("moderate");
	});

	it("uses correct units per sport in warnings", () => {
		const activities = [
			makeActivity("Run", "2026-02-10T08:00:00"), // 44 days ago
			makeActivity("Swim", "2026-02-10T08:00:00"),
		];

		const runResult = computeStaleness(activities, "Run", NOW);
		const swimResult = computeStaleness(activities, "Swim", NOW);

		expect(runResult.warnings[0]).toContain("/km");
		expect(swimResult.warnings[0]).toContain("/100m");
	});
});

describe("applyStaleness", () => {
	it("does not change category for normal tier", () => {
		expect(applyStaleness("intervals", "normal")).toBe("intervals");
		expect(applyStaleness("tempo", "normal")).toBe("tempo");
		expect(applyStaleness("rest", "normal")).toBe("rest");
	});

	it("downgrades one level for moderate tier", () => {
		expect(applyStaleness("intervals", "moderate")).toBe("tempo");
		expect(applyStaleness("tempo", "moderate")).toBe("base");
		expect(applyStaleness("base", "moderate")).toBe("recovery");
		expect(applyStaleness("long", "moderate")).toBe("base");
		expect(applyStaleness("recovery", "moderate")).toBe("recovery");
		expect(applyStaleness("rest", "moderate")).toBe("rest");
	});

	it("caps at base for severe tier", () => {
		expect(applyStaleness("intervals", "severe")).toBe("base");
		expect(applyStaleness("tempo", "severe")).toBe("base");
		expect(applyStaleness("long", "severe")).toBe("base");
		expect(applyStaleness("base", "severe")).toBe("base");
		expect(applyStaleness("recovery", "severe")).toBe("recovery");
		expect(applyStaleness("rest", "severe")).toBe("rest");
	});

	it("treats no_history same as severe", () => {
		expect(applyStaleness("intervals", "no_history")).toBe("base");
		expect(applyStaleness("tempo", "no_history")).toBe("base");
		expect(applyStaleness("base", "no_history")).toBe("base");
		expect(applyStaleness("recovery", "no_history")).toBe("recovery");
	});

	it("staleness never raises category (readiness interaction)", () => {
		// If readiness already says recovery, staleness should not override upward
		expect(applyStaleness("recovery", "moderate")).toBe("recovery");
		expect(applyStaleness("recovery", "severe")).toBe("recovery");
		expect(applyStaleness("rest", "severe")).toBe("rest");
	});
});
