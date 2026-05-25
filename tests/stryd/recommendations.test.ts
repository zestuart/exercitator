import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrydClient } from "../../src/stryd/client.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "stryd-recommendations");

function loadFixture(name: string): unknown {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

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

const config = { email: "test@example.com", password: "secret" };

async function loggedInClient(token = "tok-123", id = "user-456"): Promise<StrydClient> {
	mockFetch.mockResolvedValueOnce(jsonResponse({ token, id }));
	const client = new StrydClient(config);
	await client.login();
	return client;
}

describe("StrydClient.getRecommendedWorkouts", () => {
	it("parses the easy fixture and returns the recommendation set", async () => {
		const client = await loggedInClient();
		const fixture = loadFixture("recommendations-easy-extfalse.json");
		mockFetch.mockResolvedValueOnce(jsonResponse(fixture));

		const set = await client.getRecommendedWorkouts("easy");

		expect(set).not.toBeNull();
		expect(set?.type).toBe("easy");
		expect(set?.user_id).toBe("ed01b284-814d-5b95-52a3-c91e9fd5e86c");
		expect(set?.workouts).toHaveLength(1);

		const ew = set?.workouts[0].estimated_workout;
		expect(ew?.workout.title).toBe("Easy + Strides");
		expect(ew?.workout.type).toBe("stride");
		expect(ew?.workout.id).toBe(5263756623806464);
		expect(ew?.workout.tags).toEqual(["template"]);
		expect(ew?.workout.blocks).toHaveLength(4);
		expect(ew?.workout.blocks[2].repeat).toBe(3);
		expect(ew?.intensity_zones).toEqual([1260, 0, 0, 60, 0]);
		expect(ew?.estimates).toHaveLength(4);

		// Repeat-folding invariant: estimates[2].duration == 240 = 3 * (20 + 60)
		expect(ew?.estimates[2].duration).toBe(240);
		// segment_estimates are per single rep (not folded)
		expect(ew?.estimates[2].segment_estimates[0].duration).toBe(20);

		// Labels are populated (rotate day-to-day — see Phase 0 notes)
		expect(set?.workouts[0].labels).toEqual(["Best match"]);
	});

	it("uses the query-parameter URL form (not path-based) and the Bearer-colon auth header", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(
			jsonResponse(loadFixture("recommendations-easy-extfalse.json")),
		);

		await client.getRecommendedWorkouts("workout");

		const [url, opts] = mockFetch.mock.calls[1];
		const parsed = new URL(url as string);
		expect(parsed.hostname).toBe("api.stryd.com");
		expect(parsed.pathname).toBe("/b/api/v1/users/user-456/workouts/recommendations");
		expect(parsed.searchParams.get("type")).toBe("workout");
		expect(parsed.searchParams.get("extended")).toBe("false");

		// Authorization header uses the Stryd-specific "Bearer:" form (colon).
		expect((opts as RequestInit).headers).toMatchObject({
			Authorization: "Bearer: tok-123",
		});
	});

	it("defaults extended=false and only sends true when explicitly requested", async () => {
		const client = await loggedInClient();
		const fixture = loadFixture("recommendations-easy-extfalse.json");
		// Fresh Response per call — Response bodies can only be read once.
		mockFetch.mockImplementation(async () => jsonResponse(fixture));

		// Default — no third arg
		await client.getRecommendedWorkouts("easy");
		expect(new URL(mockFetch.mock.calls[1][0] as string).searchParams.get("extended")).toBe(
			"false",
		);

		// Explicit false
		await client.getRecommendedWorkouts("easy", false);
		expect(new URL(mockFetch.mock.calls[2][0] as string).searchParams.get("extended")).toBe(
			"false",
		);

		// Explicit true
		await client.getRecommendedWorkouts("easy", true);
		expect(new URL(mockFetch.mock.calls[3][0] as string).searchParams.get("extended")).toBe("true");
	});

	it("returns null on 204 No Content (empty bucket — e.g. long)", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const set = await client.getRecommendedWorkouts("long");
		expect(set).toBeNull();
	});

	it("re-logs-in and retries once on 401 Unauthorized", async () => {
		const client = await loggedInClient("expired-tok", "user-456");

		// First request → 401
		mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
		// Refresh login → new token
		mockFetch.mockResolvedValueOnce(jsonResponse({ token: "fresh-tok", id: "user-456" }));
		// Retry → 200 with fixture
		mockFetch.mockResolvedValueOnce(
			jsonResponse(loadFixture("recommendations-easy-extfalse.json")),
		);

		const set = await client.getRecommendedWorkouts("easy");
		expect(set?.type).toBe("easy");

		// fetch call sequence: [0] initial login, [1] first attempt (401),
		// [2] refresh login, [3] retry (200).
		expect(mockFetch).toHaveBeenCalledTimes(4);

		// First attempt used the original (expired) token
		const [, firstOpts] = mockFetch.mock.calls[1];
		expect((firstOpts as RequestInit).headers).toMatchObject({
			Authorization: "Bearer: expired-tok",
		});

		// Retry used the refreshed token
		const [, retryOpts] = mockFetch.mock.calls[3];
		expect((retryOpts as RequestInit).headers).toMatchObject({
			Authorization: "Bearer: fresh-tok",
		});
	});

	it("throws an informative error on 500 with body excerpt", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(
			new Response('{"message":"internal server error: backend unavailable"}', {
				status: 500,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(client.getRecommendedWorkouts("workout")).rejects.toThrow(
			/getRecommendedWorkouts failed \(HTTP 500\).*internal server error/,
		);
	});

	it("does not retry indefinitely — a second 401 surfaces as an error", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
		mockFetch.mockResolvedValueOnce(jsonResponse({ token: "fresh-tok", id: "user-456" }));
		mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

		await expect(client.getRecommendedWorkouts("easy")).rejects.toThrow(
			/getRecommendedWorkouts failed \(HTTP 401\)/,
		);
	});
});
