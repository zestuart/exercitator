/**
 * Wire-format contract test for `sendToStryd`.
 *
 * Excubitor (iOS Codable) decodes `workout_id` and `calendar_id` as numbers.
 * The 200 path emits them as numbers; the 409 (duplicate) path was reading
 * `external_id` straight back from SQLite (TEXT) and emitting it as a string —
 * a Swift `typeMismatch` waiting to happen. This test pins both paths.
 */

import type { ServerResponse } from "node:http";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Use in-memory DB BEFORE importing anything that touches it.
process.env.EXERCITATOR_DB_PATH = ":memory:";

// Hoisted mock control points — referenced by vi.mock factories below.
const { generatePrescriptionsMock, toStrydWorkoutMock } = vi.hoisted(() => ({
	generatePrescriptionsMock: vi.fn(),
	toStrydWorkoutMock: vi.fn(),
}));

vi.mock("../../src/web/prescriptions.js", () => ({
	generatePrescriptions: (...args: unknown[]) => generatePrescriptionsMock(...args),
}));
vi.mock("../../src/web/stryd-format.js", () => ({
	toStrydWorkout: (...args: unknown[]) => toStrydWorkoutMock(...args),
}));

import { persistPrescription, persistSendEvent } from "../../src/compliance/persist.js";
import { _resetDb } from "../../src/db.js";
import { localDateStr } from "../../src/engine/date-utils.js";
import type { WorkoutSuggestion } from "../../src/engine/types.js";
import type { IntervalsClient } from "../../src/intervals.js";
import type { StrydClient } from "../../src/stryd/client.js";
import type { UserProfile } from "../../src/users.js";
import { sendToStryd } from "../../src/web/send-stryd.js";

const PROFILE: UserProfile = {
	id: "ze",
	displayName: "Ze",
	sports: ["Run"],
	deities: false,
	stryd: true,
	apiKeyEnv: "INTERVALS_ICU_API_KEY",
	strydEmailEnv: "STRYD_EMAIL",
	strydPasswordEnv: "STRYD_PASSWORD",
};

function makeSuggestion(): WorkoutSuggestion {
	return {
		sport: "Run",
		category: "base",
		title: "Easy Base Run",
		rationale: "Recovery day",
		total_duration_secs: 2400,
		estimated_load: 45,
		segments: [
			{
				name: "Warm-up",
				duration_secs: 600,
				target_description: "Easy Z1",
				target_hr_zone: 1,
			},
			{
				name: "Main",
				duration_secs: 1500,
				target_description: "Z2 steady",
				target_hr_zone: 2,
				target_power_low: 180,
				target_power_high: 220,
			},
			{
				name: "Cool-down",
				duration_secs: 300,
				target_description: "Easy",
				target_hr_zone: 1,
			},
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
	};
}

function fakeRes(): ServerResponse & {
	_status?: number;
	_body?: string;
	_headers?: Record<string, string>;
} {
	const r = {
		headersSent: false,
		_status: undefined as number | undefined,
		_body: undefined as string | undefined,
		_headers: undefined as Record<string, string> | undefined,
		setHeader() {},
		writeHead(status: number, headers?: Record<string, string>) {
			this._status = status;
			this._headers = headers;
			this.headersSent = true;
			return this;
		},
		end(body?: string) {
			this._body = body;
			return this;
		},
	};
	return r as unknown as ServerResponse & {
		_status?: number;
		_body?: string;
		_headers?: Record<string, string>;
	};
}

const intervalsClient = {
	athleteId: "0",
	get: vi.fn(),
	put: vi.fn(),
	post: vi.fn(),
	delete: vi.fn(),
	request: vi.fn(),
} as unknown as IntervalsClient;

function makeStrydClientStub(opts: { workoutId: number; calendarId: number }): StrydClient {
	return {
		isAuthenticated: true,
		login: vi.fn().mockResolvedValue(undefined),
		createWorkout: vi.fn().mockResolvedValue(opts.workoutId),
		scheduleWorkout: vi.fn().mockResolvedValue({
			id: opts.calendarId,
			stress: 42,
			duration: 2400,
			distance: 8000,
		}),
		deleteCalendarEntry: vi.fn().mockResolvedValue(undefined),
	} as unknown as StrydClient;
}

describe("sendToStryd response wire types", () => {
	beforeAll(() => {
		generatePrescriptionsMock.mockResolvedValue({ run: makeSuggestion(), swim: null });
		toStrydWorkoutMock.mockReturnValue({ name: "stub", duration: 2400, blocks: [] });
	});

	beforeEach(() => _resetDb());
	afterEach(() => _resetDb());

	it("emits numeric workout_id and calendar_id on the 200 (success) path", async () => {
		const res = fakeRes();
		const stryd = makeStrydClientStub({ workoutId: 9_876_543, calendarId: 1_234_567 });

		// Pre-persist a prescription so the send event will be written
		// (sendToStryd only persists when a same-day prescription row exists).
		const today = localDateStr(new Date());
		persistPrescription("ze", today, makeSuggestion(), null, new Date().toISOString());

		await sendToStryd(intervalsClient, PROFILE, stryd, res);

		expect(res._status).toBe(200);
		const body = JSON.parse(res._body ?? "{}");
		expect(body.success).toBe(true);
		expect(typeof body.workout_id).toBe("number");
		expect(typeof body.calendar_id).toBe("number");
		expect(body.workout_id).toBe(9_876_543);
		expect(body.calendar_id).toBe(1_234_567);
		// Bonus: integer load metrics
		expect(typeof body.duration_mins).toBe("number");
		expect(Number.isInteger(body.duration_mins)).toBe(true);
		expect(typeof body.distance_m).toBe("number");
		expect(Number.isInteger(body.distance_m)).toBe(true);
	});

	it("emits numeric workout_id and calendar_id on the 409 (duplicate) path", async () => {
		// Seed an existing send event — exactly what a prior 200 response would have written.
		const today = localDateStr(new Date());
		const rxId = persistPrescription("ze", today, makeSuggestion(), null, new Date().toISOString());
		const workoutId = 7_654_321;
		const calendarId = 2_468_013;
		persistSendEvent(rxId, "ze", today, "Run", "stryd", String(workoutId), {
			calendarId,
			stress: 42,
			duration: 2400,
			distance: 8000,
		});

		const res = fakeRes();
		// strydClient should never be touched on the dedup path; pass a stub that
		// would throw if it were invoked, to make accidental calls visible.
		const stryd = {
			isAuthenticated: true,
			login: vi.fn().mockRejectedValue(new Error("must not login")),
			createWorkout: vi.fn().mockRejectedValue(new Error("must not create")),
			scheduleWorkout: vi.fn().mockRejectedValue(new Error("must not schedule")),
			deleteCalendarEntry: vi.fn(),
		} as unknown as StrydClient;

		await sendToStryd(intervalsClient, PROFILE, stryd, res, false);

		expect(res._status).toBe(409);
		const body = JSON.parse(res._body ?? "{}");
		expect(body.success).toBe(false);
		expect(body.duplicate).toBe(true);
		expect(typeof body.workout_id).toBe("number");
		expect(typeof body.calendar_id).toBe("number");
		expect(body.workout_id).toBe(workoutId);
		expect(body.calendar_id).toBe(calendarId);
	});
});

describe("sendToStryd argument forwarding and status guard", () => {
	beforeEach(() => {
		_resetDb();
		generatePrescriptionsMock.mockReset();
		toStrydWorkoutMock.mockReset();
		toStrydWorkoutMock.mockReturnValue({ name: "stub", duration: 2400, blocks: [] });
	});
	afterEach(() => _resetDb());

	it("forwards strydClient and tz to generatePrescriptions", async () => {
		// Regression for 2026-06-03: the regen omitted both args, so it computed
		// "today" in UTC (wrong day → health_unavailable) and skipped the Stryd
		// swap on a cold cache. Pin the call site.
		generatePrescriptionsMock.mockResolvedValue({ run: makeSuggestion(), swim: null });
		const res = fakeRes();
		const stryd = makeStrydClientStub({ workoutId: 1, calendarId: 2 });

		await sendToStryd(intervalsClient, PROFILE, stryd, res, false, "America/Los_Angeles");

		expect(generatePrescriptionsMock).toHaveBeenCalledWith(
			intervalsClient,
			PROFILE,
			stryd,
			undefined,
			"America/Los_Angeles",
		);
	});

	it("refuses a health_unavailable suggestion (422, no Stryd writes)", async () => {
		generatePrescriptionsMock.mockResolvedValue({
			run: {
				...makeSuggestion(),
				status: "health_unavailable",
				healthUnavailableMessage: "WHOOP not synced.",
			},
			swim: null,
		});
		const res = fakeRes();
		const stryd = makeStrydClientStub({ workoutId: 1, calendarId: 2 });

		await sendToStryd(intervalsClient, PROFILE, stryd, res, false, "America/Los_Angeles");

		expect(res._status).toBe(422);
		const body = JSON.parse(res._body ?? "{}");
		expect(body.not_sendable).toBe(true);
		expect(body.status).toBe("health_unavailable");
		expect(body.error).toBe("WHOOP not synced.");
		expect(stryd.createWorkout).not.toHaveBeenCalled();
		expect(stryd.scheduleWorkout).not.toHaveBeenCalled();
	});
});
