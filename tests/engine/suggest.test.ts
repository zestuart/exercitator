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

	it("falls back to intervals.icu rolling FTP when Stryd CP is stale and lower", () => {
		const data = {
			activities: loadFixture("activities-14d.json"),
			wellness: loadFixture("wellness-7d.json"),
			runSettings: loadFixture("sport-settings-run.json"),
			swimSettings: loadFixture("sport-settings-swim.json"),
		};

		// intervals.icu rolling FTP = 322 W; Stryd CP = 274 W and 60 days old.
		// 322 > 274 × 1.05 → engine should override with 322 and warn.
		const result = suggestWorkoutFromData(data as never, "Run", new Date(), undefined, {
			cp: 274,
			ageDays: 60,
		});
		expect(result.power_context.ftp).toBe(322);
		expect(
			result.power_context.warnings.some((w) => w.includes("overridden") && w.includes("60d old")),
		).toBe(true);
	});

	it("keeps Stryd CP when stale but inferred FTP is not materially higher", () => {
		const data = {
			activities: loadFixture("activities-14d.json"),
			wellness: loadFixture("wellness-7d.json"),
			runSettings: loadFixture("sport-settings-run.json"),
			swimSettings: loadFixture("sport-settings-swim.json"),
		};

		// intervals.icu rolling FTP = 322; Stryd CP = 320, stale.
		// 322 < 320 × 1.05 (= 336) → keep Stryd CP, soft warning only.
		const result = suggestWorkoutFromData(data as never, "Run", new Date(), undefined, {
			cp: 320,
			ageDays: 45,
		});
		expect(result.power_context.ftp).toBe(320);
		expect(result.power_context.warnings.some((w) => w.includes("Stryd CP is 45 days old"))).toBe(
			true,
		);
	});

	it("uses fresh Stryd CP without warning even if lower than intervals FTP", () => {
		const data = {
			activities: loadFixture("activities-14d.json"),
			wellness: loadFixture("wellness-7d.json"),
			runSettings: loadFixture("sport-settings-run.json"),
			swimSettings: loadFixture("sport-settings-swim.json"),
		};

		// Stryd CP = 274 W, fresh (5 days). Even though intervals FTP is higher,
		// fresh Stryd is authoritative — no override, no warning.
		const result = suggestWorkoutFromData(data as never, "Run", new Date(), undefined, {
			cp: 274,
			ageDays: 5,
		});
		expect(result.power_context.ftp).toBe(274);
		expect(
			result.power_context.warnings.some((w) => w.includes("overridden") || w.includes("days old")),
		).toBe(false);
	});
});
