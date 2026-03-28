import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntervalsClient } from "../src/intervals.js";

describe("IntervalsClient", () => {
	it("constructs with default athlete ID", () => {
		const client = new IntervalsClient({ apiKey: "test-key" });
		expect(client.athleteId).toBe("0");
	});

	it("constructs with custom athlete ID", () => {
		const client = new IntervalsClient({ apiKey: "test-key", athleteId: "i12345" });
		expect(client.athleteId).toBe("i12345");
	});

	it("throws on non-ok response", async () => {
		const client = new IntervalsClient({ apiKey: "invalid" });
		await expect(client.get("/athlete/0")).rejects.toThrow("intervals.icu");
	});
});

describe("IntervalsClient.uploadFile", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends multipart/form-data without JSON content-type", async () => {
		const mockFetch = vi.mocked(globalThis.fetch);
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "new-act-123" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const client = new IntervalsClient({ apiKey: "test-key" });
		const buffer = Buffer.from([0x2e, 0x46, 0x49, 0x54]);
		const result = await client.uploadFile("/athlete/0/activities", buffer, "test.fit");

		expect(result).toEqual({ id: "new-act-123" });

		// Verify fetch was called with FormData body (not JSON)
		const [, opts] = mockFetch.mock.calls[0];
		expect(opts?.method).toBe("POST");
		expect(opts?.body).toBeInstanceOf(FormData);

		// Verify Content-Type is NOT set to application/json (let fetch set multipart boundary)
		const headers = opts?.headers as Headers;
		expect(headers.get("Content-Type")).toBeNull();

		// Verify auth header is present
		expect(headers.get("Authorization")).toContain("Basic");
	});
});
