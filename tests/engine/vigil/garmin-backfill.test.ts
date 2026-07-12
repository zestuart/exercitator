import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: FIT records are untyped
type FitRecord = Record<string, any>;

const FIXTURE: FitRecord[] = JSON.parse(
	gunzipSync(
		readFileSync(join(__dirname, "..", "..", "fixtures", "garmin", "garmin-run-records.json.gz")),
	).toString("utf-8"),
);

// Stub the FIT binary parse so the backfill runs the REAL extractor on real
// records without needing raw FIT bytes (which carry home GPS).
vi.mock("../../../src/engine/vigil/fit-parser.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/engine/vigil/fit-parser.js")>();
	return { ...actual, parseFitBuffer: vi.fn(async () => FIXTURE) };
});

import { _resetDb, getVigilMetrics } from "../../../src/db.js";
import {
	_resetGarminVigilSyncDebounceForTesting,
	runGarminVigilBackfillIfNeeded,
} from "../../../src/engine/vigil/garmin-backfill.js";
import type { GarminActivity, GarminClient } from "../../../src/garmin/client.js";

function makeClient(activities: GarminActivity[]) {
	const getActivityFit = vi.fn(async () => Buffer.from([0]));
	const client = {
		getActivities: vi.fn(async () => activities),
		getActivityFit,
	} as unknown as GarminClient;
	return { client, getActivityFit };
}

const RUNS: GarminActivity[] = [
	{
		id: 1,
		name: "AM",
		sport: "running",
		start_local: "2026-07-10T08:00:00",
		start_gmt: null,
		duration_s: 2000,
	},
	{
		id: 2,
		name: "Trail",
		sport: "trail_running",
		start_local: "2026-07-12T15:07:14",
		start_gmt: null,
		duration_s: 4389,
	},
	{
		id: 3,
		name: "Ride",
		sport: "cycling",
		start_local: "2026-07-11T09:00:00",
		start_gmt: null,
		duration_s: 3600,
	},
];

describe("runGarminVigilBackfillIfNeeded", () => {
	beforeEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = ":memory:";
		_resetGarminVigilSyncDebounceForTesting();
	});

	afterEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = undefined;
		vi.clearAllMocks();
	});

	it("no-ops without a Garmin client", async () => {
		await runGarminVigilBackfillIfNeeded(null, "42");
		expect(getVigilMetrics("42", "Run", "2026-01-01", "2026-12-31").length).toBe(0);
	});

	it("processes only runs and records Garmin-source metrics", async () => {
		const { client, getActivityFit } = makeClient(RUNS);
		await runGarminVigilBackfillIfNeeded(client, "42");

		// Cycling ignored → FIT downloaded only for the two runs.
		expect(getActivityFit).toHaveBeenCalledTimes(2);
		expect(getActivityFit).toHaveBeenCalledWith(1);
		expect(getActivityFit).toHaveBeenCalledWith(2);
		expect(getActivityFit).not.toHaveBeenCalledWith(3);

		const rows = getVigilMetrics("42", "Run", "2026-01-01", "2026-12-31");
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.source === "garmin")).toBe(true);
		expect(rows.map((r) => r.activityDate).sort()).toEqual(["2026-07-10", "2026-07-12"]);
		// Real extraction ran: native GCT present, Stryd-only fields null.
		expect(rows[0].avgGctMs).toBeGreaterThan(0);
		expect(rows[0].avgLss).toBeNull();
	});

	it("dedupes already-processed activities on a second pass", async () => {
		const { client: c1 } = makeClient(RUNS);
		await runGarminVigilBackfillIfNeeded(c1, "42");

		_resetGarminVigilSyncDebounceForTesting(); // bypass the daily debounce
		const { client: c2, getActivityFit } = makeClient(RUNS);
		await runGarminVigilBackfillIfNeeded(c2, "42");

		// Both runs already in vigil_metrics → no re-download.
		expect(getActivityFit).not.toHaveBeenCalled();
		expect(getVigilMetrics("42", "Run", "2026-01-01", "2026-12-31").length).toBe(2);
	});
});
