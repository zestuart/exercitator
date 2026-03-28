import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetDb,
	countVigilMetrics,
	getVigilBaselines,
	getVigilMetrics,
	hasVigilMetrics,
	saveVigilBaseline,
	saveVigilMetrics,
} from "../../../src/db.js";
import type { VigilBaseline, VigilMetrics } from "../../../src/engine/vigil/types.js";

// Use in-memory DB for tests
const TEST_DB_PATH = ":memory:";

function makeMetrics(overrides: Partial<VigilMetrics> = {}): VigilMetrics {
	return {
		activityId: "stryd-100",
		icuActivityId: "icu-200",
		activityDate: "2026-03-20",
		sport: "Run",
		surfaceType: "Road",
		avgGctMs: 235,
		avgLss: 10.5,
		avgFormPower: 65,
		avgIlr: 12.3,
		avgVoCm: 8.2,
		avgCadence: 180,
		formPowerRatio: 0.232,
		gctDriftPct: 3.5,
		powerHrDrift: 2.1,
		strydRpe: 6,
		strydFeel: "Good",
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

// We need to set the env var before importing db.ts in the actual test,
// but since db.ts is already imported, we test the functions directly
// with the real DB (which creates tables on first getDb() call).

describe("Vigil DB helpers", () => {
	beforeEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = ":memory:";
	});

	afterEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = undefined;
	});

	it("saves and retrieves Vigil metrics", () => {
		// Force fresh DB by resetting the module-level singleton
		// This is a pragmatic approach for testing — the DB path changes per test
		const m = makeMetrics();
		saveVigilMetrics(m);

		expect(hasVigilMetrics("stryd-100")).toBe(true);
		expect(hasVigilMetrics("stryd-999")).toBe(false);

		const results = getVigilMetrics("Run", "2026-03-01", "2026-03-31");
		expect(results.length).toBe(1);
		expect(results[0].activityId).toBe("stryd-100");
		expect(results[0].avgGctMs).toBeCloseTo(235, 0);
		expect(results[0].strydRpe).toBe(6);
		expect(results[0].strydFeel).toBe("Good");
		expect(results[0].surfaceType).toBe("Road");
		expect(results[0].lAvgGctMs).toBeNull();
	});

	it("counts metrics in date range", () => {
		saveVigilMetrics(makeMetrics({ activityId: "s-1", activityDate: "2026-03-15" }));
		saveVigilMetrics(makeMetrics({ activityId: "s-2", activityDate: "2026-03-20" }));
		saveVigilMetrics(makeMetrics({ activityId: "s-3", activityDate: "2026-03-25" }));

		expect(countVigilMetrics("Run", "2026-03-01", "2026-03-31")).toBe(3);
		expect(countVigilMetrics("Run", "2026-03-18", "2026-03-22")).toBe(1);
		expect(countVigilMetrics("Swim", "2026-03-01", "2026-03-31")).toBe(0);
	});

	it("upserts metrics on conflict", () => {
		saveVigilMetrics(makeMetrics({ avgGctMs: 230 }));
		saveVigilMetrics(makeMetrics({ avgGctMs: 240 }));

		const results = getVigilMetrics("Run", "2026-03-01", "2026-03-31");
		expect(results.length).toBe(1);
		expect(results[0].avgGctMs).toBeCloseTo(240, 0);
	});

	it("saves and retrieves baselines", () => {
		const baseline: VigilBaseline = {
			sport: "Run",
			metric: "avg_gct_ms",
			computedAt: new Date().toISOString(),
			mean30d: 235,
			stddev30d: 8.5,
			mean7d: 242,
			sampleCount30d: 12,
			sampleCount7d: 3,
		};

		saveVigilBaseline(baseline);

		const baselines = getVigilBaselines("Run");
		expect(baselines.length).toBe(1);
		expect(baselines[0].metric).toBe("avg_gct_ms");
		expect(baselines[0].mean30d).toBeCloseTo(235, 0);
		expect(baselines[0].stddev30d).toBeCloseTo(8.5, 1);
		expect(baselines[0].mean7d).toBeCloseTo(242, 0);
		expect(baselines[0].sampleCount30d).toBe(12);
		expect(baselines[0].sampleCount7d).toBe(3);
	});

	it("upserts baselines on conflict", () => {
		const b1: VigilBaseline = {
			sport: "Run",
			metric: "avg_gct_ms",
			computedAt: new Date().toISOString(),
			mean30d: 235,
			stddev30d: 8.5,
			mean7d: 242,
			sampleCount30d: 12,
			sampleCount7d: 3,
		};

		const b2: VigilBaseline = {
			...b1,
			mean30d: 237,
			mean7d: 245,
			sampleCount30d: 15,
		};

		saveVigilBaseline(b1);
		saveVigilBaseline(b2);

		const baselines = getVigilBaselines("Run");
		expect(baselines.length).toBe(1);
		expect(baselines[0].mean30d).toBeCloseTo(237, 0);
		expect(baselines[0].sampleCount30d).toBe(15);
	});
});
