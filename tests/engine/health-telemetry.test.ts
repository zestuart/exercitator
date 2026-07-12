import { describe, expect, it } from "vitest";
import {
	type TrainingData,
	fetchHealthTelemetry,
	mergeWhoopHealth,
	suggestWorkoutFromData,
} from "../../src/engine/suggest.js";
import type { SportSettings } from "../../src/engine/types.js";
import type { GarminClient } from "../../src/garmin/client.js";
import type { PromusClient } from "../../src/promus/client.js";

const DEFAULT_SETTINGS: SportSettings = {
	type: "Run",
	ftp: 286,
	lthr: null,
	threshold_pace: null,
	hr_zones: null,
	pace_zones: null,
	power_zones: null,
};

function baseTrainingData(overrides: Partial<TrainingData> = {}): TrainingData {
	return {
		activities: [],
		wellness: [],
		runSettings: DEFAULT_SETTINGS,
		swimSettings: { ...DEFAULT_SETTINGS, type: "Swim" },
		health: [],
		...overrides,
	};
}

/** Minimal PromusClient stub returning canned rows / throwing on demand. */
function stubClient(opts: {
	sleep?: { wake_date: string; duration_s: number | null }[];
	hrv?: { wake_day_utc: string; rmssd_median_ms: number | null }[];
	vigor?: { value: number; level: string };
	throwOn?: "sleep" | "hrv" | "vigor";
}): PromusClient {
	return {
		async getWhoopSleep() {
			if (opts.throwOn === "sleep") throw new Error("Promus getWhoopSleep failed (HTTP 502): x");
			return opts.sleep ?? [];
		},
		async getWhoopHrvNightly() {
			if (opts.throwOn === "hrv") throw new Error("network timeout");
			return opts.hrv ?? [];
		},
		async getVigorVitaeCurrent() {
			if (opts.throwOn === "vigor")
				throw new Error("Promus getVigorVitaeCurrent failed (HTTP 500)");
			return opts.vigor
				? {
						ts: 0,
						value: opts.vigor.value,
						level: opts.vigor.level,
						trend_60min_pt: null,
						method: "t6",
					}
				: { ts: 0, value: 0, level: "drained", trend_60min_pt: null, method: "t6" };
		},
	} as unknown as PromusClient;
}

/** Minimal GarminClient stub. Body Battery is the acute signal + liveness gate. */
function stubGarmin(opts: {
	bb?: { value: number | null; level: string };
	sleep?: { wake_date: string; duration_s: number | null }[];
	hrv?: { wake_day_utc: string; rmssd_median_ms: number | null }[];
	throwOn?: "bb" | "sleep" | "hrv";
	bbError?: string;
}): GarminClient {
	return {
		async getBodyBatteryCurrent() {
			if (opts.throwOn === "bb") throw new Error(opts.bbError ?? "network timeout");
			return opts.bb ?? { value: 60, level: "medium" };
		},
		async getSleepNightly() {
			if (opts.throwOn === "sleep") throw new Error("boom");
			return opts.sleep ?? [];
		},
		async getHrvNightly() {
			if (opts.throwOn === "hrv") throw new Error("boom");
			return opts.hrv ?? [];
		},
	} as unknown as GarminClient;
}

describe("mergeWhoopHealth", () => {
	it("joins sleep and HRV rows by date and sorts ascending", () => {
		const merged = mergeWhoopHealth(
			[
				{ wake_date: "2026-06-02", duration_s: 27000 },
				{ wake_date: "2026-06-01", duration_s: 25000 },
			],
			[
				{ wake_day_utc: "2026-06-01", rmssd_median_ms: 60 },
				{ wake_day_utc: "2026-06-02", rmssd_median_ms: 64 },
			],
		);
		expect(merged.map((m) => m.date)).toEqual(["2026-06-01", "2026-06-02"]);
		expect(merged[1]).toEqual({ date: "2026-06-02", sleepSecs: 27000, hrvRmssd: 64 });
	});

	it("keeps an HRV-only night even when no sleep row exists", () => {
		const merged = mergeWhoopHealth([], [{ wake_day_utc: "2026-06-02", rmssd_median_ms: 50 }]);
		expect(merged).toEqual([{ date: "2026-06-02", sleepSecs: null, hrvRmssd: 50 }]);
	});
});

describe("fetchHealthTelemetry", () => {
	const NOW = new Date("2026-06-03T09:00:00Z");
	const opts = (client: PromusClient) =>
		({
			promusClient: client,
			whoopSerial: "TEST-WHOOP-SERIAL",
			healthSource: "promus-whoop",
		}) as const;

	it("returns empty (no error) for non-promus-whoop users", async () => {
		const res = await fetchHealthTelemetry(NOW, "UTC", {
			promusClient: null,
			whoopSerial: null,
		});
		expect(res).toEqual({ health: [], vigorVitae: null, vigorVitaeLevel: null });
	});

	it("hard-fails when today's WHOOP night is absent", async () => {
		const client = stubClient({
			sleep: [{ wake_date: "2026-06-02", duration_s: 27000 }],
			hrv: [{ wake_day_utc: "2026-06-02", rmssd_median_ms: 60 }],
		});
		const res = await fetchHealthTelemetry(NOW, "UTC", opts(client));
		expect(res.error?.reason).toBe("whoop_today_missing");
	});

	it("succeeds when today's night is present with sleep", async () => {
		const client = stubClient({
			sleep: [{ wake_date: "2026-06-03", duration_s: 27000 }],
			hrv: [{ wake_day_utc: "2026-06-03", rmssd_median_ms: 60 }],
		});
		const res = await fetchHealthTelemetry(NOW, "UTC", opts(client));
		expect(res.error).toBeUndefined();
		expect(res.health.find((h) => h.date === "2026-06-03")?.sleepSecs).toBe(27000);
	});

	it("reads Vigor Vitae on the success path", async () => {
		const client = stubClient({
			sleep: [{ wake_date: "2026-06-03", duration_s: 27000 }],
			hrv: [{ wake_day_utc: "2026-06-03", rmssd_median_ms: 60 }],
			vigor: { value: 88.5, level: "high" },
		});
		const res = await fetchHealthTelemetry(NOW, "UTC", opts(client));
		expect(res.error).toBeUndefined();
		expect(res.vigorVitae).toBe(88.5);
		expect(res.vigorVitaeLevel).toBe("high");
	});

	it("treats a Vigor Vitae failure as non-fatal — health still returned", async () => {
		const client = stubClient({
			sleep: [{ wake_date: "2026-06-03", duration_s: 27000 }],
			hrv: [{ wake_day_utc: "2026-06-03", rmssd_median_ms: 60 }],
			throwOn: "vigor",
		});
		const res = await fetchHealthTelemetry(NOW, "UTC", opts(client));
		expect(res.error).toBeUndefined();
		expect(res.health.find((h) => h.date === "2026-06-03")?.sleepSecs).toBe(27000);
		expect(res.vigorVitae).toBeNull();
		expect(res.vigorVitaeLevel).toBeNull();
	});

	it("hard-fails with an HTTP reason on a transport error", async () => {
		const res = await fetchHealthTelemetry(NOW, "UTC", opts(stubClient({ throwOn: "sleep" })));
		expect(res.error?.reason).toBe("promus_http_502");
	});

	it("hard-fails as unreachable on a network/timeout error", async () => {
		const res = await fetchHealthTelemetry(NOW, "UTC", opts(stubClient({ throwOn: "hrv" })));
		expect(res.error?.reason).toBe("promus_unreachable");
	});

	it("hard-fails when the client/serial is not configured", async () => {
		const res = await fetchHealthTelemetry(NOW, "UTC", {
			promusClient: null,
			whoopSerial: null,
			healthSource: "promus-whoop",
		});
		expect(res.error?.reason).toBe("promus_not_configured");
	});

	it("resolves 'today' in the athlete tz, not UTC, for an evening push west of UTC", async () => {
		// Regression for 2026-06-03: a "Send to Stryd" at 21:10 PDT regenerated
		// with tz omitted (→ UTC), so "today" became 4 June and the WHOOP night
		// (which hadn't happened) read as missing → health_unavailable placeholder
		// pushed. The athlete-tz path must still see 3 June and succeed.
		const now = new Date("2026-06-04T04:10:29Z"); // 21:10 PDT on 2026-06-03
		const client = stubClient({
			sleep: [{ wake_date: "2026-06-03", duration_s: 27000 }],
			hrv: [{ wake_day_utc: "2026-06-03", rmssd_median_ms: 60 }],
		});
		// Athlete-tz path (correct): today = 2026-06-03 → night present → success.
		const ok = await fetchHealthTelemetry(now, "America/Los_Angeles", opts(client));
		expect(ok.error).toBeUndefined();
		// UTC path (the bug): today = 2026-06-04 → night absent → hard-fail.
		const bad = await fetchHealthTelemetry(now, "UTC", opts(client));
		expect(bad.error?.reason).toBe("whoop_today_missing");
	});
});

describe("fetchHealthTelemetry — Garmin source", () => {
	const NOW = new Date("2026-06-03T09:00:00Z");
	const garminOpts = (client: GarminClient) =>
		({
			promusClient: null,
			whoopSerial: null,
			garminClient: client,
			healthSource: "garmin",
		}) as const;

	it("maps Body Battery → vigor, sleep → sleepSecs, HRV → hrvRmssd", async () => {
		const g = stubGarmin({
			bb: { value: 55, level: "medium" },
			sleep: [{ wake_date: "2026-06-03", duration_s: 26000 }],
			hrv: [{ wake_day_utc: "2026-06-03", rmssd_median_ms: 42 }],
		});
		const res = await fetchHealthTelemetry(NOW, "UTC", garminOpts(g));
		expect(res.error).toBeUndefined();
		expect(res.vigorVitae).toBe(55);
		expect(res.vigorVitaeLevel).toBe("medium");
		const night = res.health.find((h) => h.date === "2026-06-03");
		expect(night?.sleepSecs).toBe(26000);
		expect(night?.hrvRmssd).toBe(42);
	});

	it("does NOT hard-fail when last night's sleep is missing (BB carries the acute reading)", async () => {
		const g = stubGarmin({ bb: { value: 70, level: "high" }, sleep: [], hrv: [] });
		const res = await fetchHealthTelemetry(NOW, "UTC", garminOpts(g));
		expect(res.error).toBeUndefined();
		expect(res.vigorVitae).toBe(70);
	});

	it("errors garmin_no_data when Body Battery is null", async () => {
		const g = stubGarmin({ bb: { value: null, level: "unknown" } });
		const res = await fetchHealthTelemetry(NOW, "UTC", garminOpts(g));
		expect(res.error?.reason).toBe("garmin_no_data");
	});

	it("maps a bridge reauth 503 to garmin_reauth_required", async () => {
		const g = stubGarmin({
			throwOn: "bb",
			bbError:
				'Garmin getBodyBatteryCurrent failed (HTTP 503): {"reason":"garmin_reauth_required"}',
		});
		const res = await fetchHealthTelemetry(NOW, "UTC", garminOpts(g));
		expect(res.error?.reason).toBe("garmin_reauth_required");
	});

	it("maps a transport failure to garmin_unreachable", async () => {
		const g = stubGarmin({ throwOn: "bb", bbError: "network timeout" });
		const res = await fetchHealthTelemetry(NOW, "UTC", garminOpts(g));
		expect(res.error?.reason).toBe("garmin_unreachable");
	});

	it("errors garmin_not_configured when no Garmin client is present", async () => {
		const res = await fetchHealthTelemetry(NOW, "UTC", {
			promusClient: null,
			whoopSerial: null,
			healthSource: "garmin",
		});
		expect(res.error?.reason).toBe("garmin_not_configured");
	});
});

describe("fetchHealthTelemetry — auto (WHOOP → Garmin fallback)", () => {
	const NOW = new Date("2026-06-03T09:00:00Z");

	it("uses WHOOP when its night is present (Garmin untouched)", async () => {
		const whoop = stubClient({
			sleep: [{ wake_date: "2026-06-03", duration_s: 27000 }],
			hrv: [{ wake_day_utc: "2026-06-03", rmssd_median_ms: 60 }],
			vigor: { value: 88, level: "high" },
		});
		const garmin = stubGarmin({ bb: { value: 40, level: "medium" } });
		const res = await fetchHealthTelemetry(NOW, "UTC", {
			promusClient: whoop,
			whoopSerial: "S",
			garminClient: garmin,
			healthSource: "auto",
		});
		expect(res.error).toBeUndefined();
		expect(res.vigorVitae).toBe(88); // WHOOP VV, not Garmin BB
	});

	it("falls back to Garmin when the WHOOP night is missing", async () => {
		const whoop = stubClient({ sleep: [{ wake_date: "2026-06-02", duration_s: 27000 }], hrv: [] });
		const garmin = stubGarmin({
			bb: { value: 44, level: "medium" },
			sleep: [{ wake_date: "2026-06-03", duration_s: 25000 }],
		});
		const res = await fetchHealthTelemetry(NOW, "UTC", {
			promusClient: whoop,
			whoopSerial: "S",
			garminClient: garmin,
			healthSource: "auto",
		});
		expect(res.error).toBeUndefined();
		expect(res.vigorVitae).toBe(44); // Garmin BB via fallback
	});

	it("reports the primary WHOOP error (annotated) when BOTH sources are down", async () => {
		const whoop = stubClient({ sleep: [{ wake_date: "2026-06-02", duration_s: 27000 }] });
		const garmin = stubGarmin({ bb: { value: null, level: "unknown" } });
		const res = await fetchHealthTelemetry(NOW, "UTC", {
			promusClient: whoop,
			whoopSerial: "S",
			garminClient: garmin,
			healthSource: "auto",
		});
		expect(res.error?.reason).toBe("whoop_today_missing");
		expect(res.error?.message).toContain("Garmin fallback also unavailable");
	});

	it("returns the WHOOP error unchanged when no Garmin client is configured", async () => {
		const whoop = stubClient({ sleep: [{ wake_date: "2026-06-02", duration_s: 27000 }] });
		const res = await fetchHealthTelemetry(NOW, "UTC", {
			promusClient: whoop,
			whoopSerial: "S",
			healthSource: "auto",
		});
		expect(res.error?.reason).toBe("whoop_today_missing");
		expect(res.error?.message).not.toContain("Garmin fallback");
	});
});

describe("suggestWorkoutFromData — health_unavailable short-circuit", () => {
	it("returns a blocked suggestion when healthError is set", () => {
		const data = baseTrainingData({
			healthError: { reason: "whoop_today_missing", message: "WHOOP not synced." },
		});
		const s = suggestWorkoutFromData(data, "Run", new Date("2026-06-03T09:00:00Z"));
		expect(s.status).toBe("health_unavailable");
		expect(s.segments).toEqual([]);
		expect(s.healthUnavailableReason).toBe("whoop_today_missing");
		expect(s.healthUnavailableMessage).toBe("WHOOP not synced.");
	});
});
