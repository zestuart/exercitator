import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySummary } from "../../src/engine/types.js";
import type { StrydActivity, StrydClient } from "../../src/stryd/client.js";
import {
	enrichLowFidelityActivities,
	matchStrydActivity,
	needsEnrichment,
} from "../../src/stryd/enricher.js";

// Mock the db module to avoid actual SQLite access
vi.mock("../../src/db.js", () => ({
	isAlreadyEnriched: vi.fn().mockReturnValue(false),
	recordEnrichment: vi.fn(),
}));

import { isAlreadyEnriched, recordEnrichment } from "../../src/db.js";

function makeAppleWatchStrydActivity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
	return {
		id: "i135130764",
		start_date_local: "2026-03-27T11:11:07",
		type: "Run",
		moving_time: 2220,
		distance: 6100,
		icu_training_load: 65,
		icu_atl: 28.3,
		icu_ctl: 22.1,
		average_heartrate: 158,
		max_heartrate: 178,
		icu_hr_zone_times: [120, 180, 483, 502, 264, 171, 500],
		perceived_exertion: null,
		power_load: 49,
		hr_load: 42,
		icu_weighted_avg_watts: 290,
		icu_average_watts: 265,
		icu_ftp: 292,
		icu_rolling_ftp: 322,
		power_field: "power",
		stream_types: ["heartrate", "watts", "cadence", "altitude", "StrydStepLength"],
		device_name: "Watch7,12",
		total_elevation_gain: 35,
		icu_intensity: 90.07,
		external_id: "2026-03-27-111107-Outdoor Running-Stryd.fit",
		source: "OAUTH_CLIENT",
		...overrides,
	};
}

function makeGarminStrydActivity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
	return {
		id: "i134468264",
		start_date_local: "2026-03-24T07:15:00",
		type: "Run",
		moving_time: 2460,
		distance: 6300,
		icu_training_load: 55,
		icu_atl: 22.5,
		icu_ctl: 20.9,
		average_heartrate: 129,
		max_heartrate: 143,
		icu_hr_zone_times: [2340, 100, 20, 0, 0, 0, 0],
		perceived_exertion: 4,
		power_load: 55,
		hr_load: 39,
		icu_weighted_avg_watts: 234,
		icu_average_watts: 229,
		icu_ftp: 292,
		icu_rolling_ftp: 322,
		power_field: "Power",
		stream_types: [
			"heartrate",
			"watts",
			"cadence",
			"altitude",
			"Power",
			"StrydLSS",
			"StrydFormPower",
			"StrydILR",
		],
		device_name: "Garmin Forerunner 970",
		total_elevation_gain: 92,
		icu_intensity: 72.6,
		external_id: "2026-03-24-071500-Running.fit",
		source: "GARMIN_CONNECT",
		...overrides,
	};
}

describe("needsEnrichment", () => {
	beforeEach(() => {
		vi.mocked(isAlreadyEnriched).mockReturnValue(false);
	});

	it("returns true for Apple Watch + Stryd without CIQ streams", () => {
		expect(needsEnrichment(makeAppleWatchStrydActivity())).toBe(true);
	});

	it("returns false for Garmin + Stryd with CIQ streams", () => {
		expect(needsEnrichment(makeGarminStrydActivity())).toBe(false);
	});

	it("returns false when already enriched", () => {
		vi.mocked(isAlreadyEnriched).mockReturnValue(true);
		expect(needsEnrichment(makeAppleWatchStrydActivity())).toBe(false);
	});

	it("returns false for non-Stryd Apple Watch recording", () => {
		const activity = makeAppleWatchStrydActivity({
			external_id: "2026-03-27-Running.fit", // No "Stryd" in name
		});
		expect(needsEnrichment(activity)).toBe(false);
	});
});

describe("matchStrydActivity", () => {
	const strydActivities: StrydActivity[] = [
		{
			id: 6151018183557120,
			timestamp: Math.floor(new Date("2026-03-27T11:11:07Z").getTime() / 1000),
			distance: 6050, // Within 5% of 6100
			elapsed_time: 2220,
			average_power: 265,
		},
		{
			id: 6151018183557121,
			timestamp: Math.floor(new Date("2026-03-26T08:00:00Z").getTime() / 1000),
			distance: 5000,
			elapsed_time: 1800,
			average_power: 240,
		},
	];

	it("matches by same day and distance within 5%", () => {
		const icu = makeAppleWatchStrydActivity();
		const match = matchStrydActivity(icu, strydActivities);
		expect(match).not.toBeNull();
		expect(match?.id).toBe(6151018183557120);
	});

	it("returns null when distance is off by more than 5%", () => {
		const icu = makeAppleWatchStrydActivity({ distance: 10000 }); // 6050/10000 = 39.5% off
		const match = matchStrydActivity(icu, strydActivities);
		expect(match).toBeNull();
	});

	it("returns null when no activity on the same day", () => {
		const icu = makeAppleWatchStrydActivity({
			start_date_local: "2026-03-25T11:00:00", // Different day
		});
		const match = matchStrydActivity(icu, strydActivities);
		expect(match).toBeNull();
	});

	it("returns null when distance is null", () => {
		const icu = makeAppleWatchStrydActivity({ distance: null });
		const match = matchStrydActivity(icu, strydActivities);
		expect(match).toBeNull();
	});
});

describe("enrichLowFidelityActivities", () => {
	it("returns activities unchanged when strydClient is null", async () => {
		const activities = [makeAppleWatchStrydActivity()];
		const result = await enrichLowFidelityActivities(activities, null, {} as never);
		expect(result).toBe(activities);
	});

	it("returns activities unchanged when no candidates", async () => {
		const activities = [makeGarminStrydActivity()]; // Has CIQ streams — no enrichment needed
		const mockStryd = { isAuthenticated: false, login: vi.fn(), listActivities: vi.fn() };
		const result = await enrichLowFidelityActivities(
			activities,
			mockStryd as unknown as StrydClient,
			{} as never,
		);
		expect(result).toBe(activities);
		expect(mockStryd.login).not.toHaveBeenCalled();
	});

	it("returns original activities when enrichment pipeline throws", async () => {
		const activities = [makeAppleWatchStrydActivity()];
		const mockStryd = {
			isAuthenticated: false,
			login: vi.fn().mockRejectedValue(new Error("auth failed")),
		};
		const result = await enrichLowFidelityActivities(
			activities,
			mockStryd as unknown as StrydClient,
			{} as never,
		);
		expect(result).toBe(activities);
	});

	it("enriches candidate and re-fetches activities", async () => {
		const candidate = makeAppleWatchStrydActivity();
		const activities = [candidate, makeGarminStrydActivity()];

		const strydActivity: StrydActivity = {
			id: 6151018183557120,
			timestamp: Math.floor(new Date("2026-03-27T11:11:07Z").getTime() / 1000),
			distance: 6050,
			elapsed_time: 2220,
			average_power: 265,
		};

		const fitBuffer = Buffer.from([0x2e, 0x46, 0x49, 0x54]);
		const enrichedActivities = [makeGarminStrydActivity({ id: "enriched-new" })];

		const mockStryd = {
			isAuthenticated: false,
			login: vi.fn(),
			listActivities: vi.fn().mockResolvedValue([strydActivity]),
			downloadFit: vi.fn().mockResolvedValue(fitBuffer),
		};

		const mockIntervals = {
			athleteId: "0",
			uploadFile: vi.fn().mockResolvedValue({ id: "new-icu-id" }),
			put: vi.fn().mockResolvedValue({}),
			get: vi.fn().mockResolvedValue(enrichedActivities),
		};

		const result = await enrichLowFidelityActivities(
			activities,
			mockStryd as unknown as StrydClient,
			mockIntervals as never,
		);

		expect(mockStryd.login).toHaveBeenCalled();
		expect(mockStryd.downloadFit).toHaveBeenCalledWith(6151018183557120);
		expect(mockIntervals.uploadFile).toHaveBeenCalled();
		expect(mockIntervals.put).toHaveBeenCalledWith(`/activity/${candidate.id}`, {
			icu_ignore_time: true,
		});
		expect(vi.mocked(recordEnrichment)).toHaveBeenCalledWith(
			candidate.id,
			6151018183557120,
			"new-icu-id",
		);
		// Re-fetched activities returned
		expect(result).toBe(enrichedActivities);
	});
});
