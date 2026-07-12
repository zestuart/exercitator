import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	extractGarminMetrics,
	hasGarminRunningDynamics,
} from "../../../src/engine/vigil/garmin-fit.js";

// biome-ignore lint/suspicious/noExplicitAny: FIT records are untyped
type FitRecord = Record<string, any>;

/** Real ze Garmin trail-run (activity 23572046674), parsed records, GPS stripped.
 *  See tests/fixtures/garmin/garmin-run-records.json.gz. */
function loadFixture(): FitRecord[] {
	const path = join(__dirname, "..", "..", "fixtures", "garmin", "garmin-run-records.json.gz");
	return JSON.parse(gunzipSync(readFileSync(path)).toString("utf-8")) as FitRecord[];
}

describe("extractGarminMetrics", () => {
	const records = loadFixture();

	it("detects Garmin native running dynamics", () => {
		expect(hasGarminRunningDynamics(records)).toBe(true);
		expect(hasGarminRunningDynamics([])).toBe(false);
		expect(hasGarminRunningDynamics([{ heart_rate: 150, power: 300 }])).toBe(false);
	});

	it("extracts the Garmin metric subset from a real run FIT", () => {
		const m = extractGarminMetrics("23572046674", "2026-07-12", records, "Run", null, "42");
		expect(m).not.toBeNull();
		if (!m) return;

		expect(m.source).toBe("garmin");
		expect(m.sport).toBe("Run");
		expect(m.activityId).toBe("23572046674");
		expect(m.athleteId).toBe("42");

		// Native running dynamics (verified against the raw FIT).
		expect(m.avgGctMs).toBeCloseTo(287.6, 0);
		expect(m.avgVoCm).toBeCloseTo(9.43, 1);
		expect(m.avgCadence).toBeCloseTo(158.9, 0); // (cadence + fractional) × 2 → full spm
		expect(m.gctAsymmetryPct).toBeCloseTo(1.87, 1); // from native stance_time_balance
		expect(m.gctDriftPct).toBeCloseTo(0.85, 0);
		expect(m.powerHrDrift).toBeCloseTo(19.5, 0); // native power vs HR

		// Four scoreable metrics → above the ≥2-metric alert gate.
		const scoreable = [m.avgGctMs, m.gctDriftPct, m.powerHrDrift, m.gctAsymmetryPct];
		expect(scoreable.every((v) => v != null)).toBe(true);
	});

	it("leaves Stryd-only channels null (no CIQ developer fields on a Garmin FIT)", () => {
		const m = extractGarminMetrics("23572046674", "2026-07-12", records);
		expect(m).not.toBeNull();
		if (!m) return;

		expect(m.avgLss).toBeNull();
		expect(m.avgFormPower).toBeNull();
		expect(m.formPowerRatio).toBeNull();
		expect(m.avgIlr).toBeNull();
		expect(m.strydRpe).toBeNull();
		expect(m.strydFeel).toBeNull();
		// Only GCT asymmetry is bilateral on Garmin; LSS/VO/ILR asymmetry stay null.
		expect(m.lssAsymmetryPct).toBeNull();
		expect(m.voAsymmetryPct).toBeNull();
		expect(m.ilrAsymmetryPct).toBeNull();
		expect(m.lAvgGctMs).toBeNull();
		expect(m.rAvgGctMs).toBeNull();
	});

	it("returns null for empty, too-short, or too-long records", () => {
		expect(extractGarminMetrics("x", "2026-07-12", [])).toBeNull();
		expect(extractGarminMetrics("x", "2026-07-12", records.slice(0, 50))).toBeNull();
		// Above MAX_RECORDS (200k) — hostile/expanded FIT is rejected before any map.
		const huge = Array.from({ length: 200_001 }, () => ({ stance_time: 300 }));
		expect(extractGarminMetrics("x", "2026-07-12", huge)).toBeNull();
	});

	it("returns null when running dynamics are absent", () => {
		const noDynamics = Array.from({ length: 300 }, () => ({ heart_rate: 150, power: 300 }));
		expect(extractGarminMetrics("x", "2026-07-12", noDynamics)).toBeNull();
	});
});
