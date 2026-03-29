import { describe, expect, it } from "vitest";
import { detectPowerSource, getActivityLoad } from "../../src/engine/power-source.js";
import type { ActivitySummary } from "../../src/engine/types.js";

function makeRunActivity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
	return {
		id: "a1",
		start_date_local: "2026-03-23T08:00:00",
		type: "Run",
		moving_time: 2400,
		distance: 8000,
		icu_training_load: 60,
		icu_atl: 40,
		icu_ctl: 50,
		average_heartrate: 145,
		max_heartrate: 170,
		icu_hr_zone_times: [300, 600, 900, 400, 200, 0, 0],
		perceived_exertion: null,
		power_load: 55,
		hr_load: 39,
		icu_weighted_avg_watts: 229,
		icu_average_watts: 203,
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
		total_elevation_gain: 50,
		icu_intensity: 78.4,
		external_id: "2026-03-23-080000-Running.fit",
		source: "GARMIN_CONNECT",
		...overrides,
	};
}

describe("detectPowerSource", () => {
	it("detects Stryd active with capital P power field", () => {
		const activities = [makeRunActivity()];
		const result = detectPowerSource(activities);

		expect(result.source).toBe("stryd");
		expect(result.correction_factor).toBe(1.0);
		expect(result.confidence).toBe("high");
		expect(result.ftp).toBe(322); // rolling FTP used
		expect(result.rolling_ftp).toBe(322);
		expect(result.warnings).toHaveLength(0);
	});

	it("detects Garmin active with Stryd available — applies correction", () => {
		const activities = [
			makeRunActivity({
				power_field: "power", // Garmin active
				// But Stryd streams still present
			}),
		];
		const result = detectPowerSource(activities);

		expect(result.source).toBe("stryd");
		expect(result.correction_factor).toBe(0.87);
		expect(result.confidence).toBe("low");
		expect(result.ftp).toBe(Math.round(322 * 0.87)); // 280
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.warnings[0]).toContain("Garmin native");
		expect(result.warnings[0]).toContain("0.87");
	});

	it("detects Garmin only when no Stryd streams", () => {
		const activities = [
			makeRunActivity({
				power_field: "power",
				stream_types: ["heartrate", "watts", "cadence", "altitude"],
				icu_ftp: 292,
				icu_rolling_ftp: 300,
			}),
		];
		const result = detectPowerSource(activities);

		expect(result.source).toBe("garmin");
		expect(result.correction_factor).toBe(1.0);
		expect(result.confidence).toBe("high");
		expect(result.ftp).toBe(300); // rolling FTP
	});

	it("returns none when no power data at all", () => {
		const activities = [
			makeRunActivity({
				power_field: null,
				stream_types: ["heartrate"],
				icu_ftp: null,
				icu_rolling_ftp: null,
				power_load: null,
				icu_weighted_avg_watts: null,
				icu_average_watts: null,
			}),
		];
		const result = detectPowerSource(activities);

		expect(result.source).toBe("none");
		expect(result.ftp).toBe(0);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("handles mixed history — Stryd on most, forgotten pod on some", () => {
		const activities = [
			makeRunActivity({ id: "a1", start_date_local: "2026-03-23T08:00:00" }),
			makeRunActivity({ id: "a2", start_date_local: "2026-03-21T08:00:00" }),
			makeRunActivity({
				id: "a3",
				start_date_local: "2026-03-19T08:00:00",
				power_field: "power",
				stream_types: ["heartrate", "watts", "cadence"],
			}),
			makeRunActivity({ id: "a4", start_date_local: "2026-03-17T08:00:00" }),
			makeRunActivity({
				id: "a5",
				start_date_local: "2026-03-15T08:00:00",
				power_field: "power",
				stream_types: ["heartrate", "watts"],
			}),
		];
		const result = detectPowerSource(activities);

		// Most recent has Stryd active
		expect(result.source).toBe("stryd");
		expect(result.confidence).toBe("high");
	});

	it("uses icu_rolling_ftp when available, falls back to icu_ftp", () => {
		// With rolling FTP
		const withRolling = [makeRunActivity({ icu_rolling_ftp: 322, icu_ftp: 292 })];
		const r1 = detectPowerSource(withRolling);
		expect(r1.ftp).toBe(322);

		// Without rolling FTP
		const withoutRolling = [makeRunActivity({ icu_rolling_ftp: null, icu_ftp: 292 })];
		const r2 = detectPowerSource(withoutRolling);
		expect(r2.ftp).toBe(292);
	});

	it("returns none when no run activities at all", () => {
		const result = detectPowerSource([]);
		expect(result.source).toBe("none");
	});

	it("detects Apple Watch + Stryd as stryd with no correction", () => {
		const appleWatchStryd = makeRunActivity({
			id: "aw1",
			start_date_local: "2026-03-27T11:11:07",
			power_field: "power", // lowercase — standard watchOS field
			stream_types: ["heartrate", "watts", "cadence", "altitude", "StrydStepLength"],
			device_name: "Watch7,12",
			external_id: "2026-03-27-111107-Outdoor Running-Stryd.fit",
			source: "OAUTH_CLIENT",
			icu_intensity: 90.07,
		});
		// Older Garmin + Stryd CIQ runs in lookback window
		const garminStryd = makeRunActivity({
			id: "g1",
			start_date_local: "2026-03-24T07:15:00",
		});

		const result = detectPowerSource([appleWatchStryd, garminStryd]);

		expect(result.source).toBe("stryd");
		expect(result.correction_factor).toBe(1.0);
		expect(result.confidence).toBe("high");
		expect(result.ftp).toBe(322);
		expect(result.warnings).toHaveLength(0);
	});

	it("detects enriched Stryd FIT upload as stryd with no correction", () => {
		const enrichedUpload = makeRunActivity({
			id: "enriched1",
			start_date_local: "2026-03-27T04:11:07",
			power_field: "power",
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
			device_name: "STRYD",
			external_id: "stryd-6151018183557120.fit",
			source: "UPLOAD",
		});

		const result = detectPowerSource([enrichedUpload]);

		// enriched Stryd FIT: device_name "STRYD" + external_id contains "stryd"
		// Should hit Stryd native branch, not the Garmin+Stryd correction branch
		expect(result.source).toBe("stryd");
		expect(result.correction_factor).toBe(1.0);
		expect(result.confidence).toBe("high");
		expect(result.warnings).toHaveLength(0);
	});

	it("Apple Watch native (no Stryd pod, no Stryd history) returns none", () => {
		const appleWatchNative = makeRunActivity({
			id: "aw2",
			start_date_local: "2026-03-27T08:00:00",
			power_field: "power",
			stream_types: ["heartrate", "watts", "cadence"],
			device_name: "Watch7,12",
			external_id: "2026-03-27-080000-Running.fit", // No "Stryd" in name
			source: "OAUTH_CLIENT",
		});

		const result = detectPowerSource([appleWatchNative]);

		// Apple Watch native power is unreliable — no Stryd baseline → none
		expect(result.source).toBe("none");
		expect(result.ftp).toBe(0);
		expect(result.warnings[0]).toContain("Apple Watch native power");
		expect(result.warnings[0]).toContain("no Stryd baseline");
	});

	it("Apple Watch forgot Stryd pod — falls back to previous Stryd run", () => {
		const awNoPod = makeRunActivity({
			id: "aw-nopod",
			start_date_local: "2026-03-27T08:00:00",
			power_field: "power",
			stream_types: ["heartrate", "watts", "cadence"],
			device_name: "Watch7,12",
			external_id: "2026-03-27-080000-Running.fit",
			source: "OAUTH_CLIENT",
			icu_rolling_ftp: 290,
		});
		const previousStryd = makeRunActivity({
			id: "stryd-prev",
			start_date_local: "2026-03-24T07:00:00",
			power_field: "power",
			stream_types: ["heartrate", "watts", "StrydStepLength"],
			device_name: "Watch7,12",
			external_id: "2026-03-24-Outdoor Running-Stryd.fit",
			source: "OAUTH_CLIENT",
			icu_rolling_ftp: 310,
			icu_ftp: 300,
		});

		const result = detectPowerSource([awNoPod, previousStryd]);

		// Should look past the podless run and use previous Stryd context
		expect(result.source).toBe("stryd");
		expect(result.correction_factor).toBe(1.0);
		expect(result.confidence).toBe("low");
		expect(result.ftp).toBe(310); // from the previous Stryd run
		expect(result.warnings[0]).toContain("Stryd pod not detected");
	});

	it("Apple Watch forgot Stryd pod — falls back to older Garmin+Stryd CIQ run", () => {
		const awNoPod = makeRunActivity({
			id: "aw-nopod",
			start_date_local: "2026-03-27T08:00:00",
			power_field: "power",
			stream_types: ["heartrate", "watts"],
			device_name: "Watch7,12",
			external_id: "2026-03-27-Running.fit",
			source: "OAUTH_CLIENT",
		});
		const garminStryd = makeRunActivity({
			id: "g-stryd",
			start_date_local: "2026-03-22T07:00:00",
			// Default: power_field "Power", has StrydLSS/StrydFormPower/StrydILR
		});

		const result = detectPowerSource([awNoPod, garminStryd]);

		expect(result.source).toBe("stryd");
		expect(result.correction_factor).toBe(1.0);
		expect(result.ftp).toBe(322); // from the Garmin+Stryd run
		expect(result.warnings[0]).toContain("Stryd pod not detected");
	});

	it("mixed history: Apple Watch + Stryd most recent, Garmin older", () => {
		const appleWatchStryd = makeRunActivity({
			id: "aw1",
			start_date_local: "2026-03-27T11:00:00",
			power_field: "power",
			stream_types: ["heartrate", "watts", "StrydStepLength"],
			device_name: "Watch7,12",
			external_id: "2026-03-27-Outdoor Running-Stryd.fit",
			source: "OAUTH_CLIENT",
		});
		const garminStryd1 = makeRunActivity({
			id: "g1",
			start_date_local: "2026-03-24T07:00:00",
		});
		const garminStryd2 = makeRunActivity({
			id: "g2",
			start_date_local: "2026-03-20T07:00:00",
		});

		const result = detectPowerSource([appleWatchStryd, garminStryd1, garminStryd2]);

		// Should detect as Stryd native, not "Garmin active but Stryd connected"
		expect(result.source).toBe("stryd");
		expect(result.correction_factor).toBe(1.0);
		expect(result.confidence).toBe("high");
	});
});

describe("getActivityLoad", () => {
	it("uses power_load for Stryd activities with Stryd context", () => {
		const activity = makeRunActivity({ power_load: 55, hr_load: 39 });
		const ctx = detectPowerSource([activity]);
		expect(getActivityLoad(activity, ctx)).toBe(55);
	});

	it("falls back to hr_load when activity lacks Stryd streams", () => {
		const strydActivity = makeRunActivity();
		const noStrydActivity = makeRunActivity({
			id: "a2",
			power_field: "power",
			stream_types: ["heartrate", "watts"],
			power_load: 48,
			hr_load: 38,
		});
		const ctx = detectPowerSource([strydActivity]);
		expect(getActivityLoad(noStrydActivity, ctx)).toBe(38);
	});

	it("uses hr_load when power source is none", () => {
		const activity = makeRunActivity({ power_load: 55, hr_load: 39 });
		const ctx = {
			source: "none" as const,
			ftp: 0,
			rolling_ftp: null,
			correction_factor: 1.0,
			confidence: "low" as const,
			warnings: [],
		};
		expect(getActivityLoad(activity, ctx)).toBe(39);
	});

	it("uses power_load for Apple Watch + Stryd activity in Stryd context", () => {
		const appleWatchStryd = makeRunActivity({
			power_field: "power",
			stream_types: ["heartrate", "watts", "StrydStepLength"],
			device_name: "Watch7,12",
			external_id: "2026-03-27-Outdoor Running-Stryd.fit",
			source: "OAUTH_CLIENT",
			power_load: 49,
			hr_load: 42,
		});
		const ctx = {
			source: "stryd" as const,
			ftp: 322,
			rolling_ftp: 322,
			correction_factor: 1.0,
			confidence: "high" as const,
			warnings: [],
		};
		// Should use power_load (49), not fall back to hr_load (42)
		expect(getActivityLoad(appleWatchStryd, ctx)).toBe(49);
	});

	it("falls back to hr_load for non-Stryd Apple Watch in Stryd context", () => {
		const appleWatchNative = makeRunActivity({
			power_field: "power",
			stream_types: ["heartrate", "watts"],
			device_name: "Watch7,12",
			external_id: "2026-03-27-Running.fit", // No "Stryd" in name
			source: "OAUTH_CLIENT",
			power_load: 48,
			hr_load: 38,
		});
		const ctx = {
			source: "stryd" as const,
			ftp: 322,
			rolling_ftp: 322,
			correction_factor: 1.0,
			confidence: "high" as const,
			warnings: [],
		};
		// Not a Stryd recording and no CIQ streams → hr_load fallback
		expect(getActivityLoad(appleWatchNative, ctx)).toBe(38);
	});
});
