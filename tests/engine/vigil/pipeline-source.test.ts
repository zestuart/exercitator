import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDb, saveVigilMetrics } from "../../../src/db.js";
import { runVigilPipeline } from "../../../src/engine/vigil/index.js";
import type { VigilMetrics, VigilSource } from "../../../src/engine/vigil/types.js";

const REF = new Date("2026-07-12T12:00:00Z");

function metric(
	source: VigilSource,
	activityId: string,
	activityDate: string,
	over: Partial<VigilMetrics> = {},
): VigilMetrics {
	return {
		athleteId: "42",
		source,
		activityId,
		icuActivityId: null,
		activityDate,
		sport: "Run",
		surfaceType: null,
		avgGctMs: null,
		avgLss: null,
		avgFormPower: null,
		avgIlr: null,
		avgVoCm: null,
		avgCadence: null,
		formPowerRatio: null,
		gctDriftPct: null,
		powerHrDrift: null,
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
		...over,
	};
}

/** 10 baseline runs (8–22 days ago) + 2 recent (within 7d) with elevated GCT
 *  and GCT asymmetry, enough to trip a Garmin alert. */
function seedGarminAlert(): void {
	const olderDates = [
		"2026-06-20",
		"2026-06-21",
		"2026-06-22",
		"2026-06-23",
		"2026-06-24",
		"2026-06-25",
		"2026-06-26",
		"2026-06-27",
		"2026-06-28",
		"2026-06-29",
	];
	olderDates.forEach((d, i) =>
		saveVigilMetrics(metric("garmin", `g-old-${i}`, d, { avgGctMs: 285, gctAsymmetryPct: 2.0 })),
	);
	saveVigilMetrics(
		metric("garmin", "g-new-1", "2026-07-10", { avgGctMs: 320, gctAsymmetryPct: 8.0 }),
	);
	saveVigilMetrics(
		metric("garmin", "g-new-2", "2026-07-11", { avgGctMs: 322, gctAsymmetryPct: 8.5 }),
	);
}

describe("runVigilPipeline — per-source combiner", () => {
	beforeEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = ":memory:";
	});
	afterEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = undefined;
	});

	it("reports inactive when no source has data", () => {
		const r = runVigilPipeline("42", "Run", REF);
		expect(r.status).toBe("inactive");
		expect(r.alert.severity).toBe(0);
	});

	it("routes to the Garmin source when only Garmin has runs", () => {
		for (let i = 0; i < 6; i++) {
			const d = `2026-07-0${i + 1}`;
			saveVigilMetrics(metric("garmin", `g-${i}`, d, { avgGctMs: 285 }));
		}
		const r = runVigilPipeline("42", "Run", REF);
		expect(r.source).toBe("garmin");
		expect(r.status).toBe("active");
	});

	it("returns the worst-severity source (Garmin alert beats a silent Stryd)", () => {
		seedGarminAlert();
		const r = runVigilPipeline("42", "Run", REF);
		expect(r.source).toBe("garmin");
		expect(r.alert.severity).toBeGreaterThanOrEqual(2);
		// The bilateral GCT-asymmetry flag contributes to the alert.
		expect(r.alert.flags.some((f) => f.metric === "gct_asymmetry_pct")).toBe(true);
	});

	it("prefers an active source over a building one at equal severity", () => {
		// Stryd: only 3 activities → building. Garmin: 6 → active, no concern.
		for (let i = 0; i < 3; i++) {
			saveVigilMetrics(metric("stryd", `s-${i}`, `2026-07-0${i + 1}`, { avgGctMs: 240 }));
		}
		for (let i = 0; i < 6; i++) {
			saveVigilMetrics(metric("garmin", `g-${i}`, `2026-07-0${i + 1}`, { avgGctMs: 285 }));
		}
		const r = runVigilPipeline("42", "Run", REF);
		expect(r.source).toBe("garmin");
		expect(r.status).toBe("active");
	});
});
