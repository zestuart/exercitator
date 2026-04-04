import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getComplianceAssessment,
	getComplianceForDate,
	getPrescription,
	getPrescriptions,
	getSendEvent,
	persistPrescription,
	persistSendEvent,
	saveComplianceAssessment,
} from "../../src/compliance/persist.js";
import type { SegmentCompliance } from "../../src/compliance/types.js";
import { _resetDb } from "../../src/db.js";
import type { WorkoutSuggestion } from "../../src/engine/types.js";

// Use in-memory database for tests
process.env.EXERCITATOR_DB_PATH = ":memory:";

const makeSuggestion = (sport: "Run" | "Swim" = "Run"): WorkoutSuggestion => ({
	sport,
	category: "base",
	title: "Easy Base Run",
	rationale: "Recovery day",
	total_duration_secs: 2400,
	estimated_load: 45,
	segments: [
		{ name: "Warm-up", duration_secs: 600, target_description: "Easy Z1", target_hr_zone: 1 },
		{
			name: "Main",
			duration_secs: 1500,
			target_description: "Z2 steady",
			target_hr_zone: 2,
			target_power_low: 180,
			target_power_high: 220,
		},
		{ name: "Cool-down", duration_secs: 300, target_description: "Easy", target_hr_zone: 1 },
	],
	readiness_score: 7,
	sport_selection_reason: "Default",
	terrain: "flat",
	terrain_rationale: "Base run",
	power_context: {
		source: "stryd",
		ftp: 250,
		rolling_ftp: null,
		correction_factor: 1,
		confidence: "high",
		warnings: [],
	},
	warnings: [],
});

describe("prescription persistence", () => {
	beforeEach(() => _resetDb());
	afterEach(() => _resetDb());

	it("persists and retrieves a prescription", () => {
		const id = persistPrescription(
			"ze",
			"2026-04-03",
			makeSuggestion(),
			[140, 155, 170, 185, 200],
			"2026-04-03T10:00:00Z",
		);
		expect(id).toBeGreaterThan(0);

		const rx = getPrescription("ze", "2026-04-03", "Run");
		expect(rx).not.toBeNull();
		expect(rx?.title).toBe("Easy Base Run");
		expect(rx?.category).toBe("base");
		expect(rx?.segments).toHaveLength(3);
		expect(rx?.hrZones).toEqual([140, 155, 170, 185, 200]);
	});

	it("returns same ID on duplicate insert", () => {
		const id1 = persistPrescription(
			"ze",
			"2026-04-03",
			makeSuggestion(),
			null,
			"2026-04-03T10:00:00Z",
		);
		const id2 = persistPrescription(
			"ze",
			"2026-04-03",
			makeSuggestion(),
			null,
			"2026-04-03T10:00:00Z",
		);
		expect(id1).toBe(id2);
	});

	it("retrieves prescriptions by date range", () => {
		persistPrescription("ze", "2026-04-01", makeSuggestion(), null, "2026-04-01T10:00:00Z");
		persistPrescription("ze", "2026-04-02", makeSuggestion(), null, "2026-04-02T10:00:00Z");
		persistPrescription("ze", "2026-04-03", makeSuggestion(), null, "2026-04-03T10:00:00Z");

		const all = getPrescriptions("ze", "2026-04-01", "2026-04-03");
		expect(all).toHaveLength(3);

		const subset = getPrescriptions("ze", "2026-04-02", "2026-04-03");
		expect(subset).toHaveLength(2);
	});
});

describe("send event persistence", () => {
	beforeEach(() => _resetDb());
	afterEach(() => _resetDb());

	it("persists and retrieves a send event", () => {
		const rxId = persistPrescription(
			"ze",
			"2026-04-03",
			makeSuggestion(),
			null,
			"2026-04-03T10:00:00Z",
		);
		persistSendEvent(rxId, "ze", "2026-04-03", "Run", "intervals", "evt-123");

		const event = getSendEvent("ze", "2026-04-03", "Run", "intervals");
		expect(event).not.toBeNull();
		expect(event?.externalId).toBe("evt-123");
		expect(event?.prescriptionId).toBe(rxId);
	});

	it("upserts on duplicate", () => {
		const rxId = persistPrescription(
			"ze",
			"2026-04-03",
			makeSuggestion(),
			null,
			"2026-04-03T10:00:00Z",
		);
		persistSendEvent(rxId, "ze", "2026-04-03", "Run", "intervals", "evt-1");
		persistSendEvent(rxId, "ze", "2026-04-03", "Run", "intervals", "evt-2");

		const event = getSendEvent("ze", "2026-04-03", "Run", "intervals");
		expect(event?.externalId).toBe("evt-2");
	});
});

describe("compliance assessment persistence", () => {
	beforeEach(() => _resetDb());
	afterEach(() => _resetDb());

	it("saves and retrieves a full assessment", () => {
		const rxId = persistPrescription(
			"ze",
			"2026-04-03",
			makeSuggestion(),
			[140, 155, 170],
			"2026-04-03T10:00:00Z",
		);

		const segments: SegmentCompliance[] = [
			{
				segmentIndex: 0,
				segmentName: "Warm-up",
				actualAvgHr: 130,
				actualAvgPower: null,
				actualAvgPace: null,
				actualDurationSecs: 600,
				hrZonePass: true,
				powerPass: null,
				pacePass: null,
				durationPass: true,
				hrZoneActual: 1,
				powerDeviationPct: null,
				paceDeviationPct: null,
				segmentPass: true,
				light: "green",
			},
			{
				segmentIndex: 1,
				segmentName: "Main",
				actualAvgHr: 160,
				actualAvgPower: 200,
				actualAvgPace: null,
				actualDurationSecs: 1500,
				hrZonePass: false,
				powerPass: true,
				pacePass: null,
				durationPass: true,
				hrZoneActual: 3,
				powerDeviationPct: 0,
				paceDeviationPct: null,
				segmentPass: false,
				light: "amber",
			},
		];

		saveComplianceAssessment(
			rxId,
			"ze",
			"2026-04-03",
			"Run",
			"act-123",
			"completed",
			null,
			false,
			2,
			1,
			segments,
		);

		const assessment = getComplianceAssessment(rxId);
		expect(assessment).not.toBeNull();
		expect(assessment?.status).toBe("completed");
		expect(assessment?.overallPass).toBe(false);
		expect(assessment?.segmentsTotal).toBe(2);
		expect(assessment?.segmentsPassed).toBe(1);
		expect(assessment?.segments).toHaveLength(2);
		expect(assessment?.segments[0].hrZonePass).toBe(true);
		expect(assessment?.segments[1].hrZonePass).toBe(false);
		expect(assessment?.segments[1].light).toBe("amber");
	});

	it("retrieves by user+date+sport", () => {
		const rxId = persistPrescription(
			"ze",
			"2026-04-03",
			makeSuggestion(),
			null,
			"2026-04-03T10:00:00Z",
		);
		saveComplianceAssessment(
			rxId,
			"ze",
			"2026-04-03",
			"Run",
			null,
			"skipped",
			"rest day",
			false,
			3,
			0,
			[],
		);

		const assessment = getComplianceForDate("ze", "2026-04-03", "Run");
		expect(assessment?.status).toBe("skipped");
		expect(assessment?.skipReason).toBe("rest day");
	});

	it("upserts on re-assessment", () => {
		const rxId = persistPrescription(
			"ze",
			"2026-04-03",
			makeSuggestion(),
			null,
			"2026-04-03T10:00:00Z",
		);

		// First assessment: skipped
		saveComplianceAssessment(
			rxId,
			"ze",
			"2026-04-03",
			"Run",
			null,
			"skipped",
			null,
			false,
			0,
			0,
			[],
		);
		expect(getComplianceAssessment(rxId)?.status).toBe("skipped");

		// Re-assess: completed
		saveComplianceAssessment(
			rxId,
			"ze",
			"2026-04-03",
			"Run",
			"act-1",
			"completed",
			null,
			true,
			3,
			3,
			[],
		);
		expect(getComplianceAssessment(rxId)?.status).toBe("completed");
		expect(getComplianceAssessment(rxId)?.overallPass).toBe(true);
	});
});
