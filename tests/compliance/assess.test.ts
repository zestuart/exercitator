import { beforeEach, describe, expect, it } from "vitest";
import {
	type ActivityLap,
	assessCompliance,
	flattenSegments,
	hrToZone,
} from "../../src/compliance/assess.js";
import type { WorkoutSegment } from "../../src/engine/types.js";

describe("hrToZone", () => {
	const ceilings = [140, 155, 170, 185, 200]; // Z1-Z5

	it("returns Z1 for HR below first ceiling", () => {
		expect(hrToZone(130, ceilings)).toBe(1);
	});

	it("returns Z1 for HR at first ceiling", () => {
		expect(hrToZone(140, ceilings)).toBe(1);
	});

	it("returns Z2 for HR between Z1 and Z2 ceiling", () => {
		expect(hrToZone(150, ceilings)).toBe(2);
	});

	it("returns Z5 for HR at Z5 ceiling", () => {
		expect(hrToZone(200, ceilings)).toBe(5);
	});

	it("returns Z6 for HR above all ceilings", () => {
		expect(hrToZone(210, ceilings)).toBe(6);
	});
});

describe("flattenSegments", () => {
	it("passes through non-repeat segments", () => {
		const segs: WorkoutSegment[] = [
			{ name: "Warm-up", duration_secs: 600, target_description: "Easy", target_hr_zone: 1 },
			{ name: "Main", duration_secs: 1200, target_description: "Z2", target_hr_zone: 2 },
		];
		const flat = flattenSegments(segs);
		expect(flat).toHaveLength(2);
		expect(flat[0].name).toBe("Warm-up");
		expect(flat[1].name).toBe("Main");
	});

	it("expands repeats into work + rest segments", () => {
		const segs: WorkoutSegment[] = [
			{
				name: "Intervals",
				duration_secs: 1200,
				target_description: "4x200m",
				target_hr_zone: 4,
				repeats: 4,
				work_duration_secs: 180,
				rest_duration_secs: 60,
			},
		];
		const flat = flattenSegments(segs);
		// 4 work + 3 rest (no rest after last rep)
		expect(flat).toHaveLength(7);
		expect(flat[0].name).toBe("Intervals (rep 1/4)");
		expect(flat[0].isRest).toBe(false);
		expect(flat[1].name).toBe("Intervals (rest)");
		expect(flat[1].isRest).toBe(true);
		expect(flat[6].name).toBe("Intervals (rep 4/4)");
	});
});

describe("assessCompliance", () => {
	const hrZones = [140, 155, 170, 185, 200];

	const makeSegments = (): WorkoutSegment[] => [
		{
			name: "Warm-up",
			duration_secs: 600,
			target_description: "Easy",
			target_hr_zone: 1,
		},
		{
			name: "Main",
			duration_secs: 1200,
			target_description: "Z2 steady",
			target_hr_zone: 2,
			target_power_low: 180,
			target_power_high: 220,
		},
		{
			name: "Cool-down",
			duration_secs: 300,
			target_description: "Easy",
			target_hr_zone: 1,
		},
	];

	it("all green when all metrics within targets", () => {
		const laps: ActivityLap[] = [
			{ total_elapsed_time: 600, average_heartrate: 130, average_watts: null, avg_speed: null },
			{ total_elapsed_time: 1200, average_heartrate: 150, average_watts: 200, avg_speed: null },
			{ total_elapsed_time: 300, average_heartrate: 125, average_watts: null, avg_speed: null },
		];
		const result = assessCompliance(makeSegments(), laps, hrZones);
		expect(result.overallPass).toBe(true);
		expect(result.segmentsPassed).toBe(3);
		expect(result.segments.every((s) => s.light === "green")).toBe(true);
	});

	it("HR overshoot fails the segment", () => {
		const laps: ActivityLap[] = [
			{ total_elapsed_time: 600, average_heartrate: 160, average_watts: null, avg_speed: null }, // Z3 not Z1
			{ total_elapsed_time: 1200, average_heartrate: 150, average_watts: 200, avg_speed: null },
			{ total_elapsed_time: 300, average_heartrate: 125, average_watts: null, avg_speed: null },
		];
		const result = assessCompliance(makeSegments(), laps, hrZones);
		expect(result.overallPass).toBe(false);
		expect(result.segments[0].hrZonePass).toBe(false);
		expect(result.segments[0].hrZoneActual).toBe(3);
		expect(result.segments[0].light).toBe("amber"); // HR fails but duration passes
	});

	it("power below range fails the segment (amber if HR passes)", () => {
		const laps: ActivityLap[] = [
			{ total_elapsed_time: 600, average_heartrate: 130, average_watts: null, avg_speed: null },
			{ total_elapsed_time: 1200, average_heartrate: 150, average_watts: 160, avg_speed: null }, // below 180W
			{ total_elapsed_time: 300, average_heartrate: 125, average_watts: null, avg_speed: null },
		];
		const result = assessCompliance(makeSegments(), laps, hrZones);
		expect(result.overallPass).toBe(false);
		expect(result.segments[1].powerPass).toBe(false);
		expect(result.segments[1].hrZonePass).toBe(true);
		expect(result.segments[1].light).toBe("amber");
	});

	it("skips very short laps (<30s)", () => {
		const laps: ActivityLap[] = [
			{ total_elapsed_time: 5, average_heartrate: null, average_watts: null, avg_speed: null }, // auto-lap artifact
			{ total_elapsed_time: 600, average_heartrate: 130, average_watts: null, avg_speed: null },
			{ total_elapsed_time: 1200, average_heartrate: 150, average_watts: 200, avg_speed: null },
			{ total_elapsed_time: 300, average_heartrate: 125, average_watts: null, avg_speed: null },
		];
		const result = assessCompliance(makeSegments(), laps, hrZones);
		expect(result.overallPass).toBe(true);
	});

	it("marks unmatched segments as failed when fewer laps than segments", () => {
		const laps: ActivityLap[] = [
			{ total_elapsed_time: 600, average_heartrate: 130, average_watts: null, avg_speed: null },
		];
		const result = assessCompliance(makeSegments(), laps, hrZones);
		expect(result.segments[0].segmentPass).toBe(true);
		expect(result.segments[1].segmentPass).toBe(false);
		expect(result.segments[1].light).toBe("red");
		expect(result.segments[2].segmentPass).toBe(false);
	});

	it("handles swim segments with HR only", () => {
		const swimSegs: WorkoutSegment[] = [
			{ name: "Warm-up", duration_secs: 300, target_description: "Easy free", target_hr_zone: 1 },
			{ name: "Main", duration_secs: 600, target_description: "Z2 pull", target_hr_zone: 2 },
		];
		const laps: ActivityLap[] = [
			{ total_elapsed_time: 300, average_heartrate: 120, average_watts: null, avg_speed: null },
			{ total_elapsed_time: 600, average_heartrate: 148, average_watts: null, avg_speed: null },
		];
		const result = assessCompliance(swimSegs, laps, hrZones);
		expect(result.overallPass).toBe(true);
	});

	it("duration tolerance allows 15% deviation", () => {
		const segs: WorkoutSegment[] = [
			{ name: "Set", duration_secs: 600, target_description: "Z2", target_hr_zone: 2 },
		];
		// 14% over — should pass
		const laps14: ActivityLap[] = [
			{ total_elapsed_time: 684, average_heartrate: 150, average_watts: null, avg_speed: null },
		];
		expect(assessCompliance(segs, laps14, hrZones).segments[0].durationPass).toBe(true);

		// 20% over — should fail
		const laps20: ActivityLap[] = [
			{ total_elapsed_time: 720, average_heartrate: 150, average_watts: null, avg_speed: null },
		];
		expect(assessCompliance(segs, laps20, hrZones).segments[0].durationPass).toBe(false);
	});

	it("handles repeat segments correctly", () => {
		const segs: WorkoutSegment[] = [
			{
				name: "Intervals",
				duration_secs: 600,
				target_description: "3x100m",
				target_hr_zone: 4,
				repeats: 3,
				work_duration_secs: 120,
				rest_duration_secs: 60,
			},
		];
		const laps: ActivityLap[] = [
			{ total_elapsed_time: 120, average_heartrate: 180, average_watts: null, avg_speed: null },
			{ total_elapsed_time: 60, average_heartrate: 140, average_watts: null, avg_speed: null },
			{ total_elapsed_time: 120, average_heartrate: 182, average_watts: null, avg_speed: null },
			{ total_elapsed_time: 60, average_heartrate: 138, average_watts: null, avg_speed: null },
			{ total_elapsed_time: 120, average_heartrate: 178, average_watts: null, avg_speed: null },
		];
		const result = assessCompliance(segs, laps, hrZones);
		// 3 work + 2 rest = 5 flat segments
		expect(result.segments).toHaveLength(5);
		// Rest segments always pass
		expect(result.segments[1].segmentPass).toBe(true);
		expect(result.segments[3].segmentPass).toBe(true);
	});
});
