import { describe, expect, it } from "vitest";
import type { WorkoutSuggestion } from "../../src/engine/types.js";
import { buildFormDescription } from "../../src/web/form-format.js";

const NO_POWER = {
	source: "none" as const,
	ftp: 0,
	rolling_ftp: null,
	correction_factor: 1,
	confidence: "low" as const,
	warnings: [],
};

function makeSwim(overrides: Partial<WorkoutSuggestion>): WorkoutSuggestion {
	return {
		sport: "Swim",
		category: "recovery",
		title: "Recovery Swim",
		rationale: "Test",
		total_duration_secs: 1400,
		estimated_load: 9,
		segments: [],
		readiness_score: 7,
		sport_selection_reason: "Test",
		terrain: "pool",
		terrain_rationale: "Test",
		power_context: NO_POWER,
		warnings: [],
		...overrides,
	};
}

describe("buildFormDescription", () => {
	it("formats a recovery swim with correct set headers", () => {
		const suggestion = makeSwim({
			segments: [
				{
					name: "Warm-up",
					duration_secs: 240,
					target_description: "200m easy free",
					target_hr_zone: 1,
					rest_duration_secs: 20,
				},
				{
					name: "Drill set",
					duration_secs: 480,
					target_description: "50m drill/swim on :15 rest",
					target_hr_zone: 1,
					repeats: 4,
					work_duration_secs: 105,
					rest_duration_secs: 15,
				},
				{
					name: "Main set",
					duration_secs: 480,
					target_description: "400m pull Z1",
					target_hr_zone: 1,
					rest_duration_secs: 20,
				},
				{
					name: "Cool-down",
					duration_secs: 240,
					target_description: "200m easy",
					target_hr_zone: 1,
				},
			],
		});

		const text = buildFormDescription(suggestion);
		expect(text).toContain("Warm-Up");
		expect(text).toContain("Main");
		expect(text).toContain("Warm-Down");
		expect(text).toContain("200 FR Easy");
		expect(text).toContain("4 x 50 DCH Easy");
		expect(text).toContain("400 P Easy");
		// No zone numbers or pace targets
		expect(text).not.toMatch(/Z\d/);
		expect(text).not.toContain("/100m");
		expect(text).not.toContain("HR");
	});

	it("maps HR zones to FORM effort levels", () => {
		const suggestion = makeSwim({
			segments: [
				{
					name: "Warm-up",
					duration_secs: 300,
					target_description: "200m easy free",
					target_hr_zone: 1,
					rest_duration_secs: 20,
				},
				{
					name: "Threshold set",
					duration_secs: 600,
					target_description: "200m Z3",
					target_hr_zone: 3,
					repeats: 4,
					work_duration_secs: 240,
					rest_duration_secs: 30,
				},
				{
					name: "Speed set",
					duration_secs: 300,
					target_description: "50m Z4",
					target_hr_zone: 4,
					repeats: 4,
					work_duration_secs: 50,
					rest_duration_secs: 20,
				},
				{
					name: "Cool-down",
					duration_secs: 240,
					target_description: "200m easy",
					target_hr_zone: 1,
				},
			],
		});

		const text = buildFormDescription(suggestion);
		expect(text).toContain("Easy"); // Z1
		expect(text).toContain("Strong"); // Z3
		expect(text).toContain("Fast"); // Z4
	});

	it("formats rest durations", () => {
		const suggestion = makeSwim({
			segments: [
				{
					name: "Warm-up",
					duration_secs: 240,
					target_description: "200m easy free",
					target_hr_zone: 1,
					rest_duration_secs: 20,
				},
				{
					name: "Cool-down",
					duration_secs: 240,
					target_description: "200m easy",
					target_hr_zone: 1,
				},
			],
		});

		const text = buildFormDescription(suggestion);
		expect(text).toContain("20 sec rest");
		// Cool-down (last segment) should not have rest
		const lines = text.split("\n");
		const coolDownLine = lines.find((l) => l.includes("200 FR Easy") && !l.includes("rest"));
		expect(coolDownLine).toBeDefined();
	});

	it("uses correct stroke abbreviations", () => {
		const suggestion = makeSwim({
			segments: [
				{
					name: "Warm-up",
					duration_secs: 120,
					target_description: "100m easy free",
					target_hr_zone: 1,
					rest_duration_secs: 10,
				},
				{
					name: "Warm-up",
					duration_secs: 120,
					target_description: "100m kick with board",
					target_hr_zone: 1,
					rest_duration_secs: 10,
				},
				{
					name: "Warm-up",
					duration_secs: 120,
					target_description: "100m pull with buoy",
					target_hr_zone: 1,
					rest_duration_secs: 20,
				},
				{
					name: "Main set",
					duration_secs: 600,
					target_description: "100m drill/swim",
					target_hr_zone: 1,
					rest_duration_secs: 20,
				},
				{
					name: "Cool-down",
					duration_secs: 240,
					target_description: "200m easy",
					target_hr_zone: 1,
				},
			],
		});

		const text = buildFormDescription(suggestion);
		expect(text).toContain("100 FR Easy"); // free → FR
		expect(text).toContain("100 K Easy"); // kick → K
		expect(text).toContain("100 P Easy"); // pull → P
		expect(text).toContain("100 DCH Easy"); // drill → DCH
	});

	it("formats repeat segments with multiplier", () => {
		const suggestion = makeSwim({
			segments: [
				{
					name: "Warm-up",
					duration_secs: 240,
					target_description: "200m easy free",
					target_hr_zone: 1,
					rest_duration_secs: 20,
				},
				{
					name: "Main set",
					duration_secs: 840,
					target_description: "100m Z4",
					target_hr_zone: 4,
					repeats: 8,
					work_duration_secs: 90,
					rest_duration_secs: 15,
				},
				{
					name: "Cool-down",
					duration_secs: 240,
					target_description: "200m easy",
					target_hr_zone: 1,
				},
			],
		});

		const text = buildFormDescription(suggestion);
		expect(text).toContain("8 x 100 FR Fast 15 sec rest");
	});
});
