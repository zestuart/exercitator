import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use in-memory DB BEFORE importing anything that touches it.
process.env.EXERCITATOR_DB_PATH = ":memory:";

// Hoisted mock control point — referenced by the vi.mock factory below.
const { generatePrescriptionsMock } = vi.hoisted(() => ({
	generatePrescriptionsMock: vi.fn(),
}));
vi.mock("../../src/web/prescriptions.js", () => ({
	generatePrescriptions: (...args: unknown[]) => generatePrescriptionsMock(...args),
}));

import { _resetDb } from "../../src/db.js";
import { suggestWorkoutForSport } from "../../src/engine/suggest.js";
import type { WorkoutSuggestion } from "../../src/engine/types.js";
import type { IntervalsClient } from "../../src/intervals.js";
import type { UserProfile } from "../../src/users.js";
import { buildIntervalsDescription } from "../../src/web/intervals-format.js";
import { sendToIntervals } from "../../src/web/send.js";

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

		// Blank lines only around repeat blocks (intervals.icu syntax requirement)
		expect(description).not.toContain("\n\n\n");
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

describe("sendToIntervals status guard", () => {
	const PROFILE: UserProfile = {
		id: "ze",
		displayName: "Ze",
		sports: ["Run"],
		deities: false,
		stryd: false,
		apiKeyEnv: "INTERVALS_ICU_API_KEY",
	} as unknown as UserProfile;

	function baseSuggestion(): WorkoutSuggestion {
		return {
			sport: "Run",
			category: "base",
			title: "Easy Base Run",
			rationale: "Recovery day",
			total_duration_secs: 1800,
			estimated_load: 21,
			segments: [],
			readiness_score: 70,
			sport_selection_reason: "Default",
			terrain: "flat",
			terrain_rationale: "",
			power_context: {
				source: "stryd",
				ftp: 250,
				rolling_ftp: null,
				correction_factor: 1,
				confidence: "high",
				warnings: [],
			},
			warnings: [],
		};
	}

	function fakeRes(): ServerResponse & { _status?: number; _body?: string } {
		const r = {
			headersSent: false,
			_status: undefined as number | undefined,
			_body: undefined as string | undefined,
			setHeader() {},
			writeHead(status: number) {
				this._status = status;
				this.headersSent = true;
				return this;
			},
			end(body?: string) {
				this._body = body;
				return this;
			},
		};
		return r as unknown as ServerResponse & { _status?: number; _body?: string };
	}

	function intervalsClient(): IntervalsClient {
		return {
			athleteId: "0",
			get: vi.fn(),
			put: vi.fn(),
			post: vi.fn().mockResolvedValue({ id: "evt-123" }),
			delete: vi.fn(),
			request: vi.fn(),
		} as unknown as IntervalsClient;
	}

	beforeEach(() => {
		_resetDb();
		generatePrescriptionsMock.mockReset();
	});
	afterEach(() => _resetDb());

	it("refuses a health_unavailable suggestion (422, no event posted)", async () => {
		generatePrescriptionsMock.mockResolvedValue({
			run: {
				...baseSuggestion(),
				status: "health_unavailable",
				healthUnavailableMessage: "WHOOP not synced.",
			},
			swim: null,
		});
		const client = intervalsClient();
		const res = fakeRes();

		await sendToIntervals(client, PROFILE, "run", res, false, "America/Los_Angeles");

		expect(res._status).toBe(422);
		const body = JSON.parse(res._body ?? "{}");
		expect(body.not_sendable).toBe(true);
		expect(body.status).toBe("health_unavailable");
		expect(client.post).not.toHaveBeenCalled();
	});

	it("posts the event for a ready suggestion", async () => {
		generatePrescriptionsMock.mockResolvedValue({ run: baseSuggestion(), swim: null });
		const client = intervalsClient();
		const res = fakeRes();

		await sendToIntervals(client, PROFILE, "run", res, false, "America/Los_Angeles");

		expect(res._status).toBe(200);
		expect(client.post).toHaveBeenCalledTimes(1);
	});
});
