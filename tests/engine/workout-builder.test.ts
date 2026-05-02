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
	// intervals.icu stores threshold_pace in m/s. 1.0309 m/s = 100/1.0309 = 97 s/100m = 1:37/100m.
	threshold_pace: 1.0309278,
	hr_zones: [137, 145, 155, 163, 172],
	pace_zones: null,
	power_zones: null,
};

// Slower swimmer fixture — verifies the unit conversion across a full second band.
const slowSwimSettings: SportSettings = {
	...{
		type: "Swim" as const,
		ftp: null,
		lthr: 163,
		hr_zones: [137, 145, 155, 163, 172],
		pace_zones: null,
		power_zones: null,
	},
	threshold_pace: 0.94, // 100/0.94 ≈ 106.38 s/100m = 1:46/100m
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

		// Recovery sits in the bottom half of Stryd Z1 Easy: 65–75% of 248 ≈ 161–186W.
		const main = result.segments[1];
		expect(main.target_power_low).toBeGreaterThanOrEqual(158);
		expect(main.target_power_low).toBeLessThanOrEqual(165);
		expect(main.target_power_high).toBeGreaterThanOrEqual(180);
		expect(main.target_power_high).toBeLessThanOrEqual(190);
		expect(main.stryd_zone).toBe(1);
		expect(main.target_description).toContain("Stryd Z1 Easy");
		expect(main.target_description).toContain("HR cap");
	});

	it("builds run base with Stryd dual targets", () => {
		const result = buildWorkout("base", "Run", runSettings, 50, 50, strydCtx);
		const main = result.segments[1];
		// Base = full Stryd Z1 Easy: 65–80% of 248 ≈ 161–198W.
		expect(main.target_power_low).toBeGreaterThanOrEqual(158);
		expect(main.target_power_low).toBeLessThanOrEqual(165);
		expect(main.target_power_high).toBeGreaterThanOrEqual(195);
		expect(main.target_power_high).toBeLessThanOrEqual(200);
		expect(main.stryd_zone).toBe(1);
		expect(main.target_description).toContain("Stryd Z1 Easy");
		expect(main.target_description).toContain("HR cap");
	});

	it("builds run progression with thirds at climbing power bands", () => {
		const result = buildWorkout("progression", "Run", runSettings, 60, 50, strydCtx);
		const easy = result.segments.find((s) => s.name === "Easy third");
		const steady = result.segments.find((s) => s.name === "Steady third");
		const building = result.segments.find((s) => s.name === "Building third");
		expect(easy).toBeDefined();
		expect(steady).toBeDefined();
		expect(building).toBeDefined();
		// 65–72% / 72–80% / 80–87% of 248
		expect(easy?.target_power_high).toBeLessThan(steady?.target_power_high ?? 0);
		expect(steady?.target_power_high).toBeLessThan(building?.target_power_high ?? 0);
		expect(easy?.stryd_zone).toBe(1);
		expect(steady?.stryd_zone).toBe(1);
		expect(building?.stryd_zone).toBe(2);
		expect(building?.target_description).toContain("Stryd Z2 Moderate");
	});

	it("builds run threshold with Stryd Z3 sustained reps", () => {
		const result = buildWorkout("threshold", "Run", runSettings, 75, 50, strydCtx);
		const main = result.segments.find((s) => s.name === "Main set");
		expect(main).toBeDefined();
		// 90–100% of 248 ≈ 223–248W
		expect(main?.target_power_low).toBeGreaterThanOrEqual(220);
		expect(main?.target_power_low).toBeLessThanOrEqual(228);
		expect(main?.target_power_high).toBeGreaterThanOrEqual(245);
		expect(main?.target_power_high).toBeLessThanOrEqual(252);
		expect(main?.stryd_zone).toBe(3);
		expect(main?.repeats).toBe(3);
		expect(main?.target_description).toContain("Stryd Z3 Threshold");
	});

	it("builds run intervals with Garmin power at Stryd Z4", () => {
		const result = buildWorkout("intervals", "Run", runSettings, 80, 50, garminCtx);
		const mainSet = result.segments.find((s) => s.name === "Main set");
		expect(mainSet).toBeDefined();
		expect(mainSet?.repeats).toBeGreaterThanOrEqual(5);
		// Stryd Z4 Interval: 100–115% of 292 ≈ 292–336W (Garmin scale)
		expect(mainSet?.target_power_low).toBeGreaterThanOrEqual(290);
		expect(mainSet?.target_power_low).toBeLessThanOrEqual(295);
		expect(mainSet?.target_power_high).toBeGreaterThanOrEqual(330);
		expect(mainSet?.target_power_high).toBeLessThanOrEqual(340);
		expect(mainSet?.stryd_zone).toBe(4);
		expect(mainSet?.target_description).toContain("Stryd Z4 Interval");
	});

	it("tempo run sits in Stryd Z2 Moderate (sweet-spot)", () => {
		const result = buildWorkout("tempo", "Run", runSettings, 60, 50, strydCtx);
		const main = result.segments.find((s) => s.name === "Main set");
		// 80–90% of 248 ≈ 198–223W
		expect(main?.target_power_low).toBeGreaterThanOrEqual(195);
		expect(main?.target_power_low).toBeLessThanOrEqual(202);
		expect(main?.target_power_high).toBeGreaterThanOrEqual(220);
		expect(main?.target_power_high).toBeLessThanOrEqual(228);
		expect(main?.stryd_zone).toBe(2);
		expect(main?.target_description).toContain("Stryd Z2 Moderate");
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
		// threshold_pace = 1.0309 m/s → 100/1.0309 = 97 s/100m. Z3 offset = 0 → 1:37/100m.
		expect(threshold?.target_description).toContain("1:37/100m");

		const speed = result.segments.find((s) => s.name === "Speed set");
		expect(speed).toBeDefined();
		// Z4 offset = -6 → 91 s/100m = 1:31/100m.
		expect(speed?.target_description).toContain("1:31/100m");
	});

	it("converts threshold_pace from m/s to s/100m correctly for slower swimmer", () => {
		// Regression: pre-fix, the engine multiplied threshold_pace by 100, treating
		// it as s/m. For a slower swimmer this produced a faster prescribed pace
		// rather than slower. With threshold_pace = 0.94 m/s, true pace per 100m is
		// 100/0.94 ≈ 106.38 s = 1:46/100m. Buggy formula produced 0.94 × 100 = 94 s
		// = 1:34/100m — diverges in the wrong direction.
		const result = buildWorkout("tempo", "Swim", slowSwimSettings, 65, 50);
		const threshold = result.segments.find((s) => s.name === "Threshold set");
		expect(threshold).toBeDefined();
		expect(threshold?.target_description).toContain("1:46/100m");

		const speed = result.segments.find((s) => s.name === "Speed set");
		expect(speed).toBeDefined();
		// Z4 offset = -6 → 100.38 s/100m → rounds to 1:40/100m.
		expect(speed?.target_description).toContain("1:40/100m");
	});

	it("returns label only when threshold_pace is null or zero", () => {
		const noPace: SportSettings = { ...swimSettings, threshold_pace: null };
		const r1 = buildWorkout("tempo", "Swim", noPace, 65, 50);
		const t1 = r1.segments.find((s) => s.name === "Threshold set");
		expect(t1?.target_description).not.toContain("/100m");

		const zeroPace: SportSettings = { ...swimSettings, threshold_pace: 0 };
		const r2 = buildWorkout("tempo", "Swim", zeroPace, 65, 50);
		const t2 = r2.segments.find((s) => s.name === "Threshold set");
		expect(t2?.target_description).not.toContain("/100m");
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
		// Sweet-spot tempo intensity factor is 0.9.
		const expectedLoad = durationMins * 0.9;
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
			for (const cat of [
				"recovery",
				"base",
				"progression",
				"tempo",
				"threshold",
				"intervals",
				"long",
			] as const) {
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

	it("every running warm-up sits at Stryd Z1 Easy", () => {
		// User explicitly aligned warm-ups to Stryd's published warmup band
		// (65–80% CP). Every run category's warm-up segment should carry
		// stryd_zone: 1 so the renderer's zone-guide pill and the Stryd
		// workout export both treat the warmup as Z1 Easy.
		for (const cat of [
			"recovery",
			"base",
			"progression",
			"tempo",
			"threshold",
			"intervals",
			"long",
		] as const) {
			const result = buildWorkout(cat, "Run", runSettings, 70, 50, strydCtx);
			const warmup = result.segments.find((s) => s.name === "Warm-up");
			expect(warmup, `${cat} should have a Warm-up segment`).toBeDefined();
			expect(warmup?.stryd_zone, `${cat} warm-up should be Stryd Z1 Easy`).toBe(1);
		}
	});

	it("includes dual targets on every running segment with power source", () => {
		for (const cat of [
			"recovery",
			"base",
			"progression",
			"tempo",
			"threshold",
			"intervals",
			"long",
		] as const) {
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
