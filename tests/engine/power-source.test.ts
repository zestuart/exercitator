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
});
