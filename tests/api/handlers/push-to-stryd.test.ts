import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserContext } from "../../../src/api/router.js";
import type { IntervalsClient } from "../../../src/intervals.js";
import type { StrydClient } from "../../../src/stryd/client.js";
import type { UserProfile } from "../../../src/users.js";

const { sendToStrydMock } = vi.hoisted(() => ({ sendToStrydMock: vi.fn() }));
vi.mock("../../../src/web/send-stryd.js", () => ({
	sendToStryd: (...args: unknown[]) => sendToStrydMock(...args),
}));

import { handlePushToStryd } from "../../../src/api/handlers/push-to-stryd.js";

function makeReq(): IncomingMessage {
	const e = new EventEmitter() as EventEmitter & {
		url: string;
		headers: Record<string, string>;
	};
	e.url = "/";
	e.headers = { host: "localhost" };
	return e as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status?: number; _body?: string } {
	const res = {
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
	return res as unknown as ServerResponse & { _status?: number; _body?: string };
}

const RUN_PROFILE: UserProfile = {
	id: "ze",
	displayName: "Ze",
	sports: ["Run", "Swim"],
	deities: false,
	stryd: true,
	apiKeyEnv: "INTERVALS_ICU_API_KEY",
	strydEmailEnv: "STRYD_EMAIL",
	strydPasswordEnv: "STRYD_PASSWORD",
};

const SWIM_ONLY_PROFILE: UserProfile = { ...RUN_PROFILE, sports: ["Swim"] };

const NO_STRYD_PROFILE: UserProfile = {
	...RUN_PROFILE,
	stryd: false,
	strydEmailEnv: null,
	strydPasswordEnv: null,
};

function makeUser(profile: UserProfile, withStryd: boolean): UserContext {
	// `intervals.get` is consulted by resolveTz to fall back to the athlete
	// profile timezone when `?tz` is missing or invalid. Tests deliberately
	// reject so resolveTz drops to "UTC" — keeps the handler tests focused
	// on the gate/delegation contract.
	const intervals = {
		athleteId: "0",
		get: vi.fn().mockRejectedValue(new Error("no profile in test")),
	} as unknown as IntervalsClient;
	const stryd = withStryd ? ({} as StrydClient) : null;
	return { profile, intervals, stryd };
}

describe("handlePushToStryd", () => {
	beforeEach(() => sendToStrydMock.mockReset());

	it("returns 400 when user has no Run sport", async () => {
		const res = fakeRes();
		await handlePushToStryd(
			makeReq(),
			res,
			makeUser(SWIM_ONLY_PROFILE, false),
			new URL("http://localhost/api/users/ze/push-to-stryd"),
		);
		expect(res._status).toBe(400);
		expect(sendToStrydMock).not.toHaveBeenCalled();
	});

	it("returns 400 when Stryd is not configured for the user", async () => {
		const res = fakeRes();
		await handlePushToStryd(
			makeReq(),
			res,
			makeUser(NO_STRYD_PROFILE, false),
			new URL("http://localhost/api/users/ze/push-to-stryd"),
		);
		expect(res._status).toBe(400);
		expect(sendToStrydMock).not.toHaveBeenCalled();
	});

	it("returns 400 when profile says stryd:true but the StrydClient is missing", async () => {
		// Defence-in-depth — should never happen in production (server.ts builds
		// the client when env vars are present) but the gate must hold.
		const res = fakeRes();
		await handlePushToStryd(
			makeReq(),
			res,
			makeUser(RUN_PROFILE, false),
			new URL("http://localhost/api/users/ze/push-to-stryd"),
		);
		expect(res._status).toBe(400);
		expect(sendToStrydMock).not.toHaveBeenCalled();
	});

	it("delegates to sendToStryd, passing force and tz from query", async () => {
		const res = fakeRes();
		const user = makeUser(RUN_PROFILE, true);
		await handlePushToStryd(
			makeReq(),
			res,
			user,
			new URL("http://localhost/api/users/ze/push-to-stryd?force=true&tz=Europe/London"),
		);
		expect(sendToStrydMock).toHaveBeenCalledTimes(1);
		const args = sendToStrydMock.mock.calls[0];
		// sendToStryd signature: (client, profile, strydClient, res, force, tz)
		expect(args[0]).toBe(user.intervals);
		expect(args[1]).toBe(user.profile);
		expect(args[2]).toBe(user.stryd);
		expect(args[3]).toBe(res);
		expect(args[4]).toBe(true);
		expect(args[5]).toBe("Europe/London");
	});

	it("defaults force to false and tz to UTC when omitted (no profile fallback in test)", async () => {
		const res = fakeRes();
		await handlePushToStryd(
			makeReq(),
			res,
			makeUser(RUN_PROFILE, true),
			new URL("http://localhost/api/users/ze/push-to-stryd"),
		);
		const args = sendToStrydMock.mock.calls[0];
		expect(args[4]).toBe(false);
		expect(args[5]).toBe("UTC");
	});

	it("treats force=1 (or any non-'true' value) as false", async () => {
		// Matches Praescriptor's existing exact-string check (`=== 'true'`).
		const res = fakeRes();
		await handlePushToStryd(
			makeReq(),
			res,
			makeUser(RUN_PROFILE, true),
			new URL("http://localhost/api/users/ze/push-to-stryd?force=1"),
		);
		expect(sendToStrydMock.mock.calls[0][4]).toBe(false);
	});

	it("rejects a crafted invalid tz to UTC instead of crashing", async () => {
		// Defence-in-depth: an unvalidated tz reaches `localDateStr` →
		// `Intl.DateTimeFormat` → RangeError → DoS. resolveTz must drop a
		// crafted value (`a/a`) to UTC.
		const res = fakeRes();
		await handlePushToStryd(
			makeReq(),
			res,
			makeUser(RUN_PROFILE, true),
			new URL("http://localhost/api/users/ze/push-to-stryd?tz=a/a"),
		);
		expect(sendToStrydMock.mock.calls[0][5]).toBe("UTC");
	});
});
