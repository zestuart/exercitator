import { describe, expect, it } from "vitest";
import {
	type TrainingData,
	fetchHealthTelemetry,
	mergeWhoopHealth,
	suggestWorkoutFromData,
} from "../../src/engine/suggest.js";
import type { SportSettings } from "../../src/engine/types.js";
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
	throwOn?: "sleep" | "hrv";
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
	} as unknown as PromusClient;
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
		expect(res).toEqual({ health: [] });
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
