import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleStatus } from "../../../src/api/handlers/status.js";
import type { UserContext } from "../../../src/api/router.js";
import type { IntervalsClient } from "../../../src/intervals.js";
import type { UserProfile } from "../../../src/users.js";

function fakeReq(): IncomingMessage {
	return {
		headers: { host: "localhost" },
		url: "/api/users/ze/status",
	} as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status?: number; _body?: string } {
	const res = {
		headersSent: false,
		_status: undefined as number | undefined,
		_body: undefined as string | undefined,
		_headers: {} as Record<string, string>,
		setHeader(k: string, v: string) {
			this._headers[k] = v;
		},
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
	return res as unknown as ServerResponse & { _status?: number; _body?: string };
}

function loadFixture(name: string): unknown {
	return JSON.parse(readFileSync(resolve(__dirname, "../../fixtures", name), "utf-8"));
}

const ZE_PROFILE: UserProfile = {
	id: "ze",
	displayName: "Ze",
	sports: ["Run", "Swim"],
	deities: true,
	stryd: false, // disable so status handler doesn't try Stryd login
	apiKeyEnv: "INTERVALS_ICU_API_KEY",
	strydEmailEnv: null,
	strydPasswordEnv: null,
};

function makeMockIntervals(): IntervalsClient {
	const activities = loadFixture("activities-14d.json");
	const wellness = loadFixture("wellness-7d.json");
	const runSettings = loadFixture("sport-settings-run.json");
	const swimSettings = loadFixture("sport-settings-swim.json");
	const mockGet = vi.fn().mockImplementation((path: string) => {
		if (path.includes("/activities")) return Promise.resolve(activities);
		if (path.includes("/wellness")) return Promise.resolve(wellness);
		if (path.includes("sport-settings/Run")) return Promise.resolve(runSettings);
		if (path.includes("sport-settings/Swim")) return Promise.resolve(swimSettings);
		if (path.match(/^\/athlete\/\w+$/)) return Promise.resolve({ timezone: "UTC" });
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

describe("handleStatus", () => {
	it("returns a well-formed status response", async () => {
		const user: UserContext = {
			profile: ZE_PROFILE,
			intervals: makeMockIntervals(),
			stryd: null,
		};
		const res = fakeRes();
		await handleStatus(fakeReq(), res, user);
		expect(res._status).toBe(200);
		const body = JSON.parse(res._body ?? "{}");
		expect(body.user_id).toBe("ze");
		expect(body).toHaveProperty("readiness");
		expect(body).toHaveProperty("critical_power");
		expect(body).toHaveProperty("training_load");
		expect(body).toHaveProperty("injury_warning");
		expect(body.readiness.tier).toBeDefined();
		expect(["ready", "caution", "recover", "unknown"]).toContain(body.readiness.tier);
	});

	it("sets private Cache-Control header", async () => {
		const user: UserContext = {
			profile: { ...ZE_PROFILE, id: "ze-cc-test" },
			intervals: makeMockIntervals(),
			stryd: null,
		};
		const res = fakeRes() as ServerResponse & {
			_headers: Record<string, string>;
			_status?: number;
		};
		await handleStatus(fakeReq(), res, user);
		expect(res._headers["Cache-Control"]).toContain("private");
	});
});
