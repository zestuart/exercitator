import { describe, expect, it } from "vitest";
import type { SportSettings } from "../../src/engine/types.js";
import { buildWorkout } from "../../src/engine/workout-builder.js";

const runSettings: SportSettings = {
	type: "Run",
	ftp: 292,
	lthr: 163,
	threshold_pace: 270, // 4:30/km
	hr_zones: [137, 150, 163, 172, 180],
	pace_zones: null,
};

const runSettingsNoPace: SportSettings = {
	type: "Run",
	ftp: null,
	lthr: 163,
	threshold_pace: null,
	hr_zones: [137, 150, 163, 172, 180],
	pace_zones: null,
};

const swimSettings: SportSettings = {
	type: "Swim",
	ftp: null,
	lthr: 163,
	threshold_pace: 97, // 1:37/100m
	hr_zones: [137, 145, 155, 163, 172],
	pace_zones: null,
};

describe("buildWorkout", () => {
	it("builds a run recovery with 3 segments", () => {
		const result = buildWorkout("recovery", "Run", runSettings, 30, 50);
		expect(result.segments).toHaveLength(3);
		expect(result.segments[0].name).toBe("Warm-up");
		expect(result.segments[1].name).toBe("Main set");
		expect(result.segments[2].name).toBe("Cool-down");
		expect(result.total_duration_secs).toBeLessThanOrEqual(2100); // ≤35 min
		expect(result.title).toBe("Recovery Run");
	});

	it("builds run intervals with repeats", () => {
		const result = buildWorkout("intervals", "Run", runSettings, 80, 50);
		const mainSet = result.segments.find((s) => s.name === "Main set");
		expect(mainSet).toBeDefined();
		expect(mainSet?.repeats).toBeGreaterThanOrEqual(5);
		expect(mainSet?.work_duration_secs).toBeGreaterThan(0);
		expect(mainSet?.rest_duration_secs).toBeGreaterThan(0);
		expect(mainSet?.target_description).toContain("/km");
	});

	it("builds swim base with distances", () => {
		const result = buildWorkout("base", "Swim", swimSettings, 50, 50);
		expect(result.segments.length).toBeGreaterThanOrEqual(2);
		expect(result.title).toBe("Endurance Swim");
		const mainSet = result.segments.find((s) => s.name === "Main set");
		expect(mainSet?.target_description).toContain("200m");
	});

	it("scales duration by CTL", () => {
		const lowCtl = buildWorkout("base", "Run", runSettings, 50, 25);
		const highCtl = buildWorkout("base", "Run", runSettings, 50, 75);
		// CTL 25 → scale 0.6, CTL 75 → scale 1.5
		expect(highCtl.total_duration_secs).toBeGreaterThan(lowCtl.total_duration_secs);
		// Roughly 2.5x ratio (1.5/0.6)
		const ratio = highCtl.total_duration_secs / lowCtl.total_duration_secs;
		expect(ratio).toBeGreaterThanOrEqual(2.0);
		expect(ratio).toBeLessThanOrEqual(3.0);
	});

	it("falls back to HR zone targets when pace is missing", () => {
		const result = buildWorkout("intervals", "Run", runSettingsNoPace, 80, 50);
		const mainSet = result.segments.find((s) => s.name === "Main set");
		expect(mainSet?.target_description).toContain("Z4 heart rate");
		expect(mainSet?.target_description).not.toContain("/km");
	});

	it("produces estimated load within expected range", () => {
		const result = buildWorkout("tempo", "Run", runSettings, 65, 50);
		const durationMins = result.total_duration_secs / 60;
		// Tempo intensity factor is 1.0
		const expectedLoad = durationMins * 1.0;
		expect(result.estimated_load).toBeGreaterThan(expectedLoad * 0.8);
		expect(result.estimated_load).toBeLessThan(expectedLoad * 1.2);
	});

	it("returns empty segments for rest", () => {
		const result = buildWorkout("rest", "Run", runSettings, 10, 50);
		expect(result.segments).toHaveLength(0);
		expect(result.total_duration_secs).toBe(0);
		expect(result.category).toBe("rest");
	});
});
