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
	it("emits absolute watts for running power targets", () => {
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
		expect(text).toContain("Main set");
		// Main set: explicit watts, no %FTP
		expect(text).toContain("138-188W");
		expect(text).not.toMatch(/\d+-\d+%(?!\s*HR)/);
		// Warm-up has no explicit band but FTP=250 → synthesised Z1 Easy 65-80% = 163-200W
		expect(text).toContain("163-200W");
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

	it("generates repeat format with blank lines for interval sets", () => {
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
		// Recovery rendered as Z1 Easy watts (FTP=250 → 163-200W), not "50%"
		expect(text).toContain("2m 163-200W");
		expect(text).not.toContain("2m 50%");
	});

	it("falls back to 50% recovery target when FTP is unknown", () => {
		const suggestion = makeSuggestion({
			power_context: NO_POWER,
			segments: [
				{
					name: "Main set",
					duration_secs: 600,
					target_description: "intervals",
					target_hr_zone: 4,
					repeats: 3,
					work_duration_secs: 120,
					rest_duration_secs: 60,
				},
			],
		});

		const text = buildIntervalsDescription(suggestion);
		expect(text).toContain("3x");
		expect(text).toContain("1m 50%");
	});

	it("matches the canonical tempo workout format end-to-end", () => {
		// Mirrors the format the user expects:
		//   Warm-up
		//   - 6m40s 163-200W
		//   Main set
		//
		//   2x
		//   - 6m 200-225W
		//   - 3m 163-200W
		//
		//   Cool-down
		//   - 3m20s 163-200W
		const suggestion = makeSuggestion({
			category: "tempo",
			segments: [
				{
					name: "Warm-up",
					duration_secs: 400,
					target_description: "Progressive build",
					target_hr_zone: 2,
					stryd_zone: 1,
				},
				{
					name: "Main set",
					duration_secs: 1080,
					target_description: "tempo",
					target_hr_zone: 3,
					stryd_zone: 2,
					target_power_low: 200,
					target_power_high: 225,
					repeats: 2,
					work_duration_secs: 360,
					rest_duration_secs: 180,
				},
				{
					name: "Cool-down",
					duration_secs: 200,
					target_description: "Easy jog",
					target_hr_zone: 1,
				},
			],
		});

		const text = buildIntervalsDescription(suggestion);
		const lines = text.split("\n");
		expect(lines).toEqual([
			"Warm-up",
			"- 6m40s 163-200W",
			"Main set",
			"",
			"2x",
			"- 6m 200-225W",
			"- 3m 163-200W",
			"",
			"Cool-down",
			"- 3m20s 163-200W",
		]);
		// Belt-and-braces: nothing in the description should contain a non-ASCII codepoint
		for (let i = 0; i < text.length; i++) {
			expect(text.charCodeAt(i)).toBeLessThanOrEqual(0x7f);
		}
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

	it("formats swim with mtr units, Pace suffix, and blank-line repeats", () => {
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
				{
					name: "Cool-down",
					duration_secs: 240,
					target_description: "200m easy",
					target_hr_zone: 1,
				},
			],
		});

		const text = buildIntervalsDescription(suggestion);
		// Uses mtr (not m which means minutes)
		expect(text).toContain("300mtr");
		expect(text).toContain("100mtr");
		expect(text).toContain("200mtr");
		// Pace has Pace suffix — /100m is the pace denominator (not /100mtr)
		expect(text).toContain("1:39/100m Pace");
		// Repeats present
		expect(text).toContain("8x");
		// Rest uses intensity, not "rest" keyword
		expect(text).toContain("15s 50%");
		expect(text).not.toContain("rest");
		// No time-based durations for swim steps
		expect(text).not.toContain("1m30s");
		// Blank lines around repeat block
		const repeatIdx = text.indexOf("8x");
		expect(text[repeatIdx - 1]).toBe("\n");
	});
});
