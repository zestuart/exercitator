import { describe, expect, it } from "vitest";
import type { PowerContext, WorkoutSuggestion } from "../../src/engine/types.js";
import { buildIntervalsDescription } from "../../src/web/intervals-format.js";

const DEFAULT_POWER: PowerContext = {
	source: "stryd",
	ftp: 250,
	rolling_ftp: 248,
	correction_factor: 1.0,
	confidence: "high",
	warnings: [],
};

const NO_POWER: PowerContext = {
	source: "none",
	ftp: 0,
	rolling_ftp: null,
	correction_factor: 1.0,
	confidence: "low",
	warnings: [],
};

function makeSuggestion(overrides: Partial<WorkoutSuggestion>): WorkoutSuggestion {
	return {
		sport: "Run",
		category: "base",
		title: "Easy Base Run",
		rationale: "Test",
		total_duration_secs: 3000,
		estimated_load: 35,
		segments: [],
		readiness_score: 60,
		sport_selection_reason: "Test",
		terrain: "flat",
		terrain_rationale: "Test",
		power_context: DEFAULT_POWER,
		warnings: [],
		...overrides,
	};
}

describe("buildIntervalsDescription", () => {
	it("generates power targets as FTP percentages for running with power", () => {
		const suggestion = makeSuggestion({
			segments: [
				{
					name: "Warm-up",
					duration_secs: 600,
					target_description: "Progressive warm-up",
					target_hr_zone: 1,
				},
				{
					name: "Main set",
					duration_secs: 2100,
					target_description: "Z2 power",
					target_hr_zone: 2,
					target_power_low: 138,
					target_power_high: 188,
				},
			],
			power_context: DEFAULT_POWER,
		});

		const text = buildIntervalsDescription(suggestion);
		expect(text).toContain("Warm-up");
		expect(text).toContain("10m");
		expect(text).toContain("%");
		expect(text).toContain("Main set");
	});

	it("uses HR zone fallback when no power source", () => {
		const suggestion = makeSuggestion({
			segments: [
				{
					name: "Main set",
					duration_secs: 1800,
					target_description: "Steady Z2",
					target_hr_zone: 2,
				},
			],
			power_context: NO_POWER,
		});

		const text = buildIntervalsDescription(suggestion);
		expect(text).toContain("HR");
		expect(text).toContain("30m");
	});

	it("generates repeat format for interval sets", () => {
		const suggestion = makeSuggestion({
			segments: [
				{
					name: "Main set",
					duration_secs: 1350,
					target_description: "2.5min Z4",
					target_hr_zone: 4,
					target_power_low: 228,
					target_power_high: 263,
					repeats: 5,
					work_duration_secs: 150,
					rest_duration_secs: 120,
				},
			],
		});

		const text = buildIntervalsDescription(suggestion);
		expect(text).toContain("5x");
		expect(text).toContain("2m30s");
		expect(text).toContain("2m rest");
	});

	it("generates valid output for recovery run", () => {
		const suggestion = makeSuggestion({
			category: "recovery",
			segments: [
				{
					name: "Warm-up",
					duration_secs: 300,
					target_description: "Easy walk",
					target_hr_zone: 1,
				},
				{
					name: "Main set",
					duration_secs: 1350,
					target_description: "Z1",
					target_hr_zone: 1,
					target_power_low: 0,
					target_power_high: 138,
				},
				{
					name: "Cool-down",
					duration_secs: 300,
					target_description: "Easy walk",
					target_hr_zone: 1,
				},
			],
		});

		const text = buildIntervalsDescription(suggestion);
		const lines = text.split("\n");
		// Every step line starts with "- "
		const stepLines = lines.filter((l) => l.startsWith("- "));
		expect(stepLines.length).toBeGreaterThan(0);
		// Section headers don't start with "- "
		const headers = lines.filter((l) => !l.startsWith("- ") && l.trim().length > 0);
		expect(headers.length).toBeGreaterThan(0);
	});

	it("formats swim suggestion with distance-based descriptions", () => {
		const suggestion = makeSuggestion({
			sport: "Swim",
			power_context: NO_POWER,
			segments: [
				{
					name: "Warm-up",
					duration_secs: 360,
					target_description: "300m progressive warm-up",
					target_hr_zone: 1,
				},
				{
					name: "Main set",
					duration_secs: 840,
					target_description: "100m Z4 1:39/100m",
					target_hr_zone: 4,
					repeats: 8,
					work_duration_secs: 90,
					rest_duration_secs: 15,
				},
			],
		});

		const text = buildIntervalsDescription(suggestion);
		expect(text).toContain("8x");
		expect(text).toContain("100m Z4");
		expect(text).toContain("15s rest");
		// Swim uses target_description directly, not time-based durations
		expect(text).not.toContain("1m30s");
		expect(text).toContain("300m progressive warm-up");
	});
});
