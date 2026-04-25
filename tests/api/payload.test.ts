import { describe, expect, it } from "vitest";
import {
	criticalPowerFromContext,
	injuryWarningFromVigil,
	readinessFromEngine,
	segmentToApi,
} from "../../src/api/payload.js";
import type { PowerContext, WorkoutSegment } from "../../src/engine/types.js";
import type { VigilResult } from "../../src/engine/vigil/index.js";

describe("readinessFromEngine", () => {
	it("bands score 86 as ready/green", () => {
		const out = readinessFromEngine(86, [], true);
		expect(out.score).toBe(86);
		expect(out.tier).toBe("ready");
		expect(out.advisory).toBe("green");
	});

	it("bands score 45 as caution/amber", () => {
		const out = readinessFromEngine(45, [], true);
		expect(out.tier).toBe("caution");
		expect(out.advisory).toBe("amber");
	});

	it("bands score 20 as recover/red", () => {
		const out = readinessFromEngine(20, [], true);
		expect(out.tier).toBe("recover");
		expect(out.advisory).toBe("red");
	});

	it("returns unknown/grey when hasEnoughData is false", () => {
		const out = readinessFromEngine(86, [], false);
		expect(out.score).toBeNull();
		expect(out.tier).toBe("unknown");
		expect(out.advisory).toBe("grey");
	});
});

describe("criticalPowerFromContext", () => {
	const pcStryd: PowerContext = {
		source: "stryd",
		ftp: 285,
		rolling_ftp: 285,
		correction_factor: 1.0,
		confidence: "high",
		warnings: [],
	};
	const pcGarmin: PowerContext = {
		source: "garmin",
		ftp: 270,
		rolling_ftp: 270,
		correction_factor: 1.0,
		confidence: "high",
		warnings: [],
	};
	const pcNone: PowerContext = {
		source: "none",
		ftp: 0,
		rolling_ftp: null,
		correction_factor: 1.0,
		confidence: "low",
		warnings: [],
	};

	it("stryd_direct when strydCp is present", () => {
		const cp = criticalPowerFromContext(pcStryd, 312, "2026-04-20T00:00:00Z");
		expect(cp.source).toBe("stryd_direct");
		expect(cp.watts).toBe(312);
	});

	it("stryd_intervals when power context is stryd but no direct CP", () => {
		const cp = criticalPowerFromContext(pcStryd, null, null);
		expect(cp.source).toBe("stryd_intervals");
		expect(cp.watts).toBe(285);
	});

	it("intervals_inferred for garmin source", () => {
		const cp = criticalPowerFromContext(pcGarmin, null, null);
		expect(cp.source).toBe("intervals_inferred");
	});

	it("none + null watts for no power", () => {
		const cp = criticalPowerFromContext(pcNone, null, null);
		expect(cp.source).toBe("none");
		expect(cp.watts).toBeNull();
	});

	it("rounds float watts from Stryd CP API to integer", () => {
		const cp = criticalPowerFromContext(pcStryd, 273.84478, "2026-04-20T00:00:00Z");
		expect(cp.watts).toBe(274);
	});
});

describe("injuryWarningFromVigil", () => {
	it("returns inactive shape when result is null", () => {
		const out = injuryWarningFromVigil(null);
		expect(out.severity).toBe(0);
		expect(out.status).toBe("inactive");
		expect(out.flags).toEqual([]);
	});

	it("maps a VigilResult with severity 2 correctly", () => {
		const result: VigilResult = {
			alert: {
				severity: 2,
				summary: "Caution: GCT rising",
				recommendation: "Intensity downshifted.",
				flags: [
					{
						metric: "avg_gct_ms",
						zScore: 2.5,
						weight: 1.0,
						weightedZ: 2.5,
						concernScore: 2.5,
						direction: "worsening",
						value7d: 255,
						value30d: 235,
					},
				],
			},
			baselineWindow: "30d",
			acuteWindow: "7d",
			status: "active",
		};
		const out = injuryWarningFromVigil(result);
		expect(out.severity).toBe(2);
		expect(out.status).toBe("active");
		expect(out.flags).toHaveLength(1);
		expect(out.flags[0].z_score).toBe(2.5);
		expect(out.flags[0].metric).toBe("avg_gct_ms");
	});
});

describe("segmentToApi", () => {
	it("emits power target for Run segment with power range", () => {
		const seg: WorkoutSegment = {
			name: "Tempo",
			duration_secs: 600,
			target_description: "Tempo 275–295 W",
			target_hr_zone: 3,
			target_power_low: 275,
			target_power_high: 295,
		};
		const out = segmentToApi(seg, "Run");
		expect(out.target).toEqual({ kind: "power", low_w: 275, high_w: 295 });
		expect(out.target_hr_zone).toBe(3);
		expect(out.duration_s).toBe(600);
	});

	it("emits pace target for Swim segment", () => {
		const seg: WorkoutSegment = {
			name: "Freestyle 100s",
			duration_secs: 480,
			target_description: "free 1:50/100",
			target_pace_secs_low: 105,
			target_pace_secs_high: 110,
		};
		const out = segmentToApi(seg, "Swim");
		expect(out.target).toEqual({
			kind: "pace",
			stroke: "free",
			low_s_per_100m: 105,
			high_s_per_100m: 110,
		});
	});

	it("falls back to hr target when only hr zone is set", () => {
		const seg: WorkoutSegment = {
			name: "Warm-up",
			duration_secs: 600,
			target_description: "Easy Z1",
			target_hr_zone: 1,
		};
		const out = segmentToApi(seg, "Run");
		expect(out.target).toEqual({ kind: "hr", zone: 1 });
	});
});
