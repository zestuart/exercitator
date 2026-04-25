import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { type ApiKey, parseApiKeys, requireBearer } from "../../src/api/auth.js";

function fakeReq(headers: Record<string, string>): IncomingMessage {
	return { headers } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status?: number; _body?: string } {
	const res = {
		headersSent: false,
		_status: undefined as number | undefined,
		_body: undefined as string | undefined,
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

describe("parseApiKeys", () => {
	it("parses well-formed comma-separated triples", () => {
		const keys = parseApiKeys("excubitor-ios:ze:aaaa,excubitor-watchos:pam:bbbb");
		expect(keys).toHaveLength(2);
		expect(keys[0].client).toBe("excubitor-ios");
		expect(keys[0].userId).toBe("ze");
		expect(keys[0].token).toBe("aaaa");
		expect(keys[1].userId).toBe("pam");
	});

	it("tolerates whitespace and blank entries", () => {
		const keys = parseApiKeys(" a:b:c , , x:y:z ");
		expect(keys).toHaveLength(2);
	});

	it("skips malformed entries (<3 parts)", () => {
		const keys = parseApiKeys("too:few,a:b:c");
		expect(keys).toHaveLength(1);
	});

	it("returns empty on empty/undefined input", () => {
		expect(parseApiKeys(undefined)).toEqual([]);
		expect(parseApiKeys("")).toEqual([]);
	});

	it("preserves colons inside the token portion", () => {
		const keys = parseApiKeys("cli:uid:abc:def:ghi");
		expect(keys).toHaveLength(1);
		expect(keys[0].token).toBe("abc:def:ghi");
	});
});

describe("requireBearer", () => {
	const keys: ApiKey[] = parseApiKeys(
		"excubitor-ios:ze:ze-secret-token,excubitor-ios:pam:pam-secret-token",
	);

	it("returns 401 when Authorization header is missing", () => {
		const req = fakeReq({});
		const res = fakeRes();
		const out = requireBearer(req, res, { keys }, "ze");
		expect(out).toBeNull();
		expect(res._status).toBe(401);
	});

	it("returns 401 when bearer is present but does not match", () => {
		const req = fakeReq({ authorization: "Bearer excubitor-ios:ze:wrong-token" });
		const res = fakeRes();
		const out = requireBearer(req, res, { keys }, "ze");
		expect(out).toBeNull();
		expect(res._status).toBe(401);
	});

	it("returns 401 when bearer format is malformed", () => {
		const req = fakeReq({ authorization: "Bearer no-colons" });
		const res = fakeRes();
		const out = requireBearer(req, res, { keys }, "ze");
		expect(out).toBeNull();
		expect(res._status).toBe(401);
	});

	it("returns 200 path when bearer matches and userId lines up", () => {
		const req = fakeReq({ authorization: "Bearer excubitor-ios:ze:ze-secret-token" });
		const res = fakeRes();
		const out = requireBearer(req, res, { keys }, "ze");
		expect(out).not.toBeNull();
		expect(out?.userId).toBe("ze");
		expect(res._status).toBeUndefined();
	});

	it("returns 403 when bearer is valid but path userId mismatches", () => {
		const req = fakeReq({ authorization: "Bearer excubitor-ios:ze:ze-secret-token" });
		const res = fakeRes();
		const out = requireBearer(req, res, { keys }, "pam");
		expect(out).toBeNull();
		expect(res._status).toBe(403);
	});

	it("accepts a bearer without enforcing userId match when pathUserId is null", () => {
		const req = fakeReq({ authorization: "Bearer excubitor-ios:ze:ze-secret-token" });
		const res = fakeRes();
		const out = requireBearer(req, res, { keys }, null);
		expect(out).not.toBeNull();
		expect(res._status).toBeUndefined();
	});
});
