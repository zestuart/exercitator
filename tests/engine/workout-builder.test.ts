import { describe, expect, it } from "vitest";
import type { PowerContext, SportSettings } from "../../src/engine/types.js";
import { buildWorkout } from "../../src/engine/workout-builder.js";

const runSettings: SportSettings = {
	type: "Run",
	ftp: 292,
	lthr: 163,
	threshold_pace: 270, // 4:30/km
	hr_zones: [137, 150, 163, 172, 180],
	pace_zones: null,
	power_zones: [55, 75, 90, 105, 120, 150, 999],
};

const runSettingsNoPace: SportSettings = {
	type: "Run",
	ftp: null,
	lthr: 163,
	threshold_pace: null,
	hr_zones: [137, 150, 163, 172, 180],
	pace_zones: null,
	power_zones: null,
};

const swimSettings: SportSettings = {
	type: "Swim",
	ftp: null,
	lthr: 163,
	threshold_pace: 0.97, // 0.97 secs/m = 97 secs/100m = 1:37/100m (intervals.icu format)
	hr_zones: [137, 145, 155, 163, 172],
	pace_zones: null,
	power_zones: null,
};

const strydCtx: PowerContext = {
	source: "stryd",
	ftp: 248,
	rolling_ftp: 248,
	correction_factor: 1.0,
	confidence: "high",
	warnings: [],
};

const garminCtx: PowerContext = {
	source: "garmin",
	ftp: 292,
	rolling_ftp: 300,
	correction_factor: 1.0,
	confidence: "high",
	warnings: [],
};

const noPowerCtx: PowerContext = {
	source: "none",
	ftp: 0,
	rolling_ftp: null,
	correction_factor: 1.0,
	confidence: "low",
	warnings: [],
};

describe("buildWorkout", () => {
	it("builds a run recovery with Stryd power targets", () => {
		const result = buildWorkout("recovery", "Run", runSettings, 30, 50, strydCtx);
		expect(result.segments).toHaveLength(3);
		expect(result.segments[0].name).toBe("Warm-up");
		expect(result.segments[1].name).toBe("Main set");
		expect(result.segments[2].name).toBe("Cool-down");
		expect(result.total_duration_secs).toBeLessThanOrEqual(2100);
		expect(result.title).toBe("Recovery Run");

		// Power targets present in Stryd scale (< 70% of 248 = 174W)
		const main = result.segments[1];
		expect(main.target_power_high).toBeDefined();
		expect(main.target_power_high).toBeLessThanOrEqual(174);
		expect(main.target_power_high).toBeGreaterThanOrEqual(170);
		expect(main.target_description).toContain("W");
		expect(main.target_description).toContain("HR cap");
	});

	it("builds run base with Stryd dual targets", () => {
		const result = buildWorkout("base", "Run", runSettings, 50, 50, strydCtx);
		const main = result.segments[1];
		// Z2: 70-80% of 248 = 174-198W — runnable aerobic, not brisk-walk wattage.
		expect(main.target_power_low).toBeGreaterThanOrEqual(170);
		expect(main.target_power_low).toBeLessThanOrEqual(180);
		expect(main.target_power_high).toBeGreaterThanOrEqual(195);
		expect(main.target_power_high).toBeLessThanOrEqual(200);
		expect(main.target_description).toContain("Z2 power");
		expect(main.target_description).toContain("HR cap");
	});

	it("builds run intervals with Garmin power (no Stryd)", () => {
		const result = buildWorkout("intervals", "Run", runSettings, 80, 50, garminCtx);
		const mainSet = result.segments.find((s) => s.name === "Main set");
		expect(mainSet).toBeDefined();
		expect(mainSet?.repeats).toBeGreaterThanOrEqual(5);
		// Z4: 90-105% of 292 = 263-307W (Garmin scale)
		expect(mainSet?.target_power_low).toBeGreaterThanOrEqual(260);
		expect(mainSet?.target_power_high).toBeLessThanOrEqual(310);
		expect(mainSet?.target_description).toContain("Z4 power");
	});

	it("builds run base with HR-only when no power source", () => {
		const result = buildWorkout("base", "Run", runSettingsNoPace, 50, 50, noPowerCtx);
		const main = result.segments[1];
		expect(main.target_power_low).toBeUndefined();
		expect(main.target_power_high).toBeUndefined();
		expect(main.target_description).toContain("heart rate");
		expect(main.target_description).not.toContain("W");
	});

	it("builds swim base with distances", () => {
		const result = buildWorkout("base", "Swim", swimSettings, 50, 50);
		expect(result.segments.length).toBeGreaterThanOrEqual(2);
		expect(result.title).toBe("Endurance Swim");
		const mainSet = result.segments.find((s) => s.name === "Main set");
		expect(mainSet?.target_description).toContain("200m");
	});

	it("renders swim pace targets as valid mm:ss/100m strings", () => {
		const result = buildWorkout("tempo", "Swim", swimSettings, 65, 50);
		const threshold = result.segments.find((s) => s.name === "Threshold set");
		expect(threshold).toBeDefined();
		// CSS = 0.97 s/m = 97 s/100m. Z3 offset = 0 → 97s = 1:37/100m
		expect(threshold?.target_description).toContain("1:37/100m");

		const speed = result.segments.find((s) => s.name === "Speed set");
		expect(speed).toBeDefined();
		// Z4 offset = -6 → 91s = 1:31/100m
		expect(speed?.target_description).toContain("1:31/100m");
	});

	it("scales duration by CTL", () => {
		const lowCtl = buildWorkout("base", "Run", runSettings, 50, 25, strydCtx);
		const highCtl = buildWorkout("base", "Run", runSettings, 50, 75, strydCtx);
		expect(highCtl.total_duration_secs).toBeGreaterThan(lowCtl.total_duration_secs);
		const ratio = highCtl.total_duration_secs / lowCtl.total_duration_secs;
		expect(ratio).toBeGreaterThanOrEqual(2.0);
		expect(ratio).toBeLessThanOrEqual(3.0);
	});

	it("produces estimated load within expected range", () => {
		const result = buildWorkout("tempo", "Run", runSettings, 65, 50, strydCtx);
		const durationMins = result.total_duration_secs / 60;
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

	it("enforces minimum session duration for low CTL", () => {
		// CTL 10 → scale 0.2, clamped to 0.6. Tempo swim minimum is ~30 min
		// (tolerance of 1s for rounding across multiple warm-up segments)
		const result = buildWorkout("tempo", "Swim", swimSettings, 65, 10);
		expect(result.total_duration_secs).toBeGreaterThanOrEqual(1799);
	});

	it("target_description does not embed repeat count", () => {
		for (const sport of ["Run", "Swim"] as const) {
			const settings = sport === "Run" ? runSettings : swimSettings;
			const power = sport === "Run" ? strydCtx : undefined;
			for (const cat of ["recovery", "base", "tempo", "intervals", "long"] as const) {
				const result = buildWorkout(cat, sport, settings, 70, 50, power);
				for (const seg of result.segments) {
					if (seg.repeats && seg.repeats > 1) {
						expect(seg.target_description).not.toMatch(
							/^\d+[×x]/,
							`${sport}/${cat}/${seg.name}: target_description should not start with rep count`,
						);
					}
				}
			}
		}
	});

	it("includes dual targets on every running segment with power source", () => {
		for (const cat of ["recovery", "base", "tempo", "intervals", "long"] as const) {
			const result = buildWorkout(cat, "Run", runSettings, 70, 50, strydCtx);
			const mainSegments = result.segments.filter(
				(s) => s.name !== "Warm-up" && s.name !== "Cool-down",
			);
			for (const seg of mainSegments) {
				expect(seg.target_power_high).toBeDefined();
				expect(seg.target_description).toContain("HR cap");
			}
		}
	});
});
