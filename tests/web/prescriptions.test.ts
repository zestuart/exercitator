import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { suggestWorkoutForSport } from "../../src/engine/suggest.js";
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

describe("suggestWorkoutForSport", () => {
	it("generates a valid Run prescription", async () => {
		const client = createMockClient();
		const result = await suggestWorkoutForSport(client, "Run");

		expect(result.sport).toBe("Run");
		expect(result.category).toBeDefined();
		expect(result.title).toBeTruthy();
		expect(result.readiness_score).toBeGreaterThanOrEqual(0);
		expect(result.readiness_score).toBeLessThanOrEqual(100);
		expect(result.sport_selection_reason).toContain("Forced: Run");
		expect(Array.isArray(result.warnings)).toBe(true);
	});

	it("generates a valid Swim prescription", async () => {
		const client = createMockClient();
		const result = await suggestWorkoutForSport(client, "Swim");

		expect(result.sport).toBe("Swim");
		expect(result.category).toBeDefined();
		expect(result.title).toBeTruthy();
		expect(result.sport_selection_reason).toContain("Forced: Swim");
	});

	it("produces non-empty segments for non-rest categories", async () => {
		const client = createMockClient();
		const run = await suggestWorkoutForSport(client, "Run");
		const swim = await suggestWorkoutForSport(client, "Swim");

		for (const result of [run, swim]) {
			if (result.category === "rest") {
				expect(result.segments).toHaveLength(0);
			} else {
				expect(result.segments.length).toBeGreaterThan(0);
				const segmentTotal = result.segments.reduce((s, seg) => s + seg.duration_secs, 0);
				expect(segmentTotal).toBe(result.total_duration_secs);
			}
		}
	});

	it("calls all four API endpoints", async () => {
		const client = createMockClient();
		await suggestWorkoutForSport(client, "Run");

		expect(client.get).toHaveBeenCalledTimes(4);
	});
});
