import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { suggestWorkout, suggestWorkoutFromData } from "../../src/engine/suggest.js";
import type { IntervalsClient } from "../../src/intervals.js";

function loadFixture(name: string): unknown {
	const raw = readFileSync(resolve(__dirname, "../fixtures", name), "utf-8");
	return JSON.parse(raw);
}

function createMockClient(): IntervalsClient {
	const activities = loadFixture("activities-14d.json");
	const wellness = loadFixture("wellness-7d.json");
	const runSettings = loadFixture("sport-settings-run.json");
	const swimSettings = loadFixture("sport-settings-swim.json");

	const mockGet = vi.fn().mockImplementation((path: string) => {
		if (path.includes("/activities")) return Promise.resolve(activities);
		if (path.includes("/wellness")) return Promise.resolve(wellness);
		if (path.includes("sport-settings/Run")) return Promise.resolve(runSettings);
		if (path.includes("sport-settings/Swim")) return Promise.resolve(swimSettings);
		return Promise.reject(new Error(`Unexpected path: ${path}`));
	});

	return {
		athleteId: "0",
		get: mockGet,
		put: vi.fn(),
		post: vi.fn(),
		delete: vi.fn(),
		request: vi.fn(),
	} as unknown as IntervalsClient;
}

describe("suggestWorkout integration", () => {
	it("produces a valid WorkoutSuggestion from fixture data", async () => {
		const client = createMockClient();
		const result = await suggestWorkout(client);

		// Required fields are populated
		expect(result.sport).toMatch(/^(Run|Swim)$/);
		expect(result.category).toBeDefined();
		expect(result.title).toBeTruthy();
		expect(result.rationale).toBeTruthy();
		expect(result.readiness_score).toBeGreaterThanOrEqual(0);
		expect(result.readiness_score).toBeLessThanOrEqual(100);
		expect(result.sport_selection_reason).toBeTruthy();
		expect(Array.isArray(result.warnings)).toBe(true);
	});

	it("produces segments that sum to total_duration_secs", async () => {
		const client = createMockClient();
		const result = await suggestWorkout(client);

		if (result.category === "rest") {
			expect(result.segments).toHaveLength(0);
			expect(result.total_duration_secs).toBe(0);
		} else {
			expect(result.segments.length).toBeGreaterThan(0);
			const segmentTotal = result.segments.reduce((s, seg) => s + seg.duration_secs, 0);
			expect(segmentTotal).toBe(result.total_duration_secs);
		}
	});

	it("calls all four API endpoints", async () => {
		const client = createMockClient();
		await suggestWorkout(client);

		expect(client.get).toHaveBeenCalledTimes(4);
	});

	it("includes power_context in the result", async () => {
		const client = createMockClient();
		const result = await suggestWorkout(client);

		expect(result.power_context).toBeDefined();
		expect(result.power_context.source).toMatch(/^(stryd|garmin|none)$/);
		expect(typeof result.power_context.ftp).toBe("number");
		expect(typeof result.power_context.correction_factor).toBe("number");
		expect(result.power_context.confidence).toMatch(/^(high|low)$/);
	});

	it("includes terrain in the result", async () => {
		const client = createMockClient();
		const result = await suggestWorkout(client);

		expect(result.terrain).toMatch(/^(flat|rolling|hilly|trail|pool|any)$/);
		expect(result.terrain_rationale).toBeTruthy();
	});

	it("detects Stryd power source from fixture activities", async () => {
		const client = createMockClient();
		const result = await suggestWorkout(client);

		// The fixture data includes runs with Stryd streams (Power, StrydLSS, etc.)
		expect(result.power_context.source).toBe("stryd");
		expect(result.power_context.ftp).toBeGreaterThan(0);
	});

	it("overrides FTP with Stryd CP when provided", () => {
		const data = {
			activities: loadFixture("activities-14d.json"),
			wellness: loadFixture("wellness-7d.json"),
			runSettings: loadFixture("sport-settings-run.json"),
			swimSettings: loadFixture("sport-settings-swim.json"),
		};

		// Without CP override — uses intervals.icu FTP (322 from fixtures)
		const withoutCp = suggestWorkoutFromData(data as never, "Run");
		expect(withoutCp.power_context.ftp).toBe(322);

		// With fresh CP override — uses Stryd CP
		const withCp = suggestWorkoutFromData(data as never, "Run", new Date(), undefined, {
			cp: 279.45,
			ageDays: 5,
		});
		expect(withCp.power_context.ftp).toBe(279);
		expect(withCp.power_context.rolling_ftp).toBe(279);
		expect(withCp.power_context.source).toBe("stryd");
	});

	it("resolves FTP by the effective power source (Garmin → intervals, Stryd → CP)", () => {
		const data = {
			activities: loadFixture("activities-14d.json"),
			wellness: loadFixture("wellness-7d.json"),
			runSettings: loadFixture("sport-settings-run.json"),
			swimSettings: loadFixture("sport-settings-swim.json"),
		};

		// Force Garmin: FTP comes from intervals.icu (322 in the fixtures), NOT the
		// Stryd CP — no cross-scale factor.
		const forcedGarmin = suggestWorkoutFromData(
			data as never,
			"Run",
			new Date(),
			undefined,
			{ cp: 279.45, ageDays: 5 },
			"0",
			undefined,
			"garmin",
		);
		expect(forcedGarmin.power_context.source).toBe("garmin");
		expect(forcedGarmin.power_context.ftp).toBe(322); // intervals FTP, not ÷0.87 of CP
		expect(forcedGarmin.power_context.correction_factor).toBe(1.0);
		expect(forcedGarmin.powerSourceOverride).toBe("garmin");

		// Force Stryd: FTP from the Stryd critical power (279.45 → 279).
		const forcedStryd = suggestWorkoutFromData(
			data as never,
			"Run",
			new Date(),
			undefined,
			{ cp: 279.45, ageDays: 5 },
			"0",
			undefined,
			"stryd",
		);
		expect(forcedStryd.power_context.source).toBe("stryd");
		expect(forcedStryd.power_context.ftp).toBe(279);
		expect(forcedStryd.power_context.correction_factor).toBe(1.0);
		expect(forcedStryd.powerSourceOverride).toBe("stryd");
	});

	it("forces Garmin: FTP from intervals.icu even without a Stryd CP", () => {
		const data = {
			activities: loadFixture("activities-14d.json"),
			wellness: loadFixture("wellness-7d.json"),
			runSettings: loadFixture("sport-settings-run.json"),
			swimSettings: loadFixture("sport-settings-swim.json"),
		};
		// Fixtures carry intervals FTP 322 → Garmin mode uses it directly.
		const forced = suggestWorkoutFromData(
			data as never,
			"Run",
			new Date(),
			undefined,
			undefined,
			"0",
			undefined,
			"garmin",
		);
		expect(forced.power_context.source).toBe("garmin");
		expect(forced.power_context.ftp).toBe(322); // intervals FTP
	});

	it("leaves auto detection untouched when no override is passed", () => {
		const data = {
			activities: loadFixture("activities-14d.json"),
			wellness: loadFixture("wellness-7d.json"),
			runSettings: loadFixture("sport-settings-run.json"),
			swimSettings: loadFixture("sport-settings-swim.json"),
		};
		const auto = suggestWorkoutFromData(data as never, "Run");
		expect(auto.power_context.source).toBe("stryd");
		expect(auto.power_context.ftp).toBe(322);
		expect(auto.powerSourceOverride).toBeUndefined();
	});

	it("short-circuits to already_trained when a Run already exists today", () => {
		const now = new Date("2026-05-27T18:00:00-07:00");
		const todayLocal = "2026-05-27T07:51:34";
		const data = {
			activities: [
				{
					id: "i151968721",
					start_date_local: todayLocal,
					type: "Run",
					moving_time: 2262,
					distance: 6203.77,
					icu_training_load: 54,
					icu_atl: 38.9,
					icu_ctl: 25.7,
					average_heartrate: 145,
					max_heartrate: 159,
					icu_hr_zone_times: null,
					perceived_exertion: 3,
					power_load: 54,
					hr_load: 43,
					icu_weighted_avg_watts: 266,
					icu_average_watts: 264,
					icu_ftp: 286,
					icu_rolling_ftp: 315,
					power_field: "Power",
					stream_types: ["Power", "StrydLSS"],
					device_name: "Garmin fenix 8",
					total_elevation_gain: 111,
					icu_intensity: 93,
					external_id: "23032918336",
					source: "GARMIN_CONNECT",
					session_rpe: 113,
					kg_lifted: null,
				},
			],
			wellness: [],
			runSettings: {
				type: "Run",
				ftp: 286,
				lthr: 163,
				threshold_pace: null,
				hr_zones: null,
				pace_zones: null,
				power_zones: null,
			},
			swimSettings: {
				type: "Swim",
				ftp: null,
				lthr: 140,
				threshold_pace: 106,
				hr_zones: null,
				pace_zones: null,
				power_zones: null,
			},
		};

		const result = suggestWorkoutFromData(
			data as never,
			"Run",
			now,
			undefined,
			undefined,
			"0",
			"America/Los_Angeles",
		);

		expect(result.status).toBe("already_trained");
		expect(result.restMessage).toBeDefined();
		expect(result.restMessage?.trainedSport).toBe("Run");
		expect(result.restMessage?.trainedActivityId).toBe("i151968721");
		expect(result.restMessage?.alternateSport).toBe("Swim");
		expect(result.segments).toEqual([]);
		expect(result.category).toBe("rest");
		expect(result.total_duration_secs).toBe(0);
	});

	it("sets alternateSport to null when both sports trained today", () => {
		const now = new Date("2026-05-27T20:00:00-07:00");
		const data = {
			activities: [
				{
					id: "run1",
					start_date_local: "2026-05-27T07:00:00",
					type: "Run",
					moving_time: 1800,
					distance: 5000,
					icu_training_load: 40,
					icu_atl: 30,
					icu_ctl: 25,
					average_heartrate: 140,
					max_heartrate: 155,
					icu_hr_zone_times: null,
					perceived_exertion: 3,
					power_load: 40,
					hr_load: 35,
					icu_weighted_avg_watts: null,
					icu_average_watts: null,
					icu_ftp: null,
					icu_rolling_ftp: null,
					power_field: null,
					stream_types: null,
					device_name: null,
					total_elevation_gain: 0,
					icu_intensity: null,
					external_id: null,
					source: null,
					session_rpe: null,
					kg_lifted: null,
				},
				{
					id: "swim1",
					start_date_local: "2026-05-27T18:00:00",
					type: "Swim",
					moving_time: 1500,
					distance: 1500,
					icu_training_load: 20,
					icu_atl: 30,
					icu_ctl: 25,
					average_heartrate: 130,
					max_heartrate: 145,
					icu_hr_zone_times: null,
					perceived_exertion: null,
					power_load: null,
					hr_load: 20,
					icu_weighted_avg_watts: null,
					icu_average_watts: null,
					icu_ftp: null,
					icu_rolling_ftp: null,
					power_field: null,
					stream_types: null,
					device_name: null,
					total_elevation_gain: 0,
					icu_intensity: null,
					external_id: null,
					source: null,
					session_rpe: null,
					kg_lifted: null,
				},
			],
			wellness: [],
			runSettings: {
				type: "Run",
				ftp: 286,
				lthr: 163,
				threshold_pace: null,
				hr_zones: null,
				pace_zones: null,
				power_zones: null,
			},
			swimSettings: {
				type: "Swim",
				ftp: null,
				lthr: 140,
				threshold_pace: 106,
				hr_zones: null,
				pace_zones: null,
				power_zones: null,
			},
		};

		const runResult = suggestWorkoutFromData(
			data as never,
			"Run",
			now,
			undefined,
			undefined,
			"0",
			"America/Los_Angeles",
		);
		expect(runResult.status).toBe("already_trained");
		expect(runResult.restMessage?.alternateSport).toBe(null);

		const swimResult = suggestWorkoutFromData(
			data as never,
			"Swim",
			now,
			undefined,
			undefined,
			"0",
			"America/Los_Angeles",
		);
		expect(swimResult.status).toBe("already_trained");
		expect(swimResult.restMessage?.alternateSport).toBe(null);
	});

	it("does not short-circuit when only the other sport was trained today", () => {
		const now = new Date("2026-05-27T18:00:00-07:00");
		const data = {
			activities: [
				{
					id: "swim1",
					start_date_local: "2026-05-27T07:00:00",
					type: "Swim",
					moving_time: 1500,
					distance: 1500,
					icu_training_load: 20,
					icu_atl: 30,
					icu_ctl: 25,
					average_heartrate: 130,
					max_heartrate: 145,
					icu_hr_zone_times: null,
					perceived_exertion: 3,
					power_load: null,
					hr_load: 20,
					icu_weighted_avg_watts: null,
					icu_average_watts: null,
					icu_ftp: null,
					icu_rolling_ftp: null,
					power_field: null,
					stream_types: null,
					device_name: null,
					total_elevation_gain: 0,
					icu_intensity: null,
					external_id: null,
					source: null,
					session_rpe: null,
					kg_lifted: null,
				},
			],
			wellness: [],
			runSettings: {
				type: "Run",
				ftp: 286,
				lthr: 163,
				threshold_pace: null,
				hr_zones: null,
				pace_zones: null,
				power_zones: null,
			},
			swimSettings: {
				type: "Swim",
				ftp: null,
				lthr: 140,
				threshold_pace: 106,
				hr_zones: null,
				pace_zones: null,
				power_zones: null,
			},
		};

		const result = suggestWorkoutFromData(
			data as never,
			"Run",
			now,
			undefined,
			undefined,
			"0",
			"America/Los_Angeles",
		);

		expect(result.status).not.toBe("already_trained");
		expect(result.restMessage).toBeUndefined();
	});

	it("trusts Stryd CP regardless of age — no rolling-FTP override", () => {
		const data = {
			activities: loadFixture("activities-14d.json"),
			wellness: loadFixture("wellness-7d.json"),
			runSettings: loadFixture("sport-settings-run.json"),
			swimSettings: loadFixture("sport-settings-swim.json"),
		};

		// intervals.icu rolling FTP = 322 W. Stryd CP = 274 W, 60 days old —
		// the prior staleness override would have flipped to 322 W; that
		// override was removed (issue #31). Engine now trusts Stryd as
		// authoritative regardless of age and emits no staleness warning;
		// athlete is on the hook to book a fresh CP test when fitness shifts.
		const stale = suggestWorkoutFromData(data as never, "Run", new Date(), undefined, {
			cp: 274,
			ageDays: 60,
		});
		expect(stale.power_context.ftp).toBe(274);
		expect(
			stale.power_context.warnings.some((w) => w.includes("overridden") || w.includes("days old")),
		).toBe(false);

		// Fresh Stryd CP path — same behaviour, sanity-check.
		const fresh = suggestWorkoutFromData(data as never, "Run", new Date(), undefined, {
			cp: 274,
			ageDays: 5,
		});
		expect(fresh.power_context.ftp).toBe(274);
		expect(
			fresh.power_context.warnings.some((w) => w.includes("overridden") || w.includes("days old")),
		).toBe(false);
	});
});
