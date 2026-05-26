import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormClient, type FormOAuthResponse } from "../../src/form/client.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "form-personalized");

function loadFixture(name: string): unknown {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.restoreAllMocks();
	mockFetch.mockReset();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function liveOAuth(overrides: Partial<FormOAuthResponse> = {}): FormOAuthResponse {
	const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	const inOneMonth = new Date(Date.now() + 30 * 86_400_000).toISOString();
	return {
		accessToken: { token: "live-access", expires: inOneHour, type: "Bearer" },
		refreshToken: { token: "live-refresh", expires: inOneMonth, type: "Bearer" },
		scope: "user",
		clientId: "test-client",
		userId: "user-uuid",
		...overrides,
	};
}

function makeClient(cachePath: string | null = null): FormClient {
	return new FormClient({ email: "ze@example.com", password: "secret", cachePath });
}

describe("FormClient — auth cascade", () => {
	it("uses cached access token when alive", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "form-cache-"));
		const cachePath = join(tmp, "oauth.json");
		try {
			// Pre-seed an alive cache via a first client+saveCache cycle.
			const seeder = makeClient(cachePath);
			mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
			await seeder.acquireToken(true); // forces login, writes cache

			// New client should now read the cache, not hit the wire.
			mockFetch.mockReset();
			const client = makeClient(cachePath);
			const oauth = await client.acquireToken();
			expect(oauth.accessToken.token).toBe("live-access");
			expect(mockFetch).not.toHaveBeenCalled();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("refreshes when access is expired but refresh is alive", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "form-cache-"));
		const cachePath = join(tmp, "oauth.json");
		try {
			const expired = new Date(Date.now() - 60_000).toISOString();
			const aliveRefresh = new Date(Date.now() + 30 * 86_400_000).toISOString();
			// Seed the cache directly via the first client's saveCache path.
			const seeder = makeClient(cachePath);
			mockFetch.mockResolvedValueOnce(
				jsonResponse(
					liveOAuth({
						accessToken: { token: "old-access", expires: expired, type: "Bearer" },
						refreshToken: { token: "old-refresh", expires: aliveRefresh, type: "Bearer" },
					}),
				),
			);
			await seeder.acquireToken(true);

			// New client reads cache → access dead, refresh alive → POST /refresh.
			mockFetch.mockReset();
			mockFetch.mockResolvedValueOnce(
				jsonResponse(
					liveOAuth({
						accessToken: { token: "refreshed-access", expires: aliveRefresh, type: "Bearer" },
					}),
				),
			);
			const client = makeClient(cachePath);
			const oauth = await client.acquireToken();
			expect(oauth.accessToken.token).toBe("refreshed-access");

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, opts] = mockFetch.mock.calls[0];
			expect(String(url)).toMatch(/\/oauth\/token\/refresh$/);
			expect((opts as RequestInit).method).toBe("POST");
			const body = JSON.parse((opts as RequestInit).body as string);
			expect(body).toEqual({ refreshToken: "old-refresh" });
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("falls back to full login when refresh fails", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "form-cache-"));
		const cachePath = join(tmp, "oauth.json");
		try {
			const expired = new Date(Date.now() - 60_000).toISOString();
			const aliveRefresh = new Date(Date.now() + 30 * 86_400_000).toISOString();
			const seeder = makeClient(cachePath);
			mockFetch.mockResolvedValueOnce(
				jsonResponse(
					liveOAuth({
						accessToken: { token: "old-access", expires: expired, type: "Bearer" },
						refreshToken: { token: "old-refresh", expires: aliveRefresh, type: "Bearer" },
					}),
				),
			);
			await seeder.acquireToken(true);

			mockFetch.mockReset();
			// Refresh → 401
			mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
			// Login → 200
			mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));

			const client = makeClient(cachePath);
			const oauth = await client.acquireToken();
			expect(oauth.accessToken.token).toBe("live-access");
			expect(mockFetch).toHaveBeenCalledTimes(2);
			expect(String(mockFetch.mock.calls[1][0])).toMatch(/\/oauth\/token$/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("login uses Basic client-creds header + JSON body", async () => {
		const client = makeClient(null);
		mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
		await client.acquireToken();

		const [url, opts] = mockFetch.mock.calls[0];
		expect(String(url)).toMatch(/\/oauth\/token$/);
		expect((opts as RequestInit).method).toBe("POST");
		const headers = (opts as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
		expect(headers["X-form-app-version"]).toBe("3.19.1");
		expect(headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse((opts as RequestInit).body as string);
		expect(body).toEqual({ email: "ze@example.com", password: "secret" });
	});

	it("saves cache with mode 0600 after a successful login", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "form-cache-"));
		const cachePath = join(tmp, "oauth.json");
		try {
			const client = makeClient(cachePath);
			mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
			await client.acquireToken();

			const mode = statSync(cachePath).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("throws an informative error on login failure", async () => {
		const client = makeClient(null);
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					code: 404,
					error: "email_password_incorrect",
					description: "...",
				}),
				{ status: 404 },
			),
		);
		await expect(client.acquireToken()).rejects.toThrow(
			/FORM login failed \(HTTP 404\).*email_password_incorrect/,
		);
	});
});

describe("FormClient.getPersonalizedWorkouts", () => {
	it("parses the personalised fixture and returns the recommendation set", async () => {
		const client = makeClient(null);
		mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
		mockFetch.mockResolvedValueOnce(jsonResponse(loadFixture("personalized.json")));

		const set = await client.getPersonalizedWorkouts();

		expect(set.workouts).toHaveLength(3);
		const recommended = set.workouts.filter((w) => w.isRecommended);
		expect(recommended).toHaveLength(1);
		expect(recommended[0].type).toBe("Endurance");
		expect(recommended[0].workout.name).toBe("Better As You Go");
		expect(recommended[0].workout.id).toBe("019e4703-1297-7551-b6a9-1e445eabbc1b");
		expect(recommended[0].workout.distance).toBe(1550);
		expect(recommended[0].workout.intensityLevel).toBe("moderate");
	});

	it("hits the canonical personalised URL with Bearer + X-form-app-version", async () => {
		const client = makeClient(null);
		mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
		mockFetch.mockResolvedValueOnce(jsonResponse(loadFixture("personalized.json")));

		await client.getPersonalizedWorkouts();

		const [url, opts] = mockFetch.mock.calls[1];
		const parsed = new URL(String(url));
		expect(parsed.hostname).toBe("app.formathletica.com");
		expect(parsed.pathname).toBe("/api/v1/users/me/workouts/smart_coach/personalized");
		const headers = (opts as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer live-access");
		expect(headers["X-form-app-version"]).toBe("3.19.1");
	});

	it("invalidates cache + retries once on 401", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "form-cache-"));
		const cachePath = join(tmp, "oauth.json");
		try {
			const client = makeClient(cachePath);
			// Initial login
			mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
			// First personalised call → 401
			mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
			// Forced re-login after cache invalidation
			mockFetch.mockResolvedValueOnce(
				jsonResponse(
					liveOAuth({
						accessToken: {
							token: "post-401",
							expires: new Date(Date.now() + 3600_000).toISOString(),
							type: "Bearer",
						},
					}),
				),
			);
			// Retry succeeds
			mockFetch.mockResolvedValueOnce(jsonResponse(loadFixture("personalized.json")));

			const set = await client.getPersonalizedWorkouts();
			expect(set.workouts).toHaveLength(3);
			expect(mockFetch).toHaveBeenCalledTimes(4);

			// First personalised attempt used the original token
			expect((mockFetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({
				Authorization: "Bearer live-access",
			});
			// Retry used the post-401 token
			expect((mockFetch.mock.calls[3][1] as RequestInit).headers).toMatchObject({
				Authorization: "Bearer post-401",
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects an oversized JSON response", async () => {
		const client = makeClient(null);
		mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
		// 2 MB of padding
		const huge = { workouts: [], pad: "x".repeat(2 * 1024 * 1024) };
		mockFetch.mockResolvedValueOnce(jsonResponse(huge));
		await expect(client.getPersonalizedWorkouts()).rejects.toThrow(/response too large/);
	});
});

describe("FormClient.getWorkoutById", () => {
	it("returns the structured body with setGroups[] for a valid id", async () => {
		const client = makeClient(null);
		mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
		mockFetch.mockResolvedValueOnce(jsonResponse(loadFixture("workout-endurance.json")));

		const body = await client.getWorkoutById("019e4703-1297-7551-b6a9-1e445eabbc1b");

		expect(body.id).toBe("019e4703-1297-7551-b6a9-1e445eabbc1b");
		expect(body.setGroups).toHaveLength(4);
		expect(body.setGroups[0].groupType).toBe("warmup");
		expect(body.setGroups[2].groupType).toBe("main");

		const mainSet = body.setGroups[2].sets[0];
		expect(mainSet.intervalDistance).toBe(200);
		expect(mainSet.intervalsCount).toBe(2);
		expect(mainSet.effort.level).toBe("moderate");
		expect(mainSet.rest?.defined).toBe(35);
	});

	it("rejects ids that don't match the UUID shape", async () => {
		const client = makeClient(null);
		mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
		await client.acquireToken();

		await expect(client.getWorkoutById("../etc/passwd")).rejects.toThrow(/invalid id/);
		await expect(client.getWorkoutById("not-a-uuid")).rejects.toThrow(/invalid id/);
		await expect(client.getWorkoutById("019e4703-1297-7551-b6a9")).rejects.toThrow(/invalid id/);
	});
});

describe("FormClient.getPersonalizedWithBodies", () => {
	it("fetches list + all 3 bodies and returns them keyed by id", async () => {
		const client = makeClient(null);
		mockFetch.mockResolvedValueOnce(jsonResponse(liveOAuth()));
		mockFetch.mockResolvedValueOnce(jsonResponse(loadFixture("personalized.json")));
		// 3 body fetches in parallel — order of resolution doesn't matter
		mockFetch.mockResolvedValueOnce(jsonResponse(loadFixture("workout-endurance.json")));
		mockFetch.mockResolvedValueOnce(jsonResponse(loadFixture("workout-power.json")));
		mockFetch.mockResolvedValueOnce(jsonResponse(loadFixture("workout-technique.json")));

		const { set, bodies } = await client.getPersonalizedWithBodies();
		expect(set.workouts).toHaveLength(3);
		expect(bodies.size).toBe(3);
		const endurance = bodies.get("019e4703-1297-7551-b6a9-1e445eabbc1b");
		expect(endurance?.setGroups).toHaveLength(4);
	});
});
