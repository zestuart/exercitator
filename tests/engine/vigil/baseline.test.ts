import { describe, expect, it } from "vitest";
import { computeBaselinesFromData } from "../../../src/engine/vigil/baseline.js";
import type { VigilMetrics } from "../../../src/engine/vigil/types.js";

function makeVigilMetrics(overrides: Partial<VigilMetrics> = {}): VigilMetrics {
	return {
		athleteId: "0",
		activityId: "1",
		icuActivityId: null,
		activityDate: "2026-03-20",
		sport: "Run",
		surfaceType: null,
		avgGctMs: 235,
		avgLss: 10.5,
		avgFormPower: 65,
		avgIlr: 12.3,
		avgVoCm: 8.2,
		avgCadence: 180,
		formPowerRatio: 0.232,
		gctDriftPct: 3.5,
		powerHrDrift: 2.1,
		strydRpe: null,
		strydFeel: null,
		lAvgGctMs: null,
		rAvgGctMs: null,
		lAvgLss: null,
		rAvgLss: null,
		lAvgVoCm: null,
		rAvgVoCm: null,
		lAvgIlr: null,
		rAvgIlr: null,
		gctAsymmetryPct: null,
		lssAsymmetryPct: null,
		voAsymmetryPct: null,
		ilrAsymmetryPct: null,
		...overrides,
	};
}

function makeActivities(
	n: number,
	overrideFn?: (i: number) => Partial<VigilMetrics>,
): VigilMetrics[] {
	return Array.from({ length: n }, (_, i) =>
		makeVigilMetrics({
			activityId: `act-${i}`,
			activityDate: `2026-03-${String(i + 1).padStart(2, "0")}`,
			...(overrideFn?.(i) ?? {}),
		}),
	);
}

// ---------------------------------------------------------------------------
// Baseline computation
// ---------------------------------------------------------------------------

describe("computeBaselinesFromData", () => {
	it("computes baselines with sufficient data (5+ activities)", () => {
		const activities30d = makeActivities(8);
		const activities7d = activities30d.slice(-3);

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);

		// Should have baselines for all unilateral scoreable metrics
		expect(baselines.length).toBeGreaterThanOrEqual(6);

		const gctBaseline = baselines.find((b) => b.metric === "avg_gct_ms");
		expect(gctBaseline).toBeDefined();
		expect(gctBaseline?.mean30d).toBeCloseTo(235, 0);
		expect(gctBaseline?.sampleCount30d).toBe(8);
		expect(gctBaseline?.mean7d).toBeCloseTo(235, 0);
		expect(gctBaseline?.sampleCount7d).toBe(3);
	});

	it("returns no baselines with fewer than 5 activities", () => {
		const activities30d = makeActivities(4);
		const activities7d = activities30d.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);
		expect(baselines.length).toBe(0);
	});

	it("returns baselines without 7d mean when fewer than 2 acute activities", () => {
		const activities30d = makeActivities(6);
		const activities7d = activities30d.slice(-1); // only 1 activity in 7d

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);
		expect(baselines.length).toBeGreaterThan(0);

		const gctBaseline = baselines.find((b) => b.metric === "avg_gct_ms");
		expect(gctBaseline?.mean7d).toBeNull();
		expect(gctBaseline?.sampleCount7d).toBeNull();
	});

	it("computes exactly 5 activities (minimum valid baseline)", () => {
		const activities30d = makeActivities(5);
		const activities7d = activities30d.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);
		expect(baselines.length).toBeGreaterThan(0);

		const gctBaseline = baselines.find((b) => b.metric === "avg_gct_ms");
		expect(gctBaseline?.sampleCount30d).toBe(5);
	});

	it("computes correct stddev for varying data", () => {
		// GCT values: 230, 232, 234, 236, 238 — known mean 234, stddev ~3.16
		const activities30d = makeActivities(5, (i) => ({
			avgGctMs: 230 + i * 2,
		}));
		const activities7d = activities30d.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);
		const gctBaseline = baselines.find((b) => b.metric === "avg_gct_ms");

		expect(gctBaseline?.mean30d).toBeCloseTo(234, 0);
		// Sample stddev of [230,232,234,236,238] = sqrt(10) ≈ 3.16
		expect(gctBaseline?.stddev30d).toBeCloseTo(3.16, 1);
	});

	it("skips metrics where all values are null", () => {
		// All ILR values null
		const activities30d = makeActivities(6, () => ({
			avgIlr: null,
		}));
		const activities7d = activities30d.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);
		const ilrBaseline = baselines.find((b) => b.metric === "avg_ilr");
		expect(ilrBaseline).toBeUndefined();

		// But GCT should still have a baseline
		const gctBaseline = baselines.find((b) => b.metric === "avg_gct_ms");
		expect(gctBaseline).toBeDefined();
	});

	it("handles partial null values correctly", () => {
		// 6 activities, but only 4 have ILR → insufficient for ILR baseline
		const activities30d = makeActivities(6, (i) => ({
			avgIlr: i < 4 ? 12.3 : null,
		}));
		const activities7d = activities30d.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);
		const ilrBaseline = baselines.find((b) => b.metric === "avg_ilr");
		// 4 non-null values < 5 minimum → no baseline
		expect(ilrBaseline).toBeUndefined();
	});

	it("computes 7d mean from acute subset only", () => {
		// 30d activities: GCT = 230, 7d activities: GCT = 250
		const chronic = makeActivities(5, () => ({ avgGctMs: 230 }));
		const acute = makeActivities(3, (i) => ({
			activityId: `acute-${i}`,
			avgGctMs: 250,
		}));
		const all = [...chronic, ...acute];

		const baselines = computeBaselinesFromData("0", "Run", all, acute);
		const gctBaseline = baselines.find((b) => b.metric === "avg_gct_ms");

		// 30d mean includes all 8 activities: (5×230 + 3×250) / 8 = 237.5
		expect(gctBaseline?.mean30d).toBeCloseTo(237.5, 0);
		// 7d mean is just the acute activities
		expect(gctBaseline?.mean7d).toBeCloseTo(250, 0);
	});

	it("excludes bilateral metrics when all null", () => {
		const activities30d = makeActivities(6);
		const activities7d = activities30d.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);
		const asymmetryBaselines = baselines.filter((b) => b.metric.includes("asymmetry"));
		expect(asymmetryBaselines.length).toBe(0);
	});

	it("includes bilateral baselines when Duo data present", () => {
		const activities30d = makeActivities(6, () => ({
			gctAsymmetryPct: 3.5,
			lssAsymmetryPct: 2.1,
		}));
		const activities7d = activities30d.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", activities30d, activities7d);
		const gctAsym = baselines.find((b) => b.metric === "gct_asymmetry_pct");
		expect(gctAsym).toBeDefined();
		expect(gctAsym?.mean30d).toBeCloseTo(3.5, 1);
	});

	it("mixed-pod: bilateral baselines from Duo activities only", () => {
		// 3 single-pod activities (no asymmetry) + 5 Duo activities (with asymmetry)
		const singlePod = makeActivities(3, () => ({
			gctAsymmetryPct: null,
			lssAsymmetryPct: null,
		}));
		const duo = makeActivities(5, (i) => ({
			activityId: `duo-${i}`,
			activityDate: `2026-03-${String(i + 10).padStart(2, "0")}`,
			gctAsymmetryPct: 3.0 + i * 0.5,
			lssAsymmetryPct: 2.0,
		}));
		const all = [...singlePod, ...duo];
		const acute = duo.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", all, acute);

		// Bilateral baseline should only include 5 Duo activities
		const gctAsym = baselines.find((b) => b.metric === "gct_asymmetry_pct");
		expect(gctAsym).toBeDefined();
		expect(gctAsym?.sampleCount30d).toBe(5);

		// Unilateral baseline includes all 8 activities
		const gctBaseline = baselines.find((b) => b.metric === "avg_gct_ms");
		expect(gctBaseline?.sampleCount30d).toBe(8);
	});

	it("mixed-pod: insufficient Duo activities → no bilateral baseline", () => {
		// 6 single-pod + 3 Duo → less than 5 Duo activities
		const singlePod = makeActivities(6);
		const duo = makeActivities(3, (i) => ({
			activityId: `duo-${i}`,
			activityDate: `2026-03-${String(i + 10).padStart(2, "0")}`,
			gctAsymmetryPct: 3.0,
		}));
		const all = [...singlePod, ...duo];
		const acute = duo.slice(-2);

		const baselines = computeBaselinesFromData("0", "Run", all, acute);

		// 3 Duo activities < 5 minimum → no bilateral baseline
		const gctAsym = baselines.find((b) => b.metric === "gct_asymmetry_pct");
		expect(gctAsym).toBeUndefined();

		// Unilateral baseline still computed from all 9
		const gctBaseline = baselines.find((b) => b.metric === "avg_gct_ms");
		expect(gctBaseline?.sampleCount30d).toBe(9);
	});
});
