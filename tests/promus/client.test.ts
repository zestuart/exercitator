import { afterEach, describe, expect, it, vi } from "vitest";
import { PromusClient } from "../../src/promus/client.js";

function mockFetchOnce(body: unknown, init: { status?: number } = {}): void {
	const status = init.status ?? 200;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: status >= 200 && status < 300,
			status,
			text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
		})),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PromusClient", () => {
	const client = new PromusClient({ apiKey: "palaestra-test", baseUrl: "https://promus.example" });

	it("GETs the WHOOP sleep endpoint with bearer auth and date params", async () => {
		const rows = [{ wake_date: "2026-06-03", duration_s: 27000 }];
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify(rows),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const out = await client.getWhoopSleep("TEST-WHOOP-SERIAL", "2026-05-27", "2026-06-03");
		expect(out).toEqual(rows);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/whoop/TEST-WHOOP-SERIAL/sleep");
		expect(url).toContain("start_date=2026-05-27");
		expect(url).toContain("end_date=2026-06-03");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer palaestra-test");
	});

	it("GETs WHOOP nightly HRV with a days param", async () => {
		const rows = [{ wake_day_utc: "2026-06-03", rmssd_median_ms: 60 }];
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify(rows),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const out = await client.getWhoopHrvNightly("TEST-WHOOP-SERIAL", 7);
		expect(out).toEqual(rows);
		expect((fetchMock.mock.calls[0] as [string])[0]).toContain("hrv_nightly?days=7");
	});

	it("throws with the status code on a non-2xx response", async () => {
		mockFetchOnce("upstream boom", { status: 503 });
		await expect(client.getWhoopSleep("S", "2026-06-01", "2026-06-03")).rejects.toThrow(/HTTP 503/);
	});

	it("percent-encodes the serial to avoid path injection", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "[]" }));
		vi.stubGlobal("fetch", fetchMock);
		await client.getWhoopSleep("../../etc", "2026-06-01", "2026-06-03");
		expect((fetchMock.mock.calls[0] as [string])[0]).toContain("%2F");
	});
});
