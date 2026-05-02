import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrydClient } from "../../src/stryd/client.js";

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("StrydClient", () => {
	const config = { email: "test@example.com", password: "secret" };

	describe("login", () => {
		it("stores token and userId on successful login", async () => {
			mockFetch.mockResolvedValueOnce(
				jsonResponse({ token: "tok-123", id: "user-456", user_name: "Test" }),
			);

			const client = new StrydClient(config);
			await client.login();

			expect(client.isAuthenticated).toBe(true);

			// Verify login request
			const [url, opts] = mockFetch.mock.calls[0];
			expect(url).toBe("https://www.stryd.com/b/email/signin");
			expect(opts.method).toBe("POST");
			expect(JSON.parse(opts.body)).toEqual({ email: "test@example.com", password: "secret" });
		});

		it("throws on authentication failure", async () => {
			mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

			const client = new StrydClient(config);
			await expect(client.login()).rejects.toThrow("Stryd login failed (HTTP 401)");
		});
	});

	describe("listActivities", () => {
		it("fetches activities with correct date format and auth header", async () => {
			// Login first
			mockFetch.mockResolvedValueOnce(jsonResponse({ token: "tok-123", id: "user-456" }));

			const client = new StrydClient(config);
			await client.login();

			// List activities
			mockFetch.mockResolvedValueOnce(
				jsonResponse({
					activities: [
						{
							id: 123,
							timestamp: Math.floor(Date.now() / 1000) - 86400, // yesterday
							distance: 6100,
							elapsed_time: 2220,
							average_power: 265,
						},
					],
				}),
			);

			const activities = await client.listActivities(7);

			expect(activities).toHaveLength(1);
			expect(activities[0].id).toBe(123);

			// Verify auth header format (Bearer: with colon)
			const [url, opts] = mockFetch.mock.calls[1];
			expect(url).toContain("/calendar");
			expect(opts.headers.Authorization).toMatch(/^Bearer: tok-123$/);

			// Verify epoch-based date params
			const parsedUrl = new URL(url);
			expect(parsedUrl.searchParams.get("from")).toMatch(/^\d+$/);
			expect(parsedUrl.searchParams.get("to")).toMatch(/^\d+$/);
			expect(parsedUrl.searchParams.get("include_deleted")).toBe("false");
		});

		it("returns empty array when no activities", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ token: "tok-123", id: "user-456" }));
			const client = new StrydClient(config);
			await client.login();

			mockFetch.mockResolvedValueOnce(jsonResponse({ activities: [] }));
			const activities = await client.listActivities();
			expect(activities).toEqual([]);
		});
	});

	describe("downloadFit", () => {
		it("follows two-step download: signed URL then binary", async () => {
			// Login
			mockFetch.mockResolvedValueOnce(jsonResponse({ token: "tok-123", id: "user-456" }));
			const client = new StrydClient(config);
			await client.login();

			// Step 1: Get signed URL
			const signedUrl = "https://storage.googleapis.com/stryd_pioneer/test.fit?sig=abc";
			mockFetch.mockResolvedValueOnce(jsonResponse({ url: signedUrl }));

			// Step 2: Download binary
			const fitBytes = new Uint8Array([0x2e, 0x46, 0x49, 0x54]); // .FIT magic
			mockFetch.mockResolvedValueOnce(new Response(fitBytes, { status: 200 }));

			const buffer = await client.downloadFit(123456);

			expect(Buffer.isBuffer(buffer)).toBe(true);
			expect(buffer.length).toBe(4);

			// Verify step 1 hit the Stryd API
			const [metaUrl, metaOpts] = mockFetch.mock.calls[1];
			expect(metaUrl).toContain("api.stryd.com");
			expect(metaUrl).toContain("user-456");
			expect(metaUrl).toContain("123456");
			expect(metaOpts.headers.Authorization).toBe("Bearer: tok-123");

			// Verify step 2 hit the signed URL with no auth
			const [fitUrl, fitOpts] = mockFetch.mock.calls[2];
			expect(fitUrl).toBe(signedUrl);
			expect(fitOpts.headers).toBeUndefined();
		});

		it("throws when not authenticated", async () => {
			const client = new StrydClient(config);
			await expect(client.downloadFit(123)).rejects.toThrow("not authenticated");
		});
	});

	describe("getLatestCriticalPower", () => {
		it("returns the most recent CP value with its created timestamp", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ token: "tok-123", id: "user-456" }));
			const client = new StrydClient(config);
			await client.login();

			mockFetch.mockResolvedValueOnce(
				jsonResponse([
					{ critical_power: 265.5, created: 1774500000 },
					{ critical_power: 279.45, created: 1774673033 }, // most recent
					{ critical_power: 270.0, created: 1774000000 },
				]),
			);

			const result = await client.getLatestCriticalPower();
			expect(result).not.toBeNull();
			expect(result?.criticalPower).toBeCloseTo(279.45);
			expect(result?.createdAt).toBe(1774673033);

			// Verify URL contains cp/history
			const [url] = mockFetch.mock.calls[1];
			expect(url).toContain("cp/history");
			expect(url).toContain("startDate=");
		});

		it("returns null when no CP entries", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ token: "tok-123", id: "user-456" }));
			const client = new StrydClient(config);
			await client.login();

			mockFetch.mockResolvedValueOnce(jsonResponse([]));
			const result = await client.getLatestCriticalPower();
			expect(result).toBeNull();
		});

		it("skips entries with created=0", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ token: "tok-123", id: "user-456" }));
			const client = new StrydClient(config);
			await client.login();

			mockFetch.mockResolvedValueOnce(jsonResponse([{ critical_power: 269.26, created: 0 }]));
			const result = await client.getLatestCriticalPower();
			expect(result).toBeNull();
		});
	});
});
