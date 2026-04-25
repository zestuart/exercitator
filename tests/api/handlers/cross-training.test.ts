import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleCrossTrainingRpe } from "../../../src/api/handlers/cross-training.js";
import type { UserContext } from "../../../src/api/router.js";
import type { IntervalsClient } from "../../../src/intervals.js";
import type { UserProfile } from "../../../src/users.js";

function makeReq(body: unknown): IncomingMessage {
	const emitter = new EventEmitter() as EventEmitter & {
		url: string;
		headers: Record<string, string>;
	};
	emitter.url = "/";
	emitter.headers = { host: "localhost" };
	const req = emitter as unknown as IncomingMessage;
	setImmediate(() => {
		if (body !== undefined) emitter.emit("data", Buffer.from(JSON.stringify(body)));
		emitter.emit("end");
	});
	// req.destroy is used for body size — stub it out
	(req as unknown as { destroy: () => void }).destroy = () => {};
	return req;
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

const PROFILE: UserProfile = {
	id: "ze",
	displayName: "Ze",
	sports: ["Run"],
	deities: false,
	stryd: false,
	apiKeyEnv: "INTERVALS_ICU_API_KEY",
	strydEmailEnv: null,
	strydPasswordEnv: null,
};

function makeUser(
	activityResp: Record<string, unknown> | null = { id: "1", moving_time: 2400 },
	putShouldThrow = false,
): { user: UserContext; put: ReturnType<typeof vi.fn> } {
	const put = putShouldThrow
		? vi.fn().mockRejectedValue(new Error("upstream 500"))
		: vi.fn().mockResolvedValue({});
	const client = {
		athleteId: "0",
		get: vi.fn().mockImplementation((path: string) => {
			if (path.startsWith("/activity/")) {
				if (activityResp === null) return Promise.reject(new Error("not found"));
				return Promise.resolve(activityResp);
			}
			return Promise.reject(new Error(`unexpected path: ${path}`));
		}),
		put,
		post: vi.fn(),
		delete: vi.fn(),
		request: vi.fn(),
	} as unknown as IntervalsClient;
	return { user: { profile: PROFILE, intervals: client, stryd: null }, put };
}

describe("handleCrossTrainingRpe", () => {
	it("writes RPE to intervals.icu and returns strain tier", async () => {
		const { user, put } = makeUser({
			id: "1",
			moving_time: 2400,
			start_date_local: "2099-01-01T06:00:00",
		});
		const res = fakeRes();
		await handleCrossTrainingRpe(makeReq({ rpe: 6 }), res, user, "1");
		expect(res._status).toBe(200);
		expect(put).toHaveBeenCalledWith("/activity/1", { perceived_exertion: 6 });
		const body = JSON.parse(res._body ?? "{}");
		expect(body.rpe).toBe(6);
		// session_rpe = 6 × 2400 = 14_400 → hard tier
		expect(body.strain_tier).toBe("hard");
	});

	it("rejects rpe out of range", async () => {
		const { user } = makeUser();
		const res = fakeRes();
		await handleCrossTrainingRpe(makeReq({ rpe: 11 }), res, user, "1");
		expect(res._status).toBe(400);
	});

	it("rejects non-numeric rpe", async () => {
		const { user } = makeUser();
		const res = fakeRes();
		await handleCrossTrainingRpe(makeReq({ rpe: "six" }), res, user, "1");
		expect(res._status).toBe(400);
	});

	it("returns 404 when activity does not exist", async () => {
		const { user } = makeUser(null);
		const res = fakeRes();
		await handleCrossTrainingRpe(makeReq({ rpe: 5 }), res, user, "missing");
		expect(res._status).toBe(404);
	});

	it("returns 502 when intervals.icu write fails", async () => {
		const { user } = makeUser({ id: "1", moving_time: 1800 }, true);
		const res = fakeRes();
		await handleCrossTrainingRpe(makeReq({ rpe: 5 }), res, user, "1");
		expect(res._status).toBe(502);
	});
});
