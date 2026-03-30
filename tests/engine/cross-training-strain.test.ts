import { describe, expect, it } from "vitest";
import {
	CROSS_TRAINING_TYPES,
	assessCrossTrainingStrain,
	assessStrainFromHrv,
	assessStrainFromSessionRpe,
	computeRmssd,
	computeSessionRpeBaseline,
	findTodayCrossTraining,
	flattenHrvStream,
	isCrossTraining,
} from "../../src/engine/cross-training-strain.js";
import type { ActivitySummary } from "../../src/engine/types.js";

const NOW = new Date("2026-03-30T12:00:00");

function makeActivity(
	type: string,
	daysAgo: number,
	overrides: Partial<ActivitySummary> = {},
): ActivitySummary {
	const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
	return {
		id: `a-${type}-${daysAgo}`,
		start_date_local: d.toISOString().slice(0, 19),
		type,
		moving_time: 2400,
		distance: null,
		icu_training_load: 20,
		icu_atl: 20,
		icu_ctl: 20,
		average_heartrate: 115,
		max_heartrate: 150,
		icu_hr_zone_times: null,
		perceived_exertion: null,
		power_load: null,
		hr_load: 20,
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

// ---------------------------------------------------------------------------
// #18: Classification
// ---------------------------------------------------------------------------

describe("isCrossTraining", () => {
	it("recognises WeightTraining", () => {
		expect(isCrossTraining("WeightTraining")).toBe(true);
	});

	it("recognises RockClimbing", () => {
		expect(isCrossTraining("RockClimbing")).toBe(true);
	});

	it("recognises IndoorClimbing", () => {
		expect(isCrossTraining("IndoorClimbing")).toBe(true);
	});

	it("rejects Run", () => {
		expect(isCrossTraining("Run")).toBe(false);
	});

	it("rejects Swim", () => {
		expect(isCrossTraining("Swim")).toBe(false);
	});

	it("rejects Ride", () => {
		expect(isCrossTraining("Ride")).toBe(false);
	});
});

describe("CROSS_TRAINING_TYPES", () => {
	it("contains exactly 3 types", () => {
		expect(CROSS_TRAINING_TYPES).toHaveLength(3);
	});
});

describe("findTodayCrossTraining", () => {
	it("finds same-day weight training", () => {
		const activities = [
			makeActivity("WeightTraining", 0),
			makeActivity("Run", 0),
			makeActivity("WeightTraining", 1),
		];
		const result = findTodayCrossTraining(activities, NOW);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("WeightTraining");
	});

	it("returns empty when no cross-training today", () => {
		const activities = [makeActivity("Run", 0), makeActivity("WeightTraining", 1)];
		expect(findTodayCrossTraining(activities, NOW)).toHaveLength(0);
	});

	it("finds multiple same-day cross-training activities", () => {
		const activities = [
			makeActivity("WeightTraining", 0),
			makeActivity("RockClimbing", 0, { id: "climb-0" }),
		];
		expect(findTodayCrossTraining(activities, NOW)).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// #23: HRV strain (tier 1)
// ---------------------------------------------------------------------------

describe("flattenHrvStream", () => {
	it("flattens per-second R-R arrays and filters artefacts", () => {
		const stream: (number[] | null)[] = [
			[800, 810],
			null,
			[750, 200, 790], // 200ms is artefact
			[2100], // 2100ms is artefact
		];
		const result = flattenHrvStream(stream);
		expect(result).toEqual([800, 810, 750, 790]);
	});

	it("returns empty for all-null stream", () => {
		expect(flattenHrvStream([null, null])).toEqual([]);
	});
});

describe("computeRmssd", () => {
	it("computes RMSSD for a simple sequence", () => {
		// Successive differences: 10, -10, 10 → squared: 100, 100, 100 → mean: 100 → sqrt: 10
		const rr = [800, 810, 800, 810];
		const rmssd = computeRmssd(rr);
		expect(rmssd).toBeCloseTo(10, 1);
	});

	it("returns 0 for fewer than 2 intervals", () => {
		expect(computeRmssd([800])).toBe(0);
		expect(computeRmssd([])).toBe(0);
	});

	it("returns higher RMSSD for more variable intervals (relaxed)", () => {
		const relaxed = [800, 850, 780, 860, 770, 840];
		const tense = [800, 802, 798, 801, 799, 800];
		expect(computeRmssd(relaxed)).toBeGreaterThan(computeRmssd(tense));
	});
});

describe("assessStrainFromHrv", () => {
	const baseline = { mean: 45, sd: 10, n: 5 };

	it("returns light when RMSSD above baseline mean", () => {
		expect(assessStrainFromHrv(50, baseline)).toBe("light");
	});

	it("returns moderate when RMSSD between mean and mean - 1 SD", () => {
		expect(assessStrainFromHrv(38, baseline)).toBe("moderate");
	});

	it("returns hard when RMSSD below mean - 1 SD", () => {
		expect(assessStrainFromHrv(30, baseline)).toBe("hard");
	});

	it("returns null when baseline has fewer than 3 activities", () => {
		expect(assessStrainFromHrv(30, { mean: 45, sd: 10, n: 2 })).toBeNull();
	});

	it("returns null when baseline is null", () => {
		expect(assessStrainFromHrv(30, null)).toBeNull();
	});

	it("returns null when baseline SD is zero", () => {
		expect(assessStrainFromHrv(30, { mean: 45, sd: 0, n: 5 })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// #19: session_rpe strain (tier 2)
// ---------------------------------------------------------------------------

describe("computeSessionRpeBaseline", () => {
	it("computes baseline from recent cross-training activities", () => {
		const activities = [
			makeActivity("WeightTraining", 1, { session_rpe: 500 }),
			makeActivity("WeightTraining", 3, { session_rpe: 316 }),
			makeActivity("WeightTraining", 5, { session_rpe: 406 }),
			makeActivity("WeightTraining", 7, { session_rpe: 145 }),
			makeActivity("WeightTraining", 9, { session_rpe: 108 }),
			makeActivity("WeightTraining", 11, { session_rpe: 73 }),
			makeActivity("WeightTraining", 13, { session_rpe: 178 }),
		];

		const baseline = computeSessionRpeBaseline(activities);
		expect(baseline).not.toBeNull();
		expect(baseline?.n).toBe(7);
		expect(baseline?.mean).toBeCloseTo(246.6, 0);
		expect(baseline?.sd).toBeGreaterThan(100);
	});

	it("returns null with fewer than 3 activities", () => {
		const activities = [
			makeActivity("WeightTraining", 1, { session_rpe: 500 }),
			makeActivity("WeightTraining", 3, { session_rpe: 316 }),
		];
		expect(computeSessionRpeBaseline(activities)).toBeNull();
	});

	it("ignores non-cross-training activities", () => {
		const activities = [
			makeActivity("Run", 1, { session_rpe: 500 }),
			makeActivity("WeightTraining", 3, { session_rpe: 316 }),
			makeActivity("WeightTraining", 5, { session_rpe: 406 }),
		];
		expect(computeSessionRpeBaseline(activities)).toBeNull();
	});

	it("limits to most recent N activities", () => {
		const activities = Array.from({ length: 15 }, (_, i) =>
			makeActivity("WeightTraining", i + 1, {
				id: `wt-${i}`,
				session_rpe: 200 + i * 10,
			}),
		);
		const baseline = computeSessionRpeBaseline(activities, 10);
		expect(baseline?.n).toBe(10);
	});
});

describe("assessStrainFromSessionRpe", () => {
	// Real calibration data: mean ≈ 247, SD ≈ 151
	const baseline = { mean: 247, sd: 151, n: 7 };

	it("returns hard when session_rpe > mean + SD", () => {
		expect(assessStrainFromSessionRpe(500, baseline)).toBe("hard");
	});

	it("returns moderate when session_rpe between mean and mean + SD", () => {
		expect(assessStrainFromSessionRpe(300, baseline)).toBe("moderate");
	});

	it("returns light when session_rpe < mean", () => {
		expect(assessStrainFromSessionRpe(178, baseline)).toBe("light");
	});

	it("uses absolute fallback without baseline", () => {
		expect(assessStrainFromSessionRpe(500, null)).toBe("hard");
		expect(assessStrainFromSessionRpe(300, null)).toBe("moderate");
		expect(assessStrainFromSessionRpe(100, null)).toBe("light");
	});
});

// ---------------------------------------------------------------------------
// Cascade integration
// ---------------------------------------------------------------------------

describe("assessCrossTrainingStrain", () => {
	it("uses session_rpe when available (tier 2)", () => {
		const activity = makeActivity("WeightTraining", 0, { session_rpe: 500 });
		const allActivities = [
			activity,
			makeActivity("WeightTraining", 2, { session_rpe: 200 }),
			makeActivity("WeightTraining", 4, { session_rpe: 150 }),
			makeActivity("WeightTraining", 6, { session_rpe: 180 }),
		];

		const result = assessCrossTrainingStrain(activity, allActivities);
		expect(result.source).toBe("session_rpe");
		expect(result.level).toBe("hard");
	});

	it("falls through to unknown when no session_rpe (tier 3)", () => {
		const activity = makeActivity("WeightTraining", 0);
		const result = assessCrossTrainingStrain(activity, [activity]);
		expect(result.source).toBe("awaiting_input");
		expect(result.level).toBe("unknown");
	});

	it("uses HRV when stream is provided (tier 1)", () => {
		const activity = makeActivity("WeightTraining", 0, {
			stream_types: ["heartrate", "hrv"],
		});
		// Simulate a hard session: low RMSSD
		const hrvStream: (number[] | null)[] = Array.from({ length: 20 }, () => [391, 395]);
		const hrvBaseline = { mean: 45, sd: 10, n: 5 };

		const result = assessCrossTrainingStrain(activity, [activity], hrvStream, hrvBaseline);
		expect(result.source).toBe("hrv");
	});

	it("falls through from HRV to session_rpe when HRV stream is empty", () => {
		const activity = makeActivity("WeightTraining", 0, { session_rpe: 300 });
		const allActivities = [
			activity,
			makeActivity("WeightTraining", 2, { session_rpe: 200 }),
			makeActivity("WeightTraining", 4, { session_rpe: 150 }),
			makeActivity("WeightTraining", 6, { session_rpe: 180 }),
		];

		const result = assessCrossTrainingStrain(activity, allActivities, [], null);
		expect(result.source).toBe("session_rpe");
	});
});
