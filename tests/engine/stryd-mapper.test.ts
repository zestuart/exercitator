import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	mapCategoryToStrydType,
	pickStrydWorkout,
	strydWorkoutToSegments,
} from "../../src/engine/stryd-mapper.js";
import type { WorkoutCategory } from "../../src/engine/types.js";
import type { StrydRecommendationSet } from "../../src/stryd/client.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "stryd-recommendations");

function loadFixture(name: string): StrydRecommendationSet {
	const path = join(FIXTURE_DIR, name);
	return JSON.parse(readFileSync(path, "utf-8")) as StrydRecommendationSet;
}

const EASY_FIXTURE: StrydRecommendationSet = loadFixture("recommendations-easy-extfalse.json");
const WORKOUT_FIXTURE: StrydRecommendationSet = loadFixture("recommendations-workout-extfalse.json");

// ---------------------------------------------------------------------------
// mapCategoryToStrydType
// ---------------------------------------------------------------------------

describe("mapCategoryToStrydType", () => {
	const cases: [WorkoutCategory, "easy" | "long" | "workout" | null][] = [
		["rest", null],
		["recovery", "easy"],
		["base", "easy"],
		["progression", "easy"],
		["tempo", "workout"],
		["threshold", "workout"],
		["intervals", "workout"],
		["long", "long"],
	];

	for (const [category, expected] of cases) {
		it(`maps ${category} → ${String(expected)}`, () => {
			expect(mapCategoryToStrydType(category)).toBe(expected);
		});
	}
});

// ---------------------------------------------------------------------------
// pickStrydWorkout
// ---------------------------------------------------------------------------

describe("pickStrydWorkout", () => {
	it("rejects the stride workout on a recovery day", () => {
		// Easy fixture has exactly one workout: 'Easy + Strides', type='stride'.
		const result = pickStrydWorkout("recovery", EASY_FIXTURE);
		expect(result).toBeNull();
	});

	it("picks Easy + Strides for a base day from the easy fixture", () => {
		const result = pickStrydWorkout("base", EASY_FIXTURE);
		expect(result).not.toBeNull();
		expect(result?.picked.estimated_workout.workout.title).toBe("Easy + Strides");
		expect(result?.rationale).toContain("Easy + Strides");
	});

	it("picks Hill Hustle for intervals (Z4+Z5: 300 s > 150 s)", () => {
		// Sanity-check the empirical zone counts before asserting the outcome.
		// workout fixture, workouts[0] = Dash & Dine: intensity_zones=[930,0,480,150,0]
		// workouts[1] = Hill Hustle:                  intensity_zones=[1200,0,0,300,0]
		const dashAndDine = WORKOUT_FIXTURE.workouts[0];
		const hillHustle = WORKOUT_FIXTURE.workouts[1];
		expect(dashAndDine.estimated_workout.workout.title).toBe("Dash & Dine");
		expect(hillHustle.estimated_workout.workout.title).toBe("Hill Hustle");
		const dashZ4Z5 =
			dashAndDine.estimated_workout.intensity_zones[3] +
			dashAndDine.estimated_workout.intensity_zones[4];
		const hillZ4Z5 =
			hillHustle.estimated_workout.intensity_zones[3] +
			hillHustle.estimated_workout.intensity_zones[4];
		expect(dashZ4Z5).toBe(150);
		expect(hillZ4Z5).toBe(300);

		const result = pickStrydWorkout("intervals", WORKOUT_FIXTURE);
		expect(result).not.toBeNull();
		expect(result?.picked.estimated_workout.workout.title).toBe("Hill Hustle");
		expect(result?.rationale).toContain("Hill Hustle");
		expect(result?.rationale).toContain("Dash & Dine"); // runner-up named
		expect(result?.rationale).toContain("300");
		expect(result?.rationale).toContain("150");
		expect(result?.rationale).toContain("Z4+Z5");
	});

	it("picks Dash & Dine for threshold (Z3: 480 s > 0 s)", () => {
		const dashZ3 = WORKOUT_FIXTURE.workouts[0].estimated_workout.intensity_zones[2];
		const hillZ3 = WORKOUT_FIXTURE.workouts[1].estimated_workout.intensity_zones[2];
		expect(dashZ3).toBe(480);
		expect(hillZ3).toBe(0);

		const result = pickStrydWorkout("threshold", WORKOUT_FIXTURE);
		expect(result).not.toBeNull();
		expect(result?.picked.estimated_workout.workout.title).toBe("Dash & Dine");
		expect(result?.rationale).toContain("Dash & Dine");
		expect(result?.rationale).toContain("Z3");
	});

	it("picks Dash & Dine for tempo (Z2 tie at 0; closer intensity to 0.85)", () => {
		// Both workouts have Z2=0 seconds, so the tiebreak runs on average
		// intensity. Dash & Dine intensity ~0.8185, Hill Hustle ~0.768.
		// Expected tempo intensity = 0.85 → Dash & Dine is closer.
		const dashZ2 = WORKOUT_FIXTURE.workouts[0].estimated_workout.intensity_zones[1];
		const hillZ2 = WORKOUT_FIXTURE.workouts[1].estimated_workout.intensity_zones[1];
		expect(dashZ2).toBe(0);
		expect(hillZ2).toBe(0);

		const result = pickStrydWorkout("tempo", WORKOUT_FIXTURE);
		expect(result).not.toBeNull();
		expect(result?.picked.estimated_workout.workout.title).toBe("Dash & Dine");
		expect(result?.rationale).toContain("Dash & Dine");
	});

	it("returns null for an empty recommendation set", () => {
		const empty: StrydRecommendationSet = { ...WORKOUT_FIXTURE, workouts: [] };
		expect(pickStrydWorkout("intervals", empty)).toBeNull();
	});

	it("allows stride on base (Easy + Strides accepted)", () => {
		const result = pickStrydWorkout("base", EASY_FIXTURE);
		expect(result).not.toBeNull();
		expect(result?.picked.estimated_workout.workout.type).toBe("stride");
	});
});

// ---------------------------------------------------------------------------
// strydWorkoutToSegments
// ---------------------------------------------------------------------------

describe("strydWorkoutToSegments", () => {
	const FTP = 286; // Ze's current critical power, watts

	it("flattens block.repeat=3 strides in Easy + Strides", () => {
		// Easy + Strides has 4 blocks:
		//   [0] warmup x1, 1 segment (4:30)
		//   [1] warmup x1, 1 segment (4:30)
		//   [2] strides x3, 2 segments each (20s work + 60s rest)  ← repeat=3
		//   [3] cooldown x1, 1 segment (9:00)
		// Flattened total = 1 + 1 + 3*2 + 1 = 9 segments.
		const easy = EASY_FIXTURE.workouts[0].estimated_workout.workout;
		expect(easy.title).toBe("Easy + Strides");
		expect(easy.blocks[2].repeat).toBe(3);
		expect(easy.blocks[2].segments.length).toBe(2);

		const segments = strydWorkoutToSegments(easy, FTP);
		expect(segments.length).toBe(9);

		// Indices 2..7 should be the strides (alternating work, rest).
		for (let i = 0; i < 3; i++) {
			const work = segments[2 + i * 2];
			const rest = segments[2 + i * 2 + 1];
			expect(work.name).toBe("Work");
			expect(work.duration_secs).toBe(20);
			expect(rest.name).toBe("Recovery");
			expect(rest.duration_secs).toBe(60);
		}
	});

	it("converts Hill Hustle power bands at FTP=286 W", () => {
		const hill = WORKOUT_FIXTURE.workouts[1].estimated_workout.workout;
		expect(hill.title).toBe("Hill Hustle");

		const segments = strydWorkoutToSegments(hill, FTP);
		expect(segments.length).toBeGreaterThan(0);

		// Locate a 105–115% CP sprint segment (15 s peak burst).
		// 105% of 286 = 300.3 → 300; 115% of 286 = 328.9 → 329.
		const sprint = segments.find(
			(s) => s.target_power_low === 300 && s.target_power_high === 329 && s.duration_secs === 15,
		);
		expect(sprint).toBeDefined();
		expect(sprint?.name).toBe("Work");
		expect(sprint?.target_description).toContain("105");
		expect(sprint?.target_description).toContain("115");
	});

	it("emits target_power_low <= target_power_high for every segment", () => {
		for (const fixture of [EASY_FIXTURE, WORKOUT_FIXTURE]) {
			for (const candidate of fixture.workouts) {
				const segments = strydWorkoutToSegments(candidate.estimated_workout.workout, FTP);
				for (const seg of segments) {
					expect(seg.target_power_low).toBeDefined();
					expect(seg.target_power_high).toBeDefined();
					expect(seg.target_power_low as number).toBeLessThanOrEqual(
						seg.target_power_high as number,
					);
				}
			}
		}
	});

	it("does not set target_hr_zone (Stryd is power-prescribed)", () => {
		const easy = EASY_FIXTURE.workouts[0].estimated_workout.workout;
		const segments = strydWorkoutToSegments(easy, FTP);
		for (const seg of segments) {
			expect(seg.target_hr_zone).toBeUndefined();
		}
	});

	it("computes the cool-down power band correctly for Easy + Strides", () => {
		// Cool-down: 9:00 @ 70-80% CP → 200W..229W at FTP=286.
		const easy = EASY_FIXTURE.workouts[0].estimated_workout.workout;
		const segments = strydWorkoutToSegments(easy, FTP);
		const cooldown = segments[segments.length - 1];
		expect(cooldown.name).toBe("Cool-down");
		expect(cooldown.duration_secs).toBe(540);
		expect(cooldown.target_power_low).toBe(Math.round(0.7 * FTP)); // 200
		expect(cooldown.target_power_high).toBe(Math.round(0.8 * FTP)); // 229
	});
});
