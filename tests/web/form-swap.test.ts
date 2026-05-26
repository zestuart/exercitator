import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SportSettings, WorkoutSuggestion } from "../../src/engine/types.js";
import type {
	FormClient,
	FormPersonalizedWithBodies,
	FormRecommendationSet,
	FormWorkoutBody,
} from "../../src/form/client.js";
import type { UserProfile } from "../../src/users.js";
import { applyFormSwapIfEnabled } from "../../src/web/form-swap.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "form-personalized");

function loadFixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8")) as T;
}

const PERSONALIZED = loadFixture<FormRecommendationSet>("personalized.json");
const ENDURANCE = loadFixture<FormWorkoutBody>("workout-endurance.json");
const POWER = loadFixture<FormWorkoutBody>("workout-power.json");
const TECHNIQUE = loadFixture<FormWorkoutBody>("workout-technique.json");

const BODIES = new Map<string, FormWorkoutBody>([
	[ENDURANCE.id, ENDURANCE],
	[POWER.id, POWER],
	[TECHNIQUE.id, TECHNIQUE],
]);

const SETTINGS: SportSettings = {
	sport: "Swim",
	threshold_pace: 0.94,
	hr_zones: [118, 125, 131, 139, 143, 147, 161],
} as unknown as SportSettings;

const NO_CSS_SETTINGS: SportSettings = {
	sport: "Swim",
	threshold_pace: null,
	hr_zones: null,
} as unknown as SportSettings;

const ZE_PROFILE: UserProfile = {
	id: "ze",
	displayName: "Ze",
	sports: ["Run", "Swim"],
	deities: false,
	stryd: true,
	apiKeyEnv: "INTERVALS_ICU_API_KEY",
	strydEmailEnv: "STRYD_EMAIL",
	strydPasswordEnv: "STRYD_PASSWORD",
	formEmailEnv: "FORM_EMAIL",
	formPasswordEnv: "FORM_PASSWORD",
	swimRecommendationSource: "form",
};

const PAM_PROFILE: UserProfile = {
	id: "pam",
	displayName: "Pam",
	sports: ["Run"],
	deities: false,
	stryd: true,
	apiKeyEnv: "INTERVALS_ICU_API_KEY_PAM",
	strydEmailEnv: "STRYD_EMAIL_PAM",
	strydPasswordEnv: "STRYD_PASSWORD_PAM",
	formEmailEnv: null,
	formPasswordEnv: null,
};

const RUN_PROFILE_WITH_FORM: UserProfile = {
	...ZE_PROFILE,
	swimRecommendationSource: undefined,
};

function makeSwimSuggestion(overrides: Partial<WorkoutSuggestion> = {}): WorkoutSuggestion {
	return {
		sport: "Swim",
		category: "base",
		title: "Engine Swim Title",
		rationale: "engine rationale",
		total_duration_secs: 1800,
		estimated_load: 30,
		segments: [
			{
				name: "Warm-up",
				duration_secs: 240,
				target_description: "200m easy free",
				target_hr_zone: 1,
			},
		],
		readiness_score: 80,
		sport_selection_reason: "test",
		terrain: "pool",
		terrain_rationale: "",
		power_context: { ftp: 0 } as unknown as WorkoutSuggestion["power_context"],
		warnings: [],
		...overrides,
	};
}

function makeFormClient(bodies = BODIES, overrides: Partial<FormClient> = {}): FormClient {
	const result: FormPersonalizedWithBodies = { set: PERSONALIZED, bodies };
	return {
		getPersonalizedWithBodies: vi.fn().mockResolvedValue(result),
		getPersonalizedWorkouts: vi.fn(),
		getWorkoutById: vi.fn(),
		acquireToken: vi.fn(),
		isAuthenticated: true,
		getUserId: vi.fn().mockReturnValue("user-1"),
		...overrides,
	} as unknown as FormClient;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("applyFormSwapIfEnabled — gating", () => {
	it("returns suggestion unchanged when sport is Run", async () => {
		const suggestion = { ...makeSwimSuggestion(), sport: "Run" as const };
		const client = makeFormClient();
		const out = await applyFormSwapIfEnabled(suggestion, ZE_PROFILE, client, SETTINGS);
		expect(out.suggestion).toBe(suggestion);
		expect(out.formRecommendationSet).toBeNull();
		expect(client.getPersonalizedWithBodies).not.toHaveBeenCalled();
	});

	it("returns suggestion unchanged when status is awaiting_input", async () => {
		const suggestion = makeSwimSuggestion({ status: "awaiting_input" });
		const client = makeFormClient();
		const out = await applyFormSwapIfEnabled(suggestion, ZE_PROFILE, client, SETTINGS);
		expect(out.suggestion).toBe(suggestion);
		expect(client.getPersonalizedWithBodies).not.toHaveBeenCalled();
	});

	it("returns suggestion unchanged when profile has no swimRecommendationSource", async () => {
		const suggestion = makeSwimSuggestion();
		const client = makeFormClient();
		const out = await applyFormSwapIfEnabled(suggestion, PAM_PROFILE, client, SETTINGS);
		expect(out.suggestion).toBe(suggestion);
		expect(client.getPersonalizedWithBodies).not.toHaveBeenCalled();
	});

	it("returns suggestion unchanged when formClient is null", async () => {
		const suggestion = makeSwimSuggestion();
		const out = await applyFormSwapIfEnabled(suggestion, ZE_PROFILE, null, SETTINGS);
		expect(out.suggestion).toBe(suggestion);
	});

	it("returns suggestion unchanged when CSS is missing", async () => {
		const suggestion = makeSwimSuggestion();
		const client = makeFormClient();
		const out = await applyFormSwapIfEnabled(suggestion, ZE_PROFILE, client, NO_CSS_SETTINGS);
		expect(out.suggestion).toBe(suggestion);
		expect(client.getPersonalizedWithBodies).not.toHaveBeenCalled();
	});

	it("runs the swap when all gates pass", async () => {
		const suggestion = makeSwimSuggestion();
		const client = makeFormClient();
		const out = await applyFormSwapIfEnabled(suggestion, ZE_PROFILE, client, SETTINGS);
		expect(client.getPersonalizedWithBodies).toHaveBeenCalledOnce();
		expect(out.suggestion.prescriptionSource).toBe("form");
	});
});

describe("applyFormSwapIfEnabled — success path (base category)", () => {
	let result: Awaited<ReturnType<typeof applyFormSwapIfEnabled>>;

	beforeEach(async () => {
		const suggestion = makeSwimSuggestion({ category: "base" });
		result = await applyFormSwapIfEnabled(suggestion, ZE_PROFILE, makeFormClient(), SETTINGS);
	});

	it("replaces title with FORM workout name", () => {
		expect(result.suggestion.title).toBe(ENDURANCE.name);
	});

	it("emits prescriptionSource form + FORM workout id + title + rationale", () => {
		expect(result.suggestion.prescriptionSource).toBe("form");
		expect(result.suggestion.formWorkoutId).toBe(ENDURANCE.id);
		expect(result.suggestion.formWorkoutTitle).toBe(ENDURANCE.name);
		expect(result.suggestion.formPickRationale).toContain("base: picked");
	});

	it("preserves the original FORM workout payload", () => {
		expect(result.suggestion.formOriginalWorkout).toEqual(ENDURANCE);
	});

	it("replaces segments with FORM-derived ones", () => {
		expect(result.suggestion.segments.length).toBeGreaterThan(1);
		expect(result.suggestion.segments.some((s) => s.repeats && s.repeats > 1)).toBe(true);
	});

	it("clears terrain to pool + empties terrain_rationale", () => {
		expect(result.suggestion.terrain).toBe("pool");
		expect(result.suggestion.terrain_rationale).toBe("");
	});

	it("returns the recommendation set + bodies for downstream Promus DSW use", () => {
		expect(result.formRecommendationSet).toBe(PERSONALIZED);
		expect(result.formBodies?.size).toBe(3);
	});
});

describe("applyFormSwapIfEnabled — failure paths", () => {
	it("returns exercitator-fallback with HTTP status reason on a 5xx", async () => {
		const client = makeFormClient(BODIES, {
			getPersonalizedWithBodies: vi
				.fn()
				.mockRejectedValue(new Error("FORM getPersonalizedWorkouts failed (HTTP 503): ...")),
		});
		const out = await applyFormSwapIfEnabled(makeSwimSuggestion(), ZE_PROFILE, client, SETTINGS);
		expect(out.suggestion.prescriptionSource).toBe("exercitator-fallback");
		expect(out.suggestion.fallbackVendor).toBe("form");
		expect(out.suggestion.fallbackReason).toBe("http_503");
	});

	it("returns exercitator-fallback with network_error on a network failure", async () => {
		const client = makeFormClient(BODIES, {
			getPersonalizedWithBodies: vi.fn().mockRejectedValue(new Error("fetch failed: ECONNRESET")),
		});
		const out = await applyFormSwapIfEnabled(makeSwimSuggestion(), ZE_PROFILE, client, SETTINGS);
		expect(out.suggestion.fallbackReason).toBe("network_error");
	});

	it("returns exercitator-fallback with empty_workouts_array on empty list", async () => {
		const empty: FormRecommendationSet = { ...PERSONALIZED, workouts: [] };
		const client = makeFormClient(BODIES, {
			getPersonalizedWithBodies: vi.fn().mockResolvedValue({ set: empty, bodies: new Map() }),
		});
		const out = await applyFormSwapIfEnabled(makeSwimSuggestion(), ZE_PROFILE, client, SETTINGS);
		expect(out.suggestion.fallbackReason).toBe("empty_workouts_array");
	});

	it("returns prescriptionSource: 'exercitator' for rest category (no swap attempted)", async () => {
		const suggestion = makeSwimSuggestion({ category: "rest" });
		const client = makeFormClient();
		const out = await applyFormSwapIfEnabled(suggestion, ZE_PROFILE, client, SETTINGS);
		expect(out.suggestion.prescriptionSource).toBe("exercitator");
		expect(out.formRecommendationSet).toBeNull();
		expect(client.getPersonalizedWithBodies).not.toHaveBeenCalled();
	});
});

describe("applyFormSwapIfEnabled — defensive caps", () => {
	function poisonedBody(overrides: Partial<FormWorkoutBody>): FormWorkoutBody {
		return { ...ENDURANCE, ...overrides };
	}

	function clientServingOnly(body: FormWorkoutBody): FormClient {
		const set: FormRecommendationSet = {
			createdAt: PERSONALIZED.createdAt,
			workouts: [
				{
					...PERSONALIZED.workouts[0],
					workout: { ...PERSONALIZED.workouts[0].workout, id: body.id },
				},
			],
		};
		const bodies = new Map([[body.id, body]]);
		return makeFormClient(bodies, {
			getPersonalizedWithBodies: vi.fn().mockResolvedValue({ set, bodies }),
		});
	}

	it("rejects setGroups.length > MAX_SETGROUPS with unsafe_setgroup_count", async () => {
		const bad = poisonedBody({
			setGroups: Array.from({ length: 50 }, () => ENDURANCE.setGroups[0]),
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const out = await applyFormSwapIfEnabled(
			makeSwimSuggestion(),
			ZE_PROFILE,
			clientServingOnly(bad),
			SETTINGS,
		);
		expect(out.suggestion.fallbackReason).toBe("unsafe_setgroup_count");
		warn.mockRestore();
	});

	it("rejects roundsCount > MAX_ROUNDS with unsafe_rounds_count", async () => {
		const bad = poisonedBody({
			setGroups: [{ ...ENDURANCE.setGroups[0], roundsCount: 9999 }],
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const out = await applyFormSwapIfEnabled(
			makeSwimSuggestion(),
			ZE_PROFILE,
			clientServingOnly(bad),
			SETTINGS,
		);
		expect(out.suggestion.fallbackReason).toBe("unsafe_rounds_count");
		warn.mockRestore();
	});

	it("rejects rest.defined > 3600 with unsafe_rest_duration", async () => {
		const bad = poisonedBody({
			setGroups: [
				{
					...ENDURANCE.setGroups[1],
					roundsCount: 1,
					sets: [
						{
							...ENDURANCE.setGroups[1].sets[0],
							rest: { defined: 999_999, takeoff: null },
						},
					],
				},
			],
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const out = await applyFormSwapIfEnabled(
			makeSwimSuggestion(),
			ZE_PROFILE,
			clientServingOnly(bad),
			SETTINGS,
		);
		expect(out.suggestion.fallbackReason).toBe("unsafe_rest_duration");
		warn.mockRestore();
	});

	it("rejects expanded > MAX_TOTAL_EXPANDED_SEGMENTS with unsafe_total_segment_count", async () => {
		// Each set has intervalsCount=20, group has roundsCount=20, group has 2 sets
		// → 20 × (20 + 20) = 800 expanded > 500 cap.
		const bigSet = {
			...ENDURANCE.setGroups[1].sets[0],
			intervalsCount: 20,
		};
		const bad = poisonedBody({
			setGroups: [
				{
					...ENDURANCE.setGroups[1],
					roundsCount: 20,
					sets: [bigSet, bigSet],
				},
			],
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const out = await applyFormSwapIfEnabled(
			makeSwimSuggestion(),
			ZE_PROFILE,
			clientServingOnly(bad),
			SETTINGS,
		);
		expect(out.suggestion.fallbackReason).toBe("unsafe_total_segment_count");
		warn.mockRestore();
	});
});

describe("applyFormSwapIfEnabled — warning filtering", () => {
	it("drops staleness 'Adding 10s/100m buffer' warnings; keeps health warnings", async () => {
		const suggestion = makeSwimSuggestion({
			warnings: [
				"Returning to swimming. Adding 10s/100m buffer until 5 sessions logged.",
				"Sleep debt 6.2h — keep effort sub-aerobic.",
				"easing back in after 3-week layoff.",
				"HRV trending down 8% — caution on hard sessions.",
			],
		});
		const out = await applyFormSwapIfEnabled(suggestion, ZE_PROFILE, makeFormClient(), SETTINGS);
		expect(out.suggestion.warnings).toEqual([
			"Sleep debt 6.2h — keep effort sub-aerobic.",
			"HRV trending down 8% — caution on hard sessions.",
		]);
	});
});

describe("applyFormSwapIfEnabled — Run with FORM flag does not swap", () => {
	it("returns suggestion unchanged when profile has form flag but suggestion is Run", async () => {
		const suggestion = { ...makeSwimSuggestion(), sport: "Run" as const };
		const client = makeFormClient();
		const out = await applyFormSwapIfEnabled(suggestion, RUN_PROFILE_WITH_FORM, client, SETTINGS);
		// swimRecommendationSource is undefined on RUN_PROFILE_WITH_FORM → gate fails
		expect(out.suggestion).toBe(suggestion);
		expect(client.getPersonalizedWithBodies).not.toHaveBeenCalled();
	});
});
