import { describe, expect, it } from "vitest";
import {
	extractMetrics,
	hasBilateralFields,
	hasStrydDeveloperFields,
} from "../../../src/engine/vigil/fit-parser.js";
import { STRYD_FIT_FIELDS } from "../../../src/engine/vigil/types.js";

// ---------------------------------------------------------------------------
// Helpers to generate fake per-second records
// ---------------------------------------------------------------------------

function makeRecord(
	overrides: Record<string, number | null> = {},
	elapsed = 0,
): Record<string, unknown> {
	return {
		timestamp: new Date("2026-03-20T08:00:00Z"),
		elapsed_time: elapsed,
		heart_rate: 145,
		[STRYD_FIT_FIELDS.cadence]: 180,
		[STRYD_FIT_FIELDS.stanceTime]: 235,
		[STRYD_FIT_FIELDS.legSpringStiffness]: 10.5,
		[STRYD_FIT_FIELDS.formPower]: 65,
		[STRYD_FIT_FIELDS.impact]: 12.3,
		[STRYD_FIT_FIELDS.verticalOscillation]: 82, // mm (8.2 cm)
		[STRYD_FIT_FIELDS.power]: 280,
		...overrides,
	};
}

function makeDuoRecord(
	overrides: Record<string, number | null> = {},
	elapsed = 0,
): Record<string, unknown> {
	return {
		...makeRecord({}, elapsed),
		// Duo balance fields: % left foot (50 = symmetric)
		[STRYD_FIT_FIELDS.gctBalance]: 48.5,
		[STRYD_FIT_FIELDS.lssBalance]: 52.0,
		[STRYD_FIT_FIELDS.voBalance]: 50.0,
		[STRYD_FIT_FIELDS.ilrBalance]: 47.0,
		...overrides,
	};
}

function makeRecords(
	n: number,
	overrideFn?: (i: number, total: number) => Record<string, number | null>,
): Record<string, unknown>[] {
	return Array.from({ length: n }, (_, i) => makeRecord(overrideFn?.(i, n) ?? {}, i));
}

function makeDuoRecords(
	n: number,
	overrideFn?: (i: number, total: number) => Record<string, number | null>,
): Record<string, unknown>[] {
	return Array.from({ length: n }, (_, i) => makeDuoRecord(overrideFn?.(i, n) ?? {}, i));
}

// ---------------------------------------------------------------------------
// hasStrydDeveloperFields
// ---------------------------------------------------------------------------

describe("hasStrydDeveloperFields", () => {
	it("returns true when Stryd fields are present", () => {
		expect(hasStrydDeveloperFields([makeRecord()])).toBe(true);
	});

	it("returns false for empty records", () => {
		expect(hasStrydDeveloperFields([])).toBe(false);
	});

	it("returns false when no Stryd fields present", () => {
		const records = [{ timestamp: new Date(), heart_rate: 140, cadence: 175 }];
		expect(hasStrydDeveloperFields(records)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// hasBilateralFields
// ---------------------------------------------------------------------------

describe("hasBilateralFields", () => {
	it("returns true for Duo records", () => {
		expect(hasBilateralFields([makeDuoRecord()])).toBe(true);
	});

	it("returns false for single-pod records", () => {
		expect(hasBilateralFields([makeRecord()])).toBe(false);
	});

	it("returns false for empty records", () => {
		expect(hasBilateralFields([])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// extractMetrics — normal run (single pod)
// ---------------------------------------------------------------------------

describe("extractMetrics", () => {
	it("returns null for non-Stryd records", () => {
		const records = makeRecords(200).map((r) => {
			const clean = { ...r };
			delete clean[STRYD_FIT_FIELDS.stanceTime];
			delete clean[STRYD_FIT_FIELDS.legSpringStiffness];
			delete clean[STRYD_FIT_FIELDS.formPower];
			return clean;
		});
		expect(extractMetrics("1", "2026-03-20", records, "Run")).toBeNull();
	});

	it("returns null for too few records", () => {
		expect(extractMetrics("1", "2026-03-20", makeRecords(50), "Run")).toBeNull();
	});

	it("extracts averages from a normal run", () => {
		const records = makeRecords(600);
		const result = extractMetrics("42", "2026-03-20", records, "Run", 6, "Good", "Road", "icu-123");

		expect(result).not.toBeNull();
		expect(result?.activityId).toBe("42");
		expect(result?.icuActivityId).toBe("icu-123");
		expect(result?.surfaceType).toBe("Road");
		expect(result?.strydRpe).toBe(6);
		expect(result?.strydFeel).toBe("Good");

		expect(result?.avgGctMs).toBeCloseTo(235, 0);
		expect(result?.avgLss).toBeCloseTo(10.5, 1);
		expect(result?.avgFormPower).toBeCloseTo(65, 0);
		expect(result?.avgIlr).toBeCloseTo(12.3, 1);
		// VO: 82mm → 8.2cm
		expect(result?.avgVoCm).toBeCloseTo(8.2, 1);
		expect(result?.avgCadence).toBeCloseTo(180, 0);
		expect(result?.formPowerRatio).toBeCloseTo(65 / 280, 3);
	});

	it("computes zero GCT drift for uniform records", () => {
		const result = extractMetrics("1", "2026-03-20", makeRecords(600), "Run");
		expect(result?.gctDriftPct).toBeCloseTo(0, 1);
	});

	it("sets bilateral fields to null (single pod)", () => {
		const result = extractMetrics("1", "2026-03-20", makeRecords(600), "Run");
		expect(result?.lAvgGctMs).toBeNull();
		expect(result?.rAvgGctMs).toBeNull();
		expect(result?.gctAsymmetryPct).toBeNull();
		expect(result?.lssAsymmetryPct).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// extractMetrics — fatigued run (elevated drift)
// ---------------------------------------------------------------------------

describe("extractMetrics — fatigued run", () => {
	it("detects positive GCT drift when GCT increases over time", () => {
		const records = makeRecords(600, (i, total) => ({
			[STRYD_FIT_FIELDS.stanceTime]: 230 + (30 * i) / (total - 1),
		}));

		const result = extractMetrics("1", "2026-03-20", records, "Run");
		expect(result?.gctDriftPct).toBeGreaterThan(5);
		expect(result?.gctDriftPct).toBeLessThan(15);
	});

	it("detects power:HR drift when HR rises relative to power", () => {
		const records = makeRecords(1200, (i, total) => ({
			heart_rate: 140 + (35 * i) / (total - 1),
			[STRYD_FIT_FIELDS.power]: 280,
		}));

		const result = extractMetrics("1", "2026-03-20", records, "Run");
		expect(result?.powerHrDrift).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// extractMetrics — partial data
// ---------------------------------------------------------------------------

describe("extractMetrics — partial data", () => {
	it("handles missing Impact gracefully", () => {
		const records = makeRecords(600, () => ({
			[STRYD_FIT_FIELDS.impact]: null,
		}));
		const result = extractMetrics("1", "2026-03-20", records, "Run");
		expect(result?.avgIlr).toBeNull();
		expect(result?.avgGctMs).toBeCloseTo(235, 0);
	});

	it("handles missing Form Power gracefully", () => {
		const records = makeRecords(600, () => ({
			[STRYD_FIT_FIELDS.formPower]: null,
		}));
		const result = extractMetrics("1", "2026-03-20", records, "Run");
		expect(result?.avgFormPower).toBeNull();
		expect(result?.formPowerRatio).toBeNull();
	});

	it("handles missing HR for power:HR drift", () => {
		const records = makeRecords(600, () => ({ heart_rate: null }));
		const result = extractMetrics("1", "2026-03-20", records, "Run");
		expect(result?.powerHrDrift).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// extractMetrics — Duo bilateral data
// ---------------------------------------------------------------------------

describe("extractMetrics — Duo bilateral", () => {
	it("extracts asymmetry from balance fields", () => {
		// GCT balance 48.5% → asymmetry = |48.5 - 50| × 2 = 3.0%
		// LSS balance 52.0% → asymmetry = |52.0 - 50| × 2 = 4.0%
		// VO balance 50.0% → asymmetry = 0%
		// ILR balance 47.0% → asymmetry = |47.0 - 50| × 2 = 6.0%
		const records = makeDuoRecords(600);
		const result = extractMetrics("1", "2026-03-20", records, "Run");

		expect(result?.gctAsymmetryPct).toBeCloseTo(3.0, 1);
		expect(result?.lssAsymmetryPct).toBeCloseTo(4.0, 1);
		expect(result?.voAsymmetryPct).toBeCloseTo(0.0, 1);
		expect(result?.ilrAsymmetryPct).toBeCloseTo(6.0, 1);
	});

	it("derives L/R values from total × balance", () => {
		// GCT 235ms, balance 48.5% → L = 235 × 0.485 = 113.975, R = 235 × 0.515 = 121.025
		const records = makeDuoRecords(600);
		const result = extractMetrics("1", "2026-03-20", records, "Run");

		expect(result?.lAvgGctMs).toBeCloseTo(235 * 0.485, 0);
		expect(result?.rAvgGctMs).toBeCloseTo(235 * 0.515, 0);

		// LSS 10.5, balance 52% → L = 5.46, R = 5.04
		expect(result?.lAvgLss).toBeCloseTo(10.5 * 0.52, 1);
		expect(result?.rAvgLss).toBeCloseTo(10.5 * 0.48, 1);
	});

	it("handles symmetric balance (50%)", () => {
		const records = makeDuoRecords(600, () => ({
			[STRYD_FIT_FIELDS.gctBalance]: 50.0,
			[STRYD_FIT_FIELDS.lssBalance]: 50.0,
			[STRYD_FIT_FIELDS.voBalance]: 50.0,
			[STRYD_FIT_FIELDS.ilrBalance]: 50.0,
		}));
		const result = extractMetrics("1", "2026-03-20", records, "Run");

		expect(result?.gctAsymmetryPct).toBeCloseTo(0, 1);
		expect(result?.lssAsymmetryPct).toBeCloseTo(0, 1);
		expect(result?.lAvgGctMs).toBeCloseTo(result?.rAvgGctMs ?? 0, 0);
	});

	it("handles developing asymmetry over time", () => {
		// LSS balance drifts from 50% to 58% (left-dominant)
		const records = makeDuoRecords(600, (i, total) => ({
			[STRYD_FIT_FIELDS.lssBalance]: 50 + (8 * i) / (total - 1),
		}));
		const result = extractMetrics("1", "2026-03-20", records, "Run");

		// Average balance ≈ 54% → asymmetry ≈ 8%
		expect(result?.lssAsymmetryPct).toBeGreaterThan(6);
		expect(result?.lssAsymmetryPct).toBeLessThan(10);
	});

	it("unilateral metrics still computed alongside bilateral", () => {
		const records = makeDuoRecords(600);
		const result = extractMetrics("1", "2026-03-20", records, "Run");

		// Unilateral averages should be the same as single-pod
		expect(result?.avgGctMs).toBeCloseTo(235, 0);
		expect(result?.avgLss).toBeCloseTo(10.5, 1);
		expect(result?.formPowerRatio).toBeCloseTo(65 / 280, 3);
	});
});
