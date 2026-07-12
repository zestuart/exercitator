import { afterEach, describe, expect, it, vi } from "vitest";
import { GarminClient } from "../../src/garmin/client.js";

function jsonResponse(body: unknown, { ok = true, status = 200 } = {}): Response {
	return {
		ok,
		status,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function fitResponse(bytes: Uint8Array, { ok = true, status = 200 } = {}): Response {
	return {
		ok,
		status,
		text: async () => "",
		arrayBuffer: async () =>
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	} as unknown as Response;
}

const client = () => new GarminClient({ apiKey: "SECRET", baseUrl: "http://bridge:8655" });

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("GarminClient", () => {
	it("sends a bearer token and parses body battery", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ value: 55, level: "medium" }));
		vi.stubGlobal("fetch", fetchMock);

		const bb = await client().getBodyBatteryCurrent();
		expect(bb).toEqual({ value: 55, level: "medium" });

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://bridge:8655/body_battery/current");
		expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer SECRET" });
	});

	it("builds the hrv_nightly path with the days param", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ wake_day_utc: "2026-07-11", rmssd_median_ms: 42 }]));
		vi.stubGlobal("fetch", fetchMock);

		const rows = await client().getHrvNightly(7);
		expect(rows[0]).toEqual({ wake_day_utc: "2026-07-11", rmssd_median_ms: 42 });
		expect(String(fetchMock.mock.calls[0][0])).toBe("http://bridge:8655/hrv_nightly?days=7");
	});

	it("builds the sleep_nightly path with start+end params", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ wake_date: "2026-07-11", duration_s: 25000 }]));
		vi.stubGlobal("fetch", fetchMock);

		await client().getSleepNightly("2026-07-05", "2026-07-11");
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"http://bridge:8655/sleep_nightly?start=2026-07-05&end=2026-07-11",
		);
	});

	it("throws with the HTTP status on a non-2xx response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ reason: "garmin_reauth_required" }, { ok: false, status: 503 }),
				),
		);
		await expect(client().getBodyBatteryCurrent()).rejects.toThrow(/HTTP 503/);
	});

	it("returns the FIT as a Buffer", async () => {
		const bytes = new Uint8Array([0x0e, 0x10, 0x00, 0x00, 0x2e, 0x46, 0x49, 0x54]);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fitResponse(bytes)));

		const buf = await client().getActivityFit(1234567890);
		expect(Buffer.isBuffer(buf)).toBe(true);
		expect(Uint8Array.from(buf)).toEqual(bytes);
	});

	it("rejects an oversized JSON body", async () => {
		const huge = "x".repeat(600 * 1024);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => huge,
			} as unknown as Response),
		);
		await expect(client().getHrvNightly(7)).rejects.toThrow(/too large/);
	});
});
