import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkoutSuggestion } from "../../src/engine/types.js";
import { StrydClient } from "../../src/stryd/client.js";
import { applyStrydRecommendation } from "../../src/web/stryd-swap.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "stryd-recommendations");

function loadFixture(name: string) {
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

async function loggedInClient(): Promise<StrydClient> {
	mockFetch.mockResolvedValueOnce(jsonResponse({ token: "tok", id: "user-1" }));
	const c = new StrydClient({ email: "x", password: "y" });
	await c.login();
	return c;
}

function baseSuggestion(overrides: Partial<WorkoutSuggestion> = {}): WorkoutSuggestion {
	return {
		sport: "Run",
		category: "base",
		title: "Engine base run",
		rationale: "engine rationale",
		total_duration_secs: 3600,
		estimated_load: 45,
		segments: [
			{
				name: "Run",
				duration_secs: 3600,
				target_description: "engine target",
			},
		],
		readiness_score: 60,
		sport_selection_reason: "deficit",
		terrain: "flat",
		terrain_rationale: "default",
		power_context: { source: "stryd", ftp: 286, confidence: "high" },
		warnings: [],
		...overrides,
	};
}

describe("applyStrydRecommendation", () => {
	it("category 'rest' returns the engine suggestion tagged 'exercitator' (no Stryd call)", async () => {
		const client = await loggedInClient();
		const initialCalls = mockFetch.mock.calls.length;

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({ category: "rest" }),
			client,
		);

		expect(out.prescriptionSource).toBe("exercitator");
		expect(out.title).toBe("Engine base run");
		expect(out.segments).toHaveLength(1);
		expect(mockFetch.mock.calls.length).toBe(initialCalls); // no Stryd call
	});

	it("Swim sport returns the engine suggestion tagged 'exercitator' (defensive guard)", async () => {
		const client = await loggedInClient();
		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({ sport: "Swim" }),
			client,
		);
		expect(out.prescriptionSource).toBe("exercitator");
		expect(out.sport).toBe("Swim");
	});

	it("base + easy fixture: swaps title + segments and tags 'stryd' with rationale", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(
			jsonResponse(loadFixture("recommendations-easy-extfalse.json")),
		);

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({ category: "base" }),
			client,
		);

		expect(out.prescriptionSource).toBe("stryd");
		expect(out.title).toBe("Easy + Strides");
		expect(out.strydWorkoutTitle).toBe("Easy + Strides");
		expect(out.strydWorkoutId).toBe(5263756623806464);
		expect(out.strydPickRationale).toContain("Easy + Strides");
		// Segments: 4 warm-up + 4 work + 4 rest + 1 cool-down — exact count depends
		// on the fixture; assert we got more than the engine's 1, with all power-banded.
		expect(out.segments.length).toBeGreaterThan(1);
		expect(out.segments.every((s) => s.target_power_low !== undefined)).toBe(true);
		// total_duration_secs recomputed from the new segments.
		const expected = out.segments.reduce((s, seg) => s + seg.duration_secs, 0);
		expect(out.total_duration_secs).toBe(expected);
		// estimated_load preserved from engine.
		expect(out.estimated_load).toBe(45);
	});

	it("Stryd swap replaces engine narrative (rationale/terrain) with Stryd's", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(
			jsonResponse(loadFixture("recommendations-workout-extfalse.json")),
		);

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({
				category: "tempo",
				rationale: "Sweet-spot tempo to lift lactate clearance and pace tolerance.",
				terrain: "rolling",
				terrain_rationale: "engine picked rolling",
			}),
			client,
		);

		expect(out.prescriptionSource).toBe("stryd");
		// Rationale replaced with Stryd's desc — first words of Stryd's
		// Dash & Dine description.
		expect(out.rationale).toMatch(/mixed aerobic|speed development/i);
		expect(out.rationale).not.toMatch(/Sweet-spot tempo/);
		// Terrain neutralised (Stryd workout type carries terrain implicitly).
		expect(out.terrain).toBe("any");
		expect(out.terrain_rationale).toBe("");
	});

	it("Stryd swap filters out engine-narrative warnings (staleness/buffer)", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(
			jsonResponse(loadFixture("recommendations-workout-extfalse.json")),
		);

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({
				category: "tempo",
				warnings: [
					// Should be dropped (staleness/buffer narrative)
					"Return to run: only 2 sessions in 14 days — easing back in. Adding 10s/km buffer.",
					"Last run was 30 days ago — thresholds may have regressed. Adding 10s/km buffer.",
					// Should survive (health-related, applies regardless)
					"Sleep below 7 hours (5h30m) — consider lighter intensity",
					"Training stress balance is negative — fatigue exceeds fitness",
				],
			}),
			client,
		);

		expect(out.warnings).toEqual([
			"Sleep below 7 hours (5h30m) — consider lighter intensity",
			"Training stress balance is negative — fatigue exceeds fitness",
		]);
	});

	it("recovery + easy fixture (Easy + Strides is stride type): falls back 'stride_rejected_on_recovery'", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(
			jsonResponse(loadFixture("recommendations-easy-extfalse.json")),
		);

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({ category: "recovery" }),
			client,
		);

		expect(out.prescriptionSource).toBe("exercitator-fallback");
		expect(out.fallbackReason).toBe("stride_rejected_on_recovery");
		// Engine's original segments preserved.
		expect(out.title).toBe("Engine base run");
		expect(out.segments).toHaveLength(1);
	});

	it("204 on `type=long`: falls back '204_no_content_long'", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({ category: "long" }),
			client,
		);

		expect(out.prescriptionSource).toBe("exercitator-fallback");
		expect(out.fallbackReason).toBe("204_no_content_long");
		expect(out.title).toBe("Engine base run"); // engine output preserved
	});

	it("5xx error: falls back with http_500 reason", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(new Response("boom", { status: 500 }));

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({ category: "intervals" }),
			client,
		);

		expect(out.prescriptionSource).toBe("exercitator-fallback");
		expect(out.fallbackReason).toBe("http_500");
	});

	it("network error: falls back with network_error reason", async () => {
		const client = await loggedInClient();
		mockFetch.mockRejectedValueOnce(new Error("fetch failed: network unreachable"));

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({ category: "threshold" }),
			client,
		);

		expect(out.prescriptionSource).toBe("exercitator-fallback");
		expect(out.fallbackReason).toBe("network_error");
	});

	it("intervals + workout fixture: picks Hill Hustle and surfaces rationale", async () => {
		const client = await loggedInClient();
		mockFetch.mockResolvedValueOnce(
			jsonResponse(loadFixture("recommendations-workout-extfalse.json")),
		);

		const { suggestion: out } = await applyStrydRecommendation(
			baseSuggestion({ category: "intervals" }),
			client,
		);

		expect(out.prescriptionSource).toBe("stryd");
		expect(out.strydWorkoutTitle).toBe("Hill Hustle");
		expect(out.strydPickRationale).toMatch(/Hill Hustle/);
	});
});
