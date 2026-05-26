import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	formWorkoutToSegments,
	mapCategoryToFormType,
	pickFormWorkout,
} from "../../src/engine/form-mapper.js";
import type { SportSettings } from "../../src/engine/types.js";
import type { FormRecommendationSet, FormWorkoutBody } from "../../src/form/client.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "form-personalized");

function loadFixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8")) as T;
}

const PERSONALIZED = loadFixture<FormRecommendationSet>("personalized.json");
const ENDURANCE = loadFixture<FormWorkoutBody>("workout-endurance.json");
const POWER = loadFixture<FormWorkoutBody>("workout-power.json");
const TECHNIQUE = loadFixture<FormWorkoutBody>("workout-technique.json");

const BODIES = new Map<string, FormWorkoutBody>([
	[ENDURANCE.id, ENDURANCE],
	[POWER.id, POWER],
	[TECHNIQUE.id, TECHNIQUE],
]);

// Ze's calibrated CSS = 0.94 m/s (per reference_swim_thresholds), LTHR 140.
// Threshold_pace is in m/s on intervals.icu side.
const SETTINGS: SportSettings = {
	sport: "Swim",
	threshold_pace: 0.94,
	hr_zones: [118, 125, 131, 139, 143, 147, 161],
	power_zones: null,
	min_rest_days: null,
	threshold_hr: 140,
} as unknown as SportSettings;

describe("mapCategoryToFormType", () => {
	it.each([
		["rest", null],
		["recovery", "Technique"],
		["base", "Endurance"],
		["progression", "Endurance"],
		["tempo", "Endurance"],
		["long", "Endurance"],
		["threshold", "Power"],
		["intervals", "Power"],
	] as const)("%s → %s", (category, expected) => {
		expect(mapCategoryToFormType(category)).toBe(expected);
	});
});

describe("pickFormWorkout", () => {
	it("returns null for the rest category", () => {
		expect(pickFormWorkout("rest", PERSONALIZED, BODIES, 0.94)).toBeNull();
	});

	it("returns null when bodies map is empty", () => {
		expect(pickFormWorkout("base", PERSONALIZED, new Map(), 0.94)).toBeNull();
	});

	it("picks the Endurance workout for base category", () => {
		const result = pickFormWorkout("base", PERSONALIZED, BODIES, 0.94);
		expect(result).not.toBeNull();
		expect(result?.picked.id).toBe(ENDURANCE.id);
		expect(result?.picked.name).toBe("Better As You Go");
		expect(result?.isFallback).toBe(false);
		expect(result?.rationale).toMatch(/base: picked 'Better As You Go'/);
	});

	it("picks the candidate with the most Z4+Z5 content for intervals (Technique fixture has the only Z4)", () => {
		// In this batch the FORM-typed "Power" workout is actually a Z3
		// sub-threshold strength session (3 rounds of 150m strong + 25m
		// easy/moderate/build). The Technique workout is the only one
		// containing Z4 content (2× 50m fast). Content scoring correctly
		// overrides FORM's labelling here and flags isFallback because
		// the picked top-level type ("Technique") doesn't match the
		// category-preferred type ("Power").
		const result = pickFormWorkout("intervals", PERSONALIZED, BODIES, 0.94);
		expect(result).not.toBeNull();
		expect(result?.picked.id).toBe(TECHNIQUE.id);
		expect(result?.isFallback).toBe(true);
	});

	it("picks the candidate with the least Z3+Z4 content for recovery (Endurance has lowest hard content)", () => {
		// None of the 3 candidates is a true recovery workout — the
		// Technique candidate has 2× 50m fast (Z4), Power has 3 rounds
		// of strong/build content (Z3), Endurance is Z1+Z2 only. The
		// recovery score (z[0]*2 − (z[3]+z[4])*2) correctly picks Endurance.
		// isFallback is true because preferred=Technique but picked=Endurance.
		const result = pickFormWorkout("recovery", PERSONALIZED, BODIES, 0.94);
		expect(result).not.toBeNull();
		expect(result?.picked.id).toBe(ENDURANCE.id);
		expect(result?.isFallback).toBe(true);
	});

	it("marks isFallback=true when picked type mismatches preferred", () => {
		// Reduced fixture: only the Endurance candidate available, but we ask
		// for intervals (preferred=Power). The picker must still return
		// Endurance and flag isFallback.
		const reduced: FormRecommendationSet = {
			createdAt: PERSONALIZED.createdAt,
			workouts: PERSONALIZED.workouts.filter((w) => w.workout.id === ENDURANCE.id),
		};
		const reducedBodies = new Map([[ENDURANCE.id, ENDURANCE]]);
		const result = pickFormWorkout("intervals", reduced, reducedBodies, 0.94);
		expect(result).not.toBeNull();
		expect(result?.picked.id).toBe(ENDURANCE.id);
		expect(result?.isFallback).toBe(true);
	});

	it("rationale includes the runner-up when ≥ 2 candidates", () => {
		const result = pickFormWorkout("base", PERSONALIZED, BODIES, 0.94);
		expect(result?.rationale).toMatch(/over '/);
	});
});

describe("formWorkoutToSegments — Endurance fixture (Better As You Go)", () => {
	const segments = formWorkoutToSegments(ENDURANCE, SETTINGS);

	it("flattens rounds + pre-collapses intra-set pairs", () => {
		// Expected groups in Endurance fixture:
		//   warmup:   1 set,  rounds=1, intervalsCount=1   → 1 segment
		//   preSet:   2 sets, rounds=1
		//             set1: 10× 25m drill rest=15  → 1 repeats-encoded segment
		//             set2:  2× 50m freestyle rest=15 → 1 repeats-encoded segment
		//   main:     2 sets, rounds=1
		//             set1: 2× 200m rest=35 → 1 repeats segment
		//             set2: 3× 150m rest=25 → 1 repeats segment
		//   cooldown: 1 set, rounds=1, 2× 75m rest=15 → 1 repeats segment
		expect(segments).toHaveLength(6);
	});

	it("first segment is a warmup with HR zone 1 and a pace target", () => {
		const s = segments[0];
		expect(s.name).toBe("Warm-up");
		expect(s.target_hr_zone).toBe(1);
		expect(s.target_pace_secs_low).toBeGreaterThan(0);
		expect(s.target_pace_secs_high).toBeGreaterThan(s.target_pace_secs_low ?? 0);
		expect(s.target_description).toMatch(/200m/);
	});

	it("drill set is pre-collapsed with repeats=10 and rest_duration_secs=15", () => {
		const drill = segments.find((s) => s.target_description.includes("drill"));
		expect(drill).toBeDefined();
		expect(drill?.repeats).toBe(10);
		expect(drill?.rest_duration_secs).toBe(15);
		expect(drill?.target_hr_zone).toBe(1); // drill always Z1
		expect(drill?.target_description).toMatch(/25m drill/);
	});

	it("main set 200m × 2 is pre-collapsed with rest=35", () => {
		const mainBig = segments.find(
			(s) => s.name === "Main set" && s.target_description.includes("200m"),
		);
		expect(mainBig?.repeats).toBe(2);
		expect(mainBig?.work_duration_secs).toBeGreaterThan(0);
		expect(mainBig?.rest_duration_secs).toBe(35);
		expect(mainBig?.target_hr_zone).toBe(2); // moderate → Z2
	});

	it("emits cooldown as 2× 75m on :15 (pre-collapsed)", () => {
		const cooldown = segments.find((s) => s.name === "Cool-down");
		expect(cooldown?.repeats).toBe(2);
		expect(cooldown?.rest_duration_secs).toBe(15);
	});
});

describe("formWorkoutToSegments — Power fixture (Come Around Again and Again)", () => {
	const segments = formWorkoutToSegments(POWER, SETTINGS);

	it("flattens roundsCount=3 across the main group", () => {
		// main group: rounds=3, 4 sets per round.
		//   1× 150m strong  rest=None  → 1 segment per round
		//   2× 25m  easy    rest=15    → 1 collapsed per round
		//   2× 25m  moderate rest=15   → 1 collapsed per round
		//   2× 25m  build   rest=15    → 1 collapsed per round
		// Total main segments = 3 rounds × 4 = 12.
		const main = segments.filter((s) => s.name === "Main set");
		expect(main).toHaveLength(12);
	});

	it("strong 150m intervals get HR zone 3", () => {
		const strong = segments.find(
			(s) => s.name === "Main set" && s.target_description.includes("150m"),
		);
		expect(strong?.target_hr_zone).toBe(3);
		expect(strong?.repeats).toBeUndefined(); // intervalsCount=1, no collapse
	});

	it("warns and defaults unknown effort levels to moderate", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const synthetic: FormWorkoutBody = {
			...ENDURANCE,
			setGroups: [
				{
					groupType: "main",
					roundDistance: 100,
					roundsCount: 1,
					sets: [
						{
							intervalDistance: 100,
							intervalsCount: 1,
							strokeType: "freestyle",
							effort: {
								level: "alien-effort-level",
								pace: null,
								percentage: null,
								rpeLevel: null,
								splitRange: null,
								zone: null,
							},
							rest: null,
							equipment: [],
							drill: null,
							endDrill: null,
							endStrokeType: null,
							headCoachFocusMode: null,
							description: "",
						},
					],
				},
			],
		};
		const out = formWorkoutToSegments(synthetic, SETTINGS);
		expect(out).toHaveLength(1);
		expect(out[0].target_hr_zone).toBe(2);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("alien-effort-level"));
		warn.mockRestore();
	});
});

describe("formWorkoutToSegments — edge cases", () => {
	it("intervalsCount > 1 with no rest collapses to a single combined segment", () => {
		const synthetic: FormWorkoutBody = {
			...ENDURANCE,
			setGroups: [
				{
					groupType: "main",
					roundDistance: 200,
					roundsCount: 1,
					sets: [
						{
							intervalDistance: 50,
							intervalsCount: 4,
							strokeType: "freestyle",
							effort: {
								level: "moderate",
								pace: null,
								percentage: null,
								rpeLevel: null,
								splitRange: null,
								zone: null,
							},
							rest: null, // continuous
							equipment: [],
							drill: null,
							endDrill: null,
							endStrokeType: null,
							headCoachFocusMode: null,
							description: "",
						},
					],
				},
			],
		};
		const out = formWorkoutToSegments(synthetic, SETTINGS);
		expect(out).toHaveLength(1);
		expect(out[0].repeats).toBeUndefined();
		expect(out[0].target_description).toMatch(/200m/); // combined 4×50 = 200
	});

	it("takeoff-based rest falls back to flattening", () => {
		const synthetic: FormWorkoutBody = {
			...ENDURANCE,
			setGroups: [
				{
					groupType: "main",
					roundDistance: 75,
					roundsCount: 1,
					sets: [
						{
							intervalDistance: 25,
							intervalsCount: 3,
							strokeType: "freestyle",
							effort: {
								level: "moderate",
								pace: null,
								percentage: null,
								rpeLevel: null,
								splitRange: null,
								zone: null,
							},
							rest: { defined: null, takeoff: 30 },
							equipment: [],
							drill: null,
							endDrill: null,
							endStrokeType: null,
							headCoachFocusMode: null,
							description: "",
						},
					],
				},
			],
		};
		const out = formWorkoutToSegments(synthetic, SETTINGS);
		expect(out).toHaveLength(3);
		for (const s of out) {
			expect(s.repeats).toBeUndefined();
			expect(s.target_description).toMatch(/25m/);
		}
	});

	it("caps explosive roundsCount + intervalsCount via MAX_ROUNDS / MAX_INTERVALS", () => {
		const synthetic: FormWorkoutBody = {
			...ENDURANCE,
			setGroups: [
				{
					groupType: "main",
					roundDistance: 25,
					roundsCount: 100_000, // way over MAX_ROUNDS=20
					sets: [
						{
							intervalDistance: 25,
							intervalsCount: 100_000, // way over MAX_INTERVALS=100
							strokeType: "freestyle",
							effort: {
								level: "easy",
								pace: null,
								percentage: null,
								rpeLevel: null,
								splitRange: null,
								zone: null,
							},
							rest: { defined: 10, takeoff: null },
							equipment: [],
							drill: null,
							endDrill: null,
							endStrokeType: null,
							headCoachFocusMode: null,
							description: "",
						},
					],
				},
			],
		};
		const out = formWorkoutToSegments(synthetic, SETTINGS);
		// 20 rounds × 1 pre-collapsed pair = 20 segments
		expect(out).toHaveLength(20);
		expect(out[0].repeats).toBe(100); // intervals capped at MAX_INTERVALS
	});
});
