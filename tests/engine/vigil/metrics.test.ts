import { describe, expect, it } from "vitest";
import {
	BILATERAL_METRICS,
	SCOREABLE_METRICS,
	extractScoreableMetrics,
	getMetricValue,
} from "../../../src/engine/vigil/metrics.js";
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

describe("extractScoreableMetrics", () => {
	it("extracts all non-null unilateral metrics", () => {
		const m = makeVigilMetrics();
		const values = extractScoreableMetrics(m);

		// Should have all unilateral scoreable metrics
		const names = values.map((v) => v.metric);
		expect(names).toContain("avg_gct_ms");
		expect(names).toContain("avg_lss");
		expect(names).toContain("form_power_ratio");
		expect(names).toContain("avg_ilr");
		expect(names).toContain("gct_drift_pct");
		expect(names).toContain("power_hr_drift");

		// No bilateral metrics (all null)
		for (const bm of BILATERAL_METRICS) {
			expect(names).not.toContain(bm);
		}
	});

	it("excludes null metrics", () => {
		const m = makeVigilMetrics({ avgIlr: null, gctDriftPct: null });
		const values = extractScoreableMetrics(m);
		const names = values.map((v) => v.metric);

		expect(names).not.toContain("avg_ilr");
		expect(names).not.toContain("gct_drift_pct");
		// Others still present
		expect(names).toContain("avg_gct_ms");
	});

	it("includes bilateral metrics when present", () => {
		const m = makeVigilMetrics({
			gctAsymmetryPct: 4.2,
			lssAsymmetryPct: 3.1,
		});
		const values = extractScoreableMetrics(m);
		const names = values.map((v) => v.metric);

		expect(names).toContain("gct_asymmetry_pct");
		expect(names).toContain("lss_asymmetry_pct");
	});

	it("returns correct values", () => {
		const m = makeVigilMetrics();
		const values = extractScoreableMetrics(m);
		const gct = values.find((v) => v.metric === "avg_gct_ms");
		expect(gct?.value).toBeCloseTo(235, 0);
	});
});

describe("getMetricValue", () => {
	it("returns value for known metric", () => {
		const m = makeVigilMetrics();
		expect(getMetricValue(m, "avg_gct_ms")).toBeCloseTo(235, 0);
		expect(getMetricValue(m, "avg_lss")).toBeCloseTo(10.5, 1);
	});

	it("returns null for null metric", () => {
		const m = makeVigilMetrics({ avgIlr: null });
		expect(getMetricValue(m, "avg_ilr")).toBeNull();
	});

	it("returns null for unknown metric name", () => {
		const m = makeVigilMetrics();
		expect(getMetricValue(m, "not_a_metric")).toBeNull();
	});
});

describe("SCOREABLE_METRICS", () => {
	it("includes all expected unilateral metrics", () => {
		expect(SCOREABLE_METRICS).toContain("avg_gct_ms");
		expect(SCOREABLE_METRICS).toContain("avg_lss");
		expect(SCOREABLE_METRICS).toContain("form_power_ratio");
		expect(SCOREABLE_METRICS).toContain("avg_ilr");
		expect(SCOREABLE_METRICS).toContain("gct_drift_pct");
		expect(SCOREABLE_METRICS).toContain("power_hr_drift");
	});

	it("includes bilateral metrics", () => {
		for (const bm of BILATERAL_METRICS) {
			expect(SCOREABLE_METRICS).toContain(bm);
		}
	});
});
