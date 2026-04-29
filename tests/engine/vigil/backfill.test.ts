import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDb, saveVigilMetrics } from "../../../src/db.js";
import {
	_resetVigilSyncDebounceForTesting,
	runVigilBackfillIfNeeded,
} from "../../../src/engine/vigil/backfill.js";
import type { VigilMetrics } from "../../../src/engine/vigil/types.js";
import type { StrydActivity, StrydClient } from "../../../src/stryd/client.js";

function makeStrydActivity(overrides: Partial<StrydActivity> = {}): StrydActivity {
	return {
		id: 1,
		// 2026-04-29 00:00:00 UTC
		timestamp: 1782950400,
		distance: 5000,
		elapsed_time: 1800,
		average_power: 240,
		...overrides,
	};
}

function makeMetrics(activityId: string, athleteId: string): VigilMetrics {
	return {
		athleteId,
		activityId,
		icuActivityId: null,
		activityDate: "2026-04-15",
		sport: "Run",
		surfaceType: null,
		avgGctMs: 240,
		avgLss: 10,
		avgFormPower: 60,
		avgIlr: 11,
		avgVoCm: 8,
		avgCadence: 180,
		formPowerRatio: 0.25,
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
	};
}

interface FakeStrydClient extends StrydClient {
	listActivitiesCalls: Array<{ days: number }>;
	downloadFitCalls: number[];
}

function makeFakeStryd(activities: StrydActivity[]): FakeStrydClient {
	const calls: Array<{ days: number }> = [];
	const downloads: number[] = [];
	const fake: Partial<FakeStrydClient> = {
		isAuthenticated: true,
		login: vi.fn().mockResolvedValue(undefined),
		listActivities: vi.fn(async (days: number) => {
			calls.push({ days });
			return activities;
		}),
		downloadFit: vi.fn(async (id: number) => {
			downloads.push(id);
			// Return an empty buffer — fit-parser will throw, processStrydActivity
			// catches the error and skips. That's the behaviour we want to assert on:
			// listActivities IS called even when no metrics are saved.
			return Buffer.alloc(0);
		}),
		listActivitiesCalls: calls,
		downloadFitCalls: downloads,
	};
	return fake as FakeStrydClient;
}

describe("runVigilBackfillIfNeeded", () => {
	beforeEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = ":memory:";
		_resetVigilSyncDebounceForTesting();
	});

	afterEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = undefined;
		vi.clearAllMocks();
	});

	it("runs a 90-day backfill on first encounter (no metrics in DB)", async () => {
		const stryd = makeFakeStryd([makeStrydActivity()]);
		await runVigilBackfillIfNeeded(stryd, "athlete-1");
		expect(stryd.listActivitiesCalls).toEqual([{ days: 90 }]);
	});

	it("falls back to a 14-day incremental sync once the baseline exists", async () => {
		// Seed any metric so hasAnyVigilMetrics returns true.
		saveVigilMetrics(makeMetrics("seed-1", "athlete-2"));

		const stryd = makeFakeStryd([makeStrydActivity({ id: 999 })]);
		await runVigilBackfillIfNeeded(stryd, "athlete-2");

		expect(stryd.listActivitiesCalls).toEqual([{ days: 14 }]);
	});

	it("debounces incremental sync to once per UTC day per athlete", async () => {
		saveVigilMetrics(makeMetrics("seed-1", "athlete-3"));

		const stryd = makeFakeStryd([makeStrydActivity({ id: 999 })]);
		await runVigilBackfillIfNeeded(stryd, "athlete-3");
		await runVigilBackfillIfNeeded(stryd, "athlete-3");

		expect(stryd.listActivitiesCalls).toHaveLength(1);
	});

	it("re-runs incremental sync after the debounce is cleared", async () => {
		saveVigilMetrics(makeMetrics("seed-1", "athlete-4"));

		const stryd = makeFakeStryd([makeStrydActivity({ id: 999 })]);
		await runVigilBackfillIfNeeded(stryd, "athlete-4");
		_resetVigilSyncDebounceForTesting();
		await runVigilBackfillIfNeeded(stryd, "athlete-4");

		expect(stryd.listActivitiesCalls).toHaveLength(2);
	});

	it("is a no-op when no Stryd client is configured", async () => {
		await expect(runVigilBackfillIfNeeded(null, "athlete-5")).resolves.toBeUndefined();
	});
});
