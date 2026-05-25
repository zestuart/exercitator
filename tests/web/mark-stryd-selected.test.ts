import { describe, expect, it, vi } from "vitest";
import type { WorkoutSuggestion } from "../../src/engine/types.js";
import type { StrydClient } from "../../src/stryd/client.js";
import { markStrydRecommendationSelected } from "../../src/web/mark-stryd-selected.js";

function suggestion(overrides: Partial<WorkoutSuggestion> = {}): WorkoutSuggestion {
	return {
		sport: "Run",
		category: "tempo",
		title: "Dash & Dine",
		rationale: "x",
		total_duration_secs: 1560,
		estimated_load: 25,
		segments: [],
		readiness_score: 70,
		sport_selection_reason: "",
		terrain: "rolling",
		terrain_rationale: "",
		power_context: { source: "stryd", ftp: 286, confidence: "high" },
		warnings: [],
		...overrides,
	};
}

function mockClient() {
	return {
		markRecommendationSelected: vi.fn().mockResolvedValue(undefined),
	} as unknown as StrydClient & { markRecommendationSelected: ReturnType<typeof vi.fn> };
}

describe("markStrydRecommendationSelected", () => {
	it("PATCHes when both setId and workoutId are present on the suggestion", async () => {
		const client = mockClient();
		await markStrydRecommendationSelected(
			client,
			suggestion({
				prescriptionSource: "stryd",
				strydWorkoutId: 5801524266172416,
				strydRecommendationSetId: "6683835214757888",
			}),
		);
		expect(client.markRecommendationSelected).toHaveBeenCalledTimes(1);
		expect(client.markRecommendationSelected).toHaveBeenCalledWith(
			"6683835214757888",
			5801524266172416,
		);
	});

	it("no-op when the suggestion is engine-built (no recommendation set id)", async () => {
		const client = mockClient();
		await markStrydRecommendationSelected(
			client,
			suggestion({ prescriptionSource: "exercitator" }),
		);
		expect(client.markRecommendationSelected).not.toHaveBeenCalled();
	});

	it("no-op when the suggestion is a fallback (set id may be present but workoutId is not)", async () => {
		const client = mockClient();
		await markStrydRecommendationSelected(
			client,
			suggestion({
				prescriptionSource: "exercitator-fallback",
				fallbackReason: "http_500",
				strydRecommendationSetId: "6683835214757888",
				// no strydWorkoutId — nothing was picked
			}),
		);
		expect(client.markRecommendationSelected).not.toHaveBeenCalled();
	});

	it("no-op when strydClient is null (Pam / non-Stryd profile)", async () => {
		await expect(
			markStrydRecommendationSelected(
				null,
				suggestion({
					prescriptionSource: "stryd",
					strydWorkoutId: 1,
					strydRecommendationSetId: "x",
				}),
			),
		).resolves.toBeUndefined();
	});

	it("no-op when suggestion is null (no prescription to mark)", async () => {
		const client = mockClient();
		await markStrydRecommendationSelected(client, null);
		expect(client.markRecommendationSelected).not.toHaveBeenCalled();
	});

	it("swallows PATCH errors with a console.warn — never throws", async () => {
		const client = {
			markRecommendationSelected: vi.fn().mockRejectedValue(new Error("boom\nwith newline")),
		} as unknown as StrydClient & { markRecommendationSelected: ReturnType<typeof vi.fn> };
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			markStrydRecommendationSelected(
				client,
				suggestion({
					prescriptionSource: "stryd",
					strydWorkoutId: 1,
					strydRecommendationSetId: "x",
				}),
			),
		).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/PATCH failed for set x workout 1: boom with newline/),
		);
		warnSpy.mockRestore();
	});
});
