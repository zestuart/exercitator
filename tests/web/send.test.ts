import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { suggestWorkoutForSport } from "../../src/engine/suggest.js";
import type { IntervalsClient } from "../../src/intervals.js";
import { buildIntervalsDescription } from "../../src/web/intervals-format.js";

function loadFixture(name: string): unknown {
	const raw = readFileSync(resolve(__dirname, "../fixtures", name), "utf-8");
	return JSON.parse(raw);
}

function createMockClient(): IntervalsClient {
	const activities = loadFixture("activities-14d.json");
	const wellness = loadFixture("wellness-7d.json");
	const runSettings = loadFixture("sport-settings-run.json");
	const swimSettings = loadFixture("sport-settings-swim.json");

	return {
		athleteId: "0",
		get: vi.fn().mockImplementation((path: string) => {
			if (path.includes("/activities")) return Promise.resolve(activities);
			if (path.includes("/wellness")) return Promise.resolve(wellness);
			if (path.includes("sport-settings/Run")) return Promise.resolve(runSettings);
			if (path.includes("sport-settings/Swim")) return Promise.resolve(swimSettings);
			return Promise.reject(new Error(`Unexpected path: ${path}`));
		}),
		put: vi.fn(),
		post: vi.fn().mockResolvedValue({ id: "evt-123" }),
		delete: vi.fn(),
		request: vi.fn(),
	} as unknown as IntervalsClient;
}

describe("send to intervals.icu", () => {
	it("generates valid intervals.icu workout text for a run", async () => {
		const client = createMockClient();
		const suggestion = await suggestWorkoutForSport(client, "Run");
		const description = buildIntervalsDescription(suggestion);

		// Contains section headers and step lines
		const lines = description.split("\n");
		const stepLines = lines.filter((l) => l.startsWith("- "));
		expect(stepLines.length).toBeGreaterThan(0);

		// No empty lines between sections
		expect(description).not.toContain("\n\n");
	});

	it("generates valid intervals.icu workout text for a swim", async () => {
		const client = createMockClient();
		const suggestion = await suggestWorkoutForSport(client, "Swim");
		const description = buildIntervalsDescription(suggestion);

		const lines = description.split("\n");
		const stepLines = lines.filter((l) => l.startsWith("- "));
		expect(stepLines.length).toBeGreaterThan(0);
	});

	it("would post correct event shape to intervals.icu", async () => {
		const client = createMockClient();
		const suggestion = await suggestWorkoutForSport(client, "Run");
		const description = buildIntervalsDescription(suggestion);
		const today = new Date().toISOString().slice(0, 10);

		const event = {
			category: "WORKOUT",
			start_date_local: `${today}T00:00:00`,
			name: suggestion.title,
			description,
			type: suggestion.sport,
		};

		expect(event.category).toBe("WORKOUT");
		expect(event.type).toBe("Run");
		expect(event.name).toBeTruthy();
		expect(event.start_date_local).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00$/);
		expect(event.description.length).toBeGreaterThan(0);
	});
});
