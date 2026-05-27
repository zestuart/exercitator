import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkoutSuggestion } from "../../src/engine/types.js";
import type { FormRecommendationSet, FormWorkoutBody } from "../../src/form/client.js";
import type { StrydRecommendationSet } from "../../src/stryd/client.js";
import { type DswEmitInput, buildDswPayload, emitDsw } from "../../src/web/promus-dsw.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "stryd-recommendations");
const FORM_FIXTURE_DIR = join(__dirname, "..", "fixtures", "form-personalized");

function loadFixture(name: string): StrydRecommendationSet {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

function loadFormFixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(FORM_FIXTURE_DIR, name), "utf-8")) as T;
}

const FORM_SET = loadFormFixture<FormRecommendationSet>("personalized.json");
const FORM_ENDURANCE = loadFormFixture<FormWorkoutBody>("workout-endurance.json");
const FORM_BODIES = new Map([[FORM_ENDURANCE.id, FORM_ENDURANCE]]);

function baseSwimSuggestion(overrides: Partial<WorkoutSuggestion> = {}): WorkoutSuggestion {
	return {
		sport: "Swim",
		category: "base",
		title: FORM_ENDURANCE.name,
		rationale: FORM_ENDURANCE.description,
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
		readiness_score: 78,
		sport_selection_reason: "swim day",
		terrain: "pool",
		terrain_rationale: "",
		power_context: {
			source: "none",
			ftp: 0,
			confidence: "low",
		} as unknown as WorkoutSuggestion["power_context"],
		warnings: [],
		...overrides,
	};
}

function baseSuggestion(overrides: Partial<WorkoutSuggestion> = {}): WorkoutSuggestion {
	return {
		sport: "Run",
		category: "threshold",
		title: "Hill Hustle",
		rationale: "engine rationale",
		total_duration_secs: 1500,
		estimated_load: 55,
		segments: [{ name: "Warm-up", duration_secs: 300, target_description: "Z1" }],
		readiness_score: 72,
		sport_selection_reason: "deficit",
		terrain: "rolling",
		terrain_rationale: "hill repeat",
		power_context: { source: "stryd", ftp: 286, confidence: "high" },
		warnings: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildDswPayload
// ---------------------------------------------------------------------------

describe("buildDswPayload", () => {
	it("returns null when prescriptionSource is undefined (engine-only / Pam)", () => {
		const out = buildDswPayload({
			kind: "stryd",
			userId: "pam",
			date: "2026-05-25",
			sport: "Run",
			suggestion: baseSuggestion(),
			strydRecommendationSet: null,
		});
		expect(out).toBeNull();
	});

	it("returns null when prescriptionSource is 'exercitator' (rest day)", () => {
		const out = buildDswPayload({
			kind: "stryd",
			userId: "ze",
			date: "2026-05-25",
			sport: "Run",
			suggestion: baseSuggestion({
				category: "rest",
				prescriptionSource: "exercitator",
			}),
			strydRecommendationSet: null,
		});
		expect(out).toBeNull();
	});

	it("builds a full Stryd-success payload with workout type extracted from the set", () => {
		const set = loadFixture("recommendations-workout-extfalse.json");
		const out = buildDswPayload({
			kind: "stryd",
			userId: "ze",
			date: "2026-05-25",
			sport: "Run",
			suggestion: baseSuggestion({
				category: "intervals",
				title: "Hill Hustle",
				prescriptionSource: "stryd",
				strydWorkoutId: 6556917896478720,
				strydWorkoutTitle: "Hill Hustle",
				strydPickRationale: "intervals: picked 'Hill Hustle' (300 s Z4+Z5)",
				vigil: {
					severity: 1,
					summary: "vigil notice",
					recommendation: "",
					flags: [],
					baselineWindow: "30d",
					acuteWindow: "7d",
					status: "active",
				},
			}),
			strydRecommendationSet: set,
		});

		expect(out).not.toBeNull();
		expect(out?.user_id).toBe("ze");
		expect(out?.date).toBe("2026-05-25");
		expect(out?.sport).toBe("Run");
		expect(out?.source).toBe("stryd");
		expect(out?.category).toBe("intervals");
		expect(out?.fallback_used).toBe(false);
		// int64 → string per Promus schema
		expect(out?.picked_workout_id).toBe("6556917896478720");
		expect(out?.picked_workout_title).toBe("Hill Hustle");
		expect(out?.picked_workout_type).toBe("hill repeat");
		expect(out?.picked_strategy_rationale).toContain("Hill Hustle");
		// fallback_reason omitted on success
		expect(out?.fallback_reason).toBeUndefined();
		// Full Stryd set persisted verbatim
		expect(out?.stryd_recommendation_set).toBe(set);
		// Context carries readiness + ftp + vigil
		const ctx = out?.exercitator_context as Record<string, unknown>;
		expect(ctx.readiness_score).toBe(72);
		expect(ctx.cp_or_ftp).toBe(286);
		expect(ctx.vigil_severity).toBe(1);
	});

	it("builds a fallback payload (stride_rejected_on_recovery) with set carried over", () => {
		const set = loadFixture("recommendations-easy-extfalse.json");
		const out = buildDswPayload({
			kind: "stryd",
			userId: "ze",
			date: "2026-05-25",
			sport: "Run",
			suggestion: baseSuggestion({
				category: "recovery",
				prescriptionSource: "exercitator-fallback",
				fallbackReason: "stride_rejected_on_recovery",
			}),
			strydRecommendationSet: set,
		});

		expect(out).not.toBeNull();
		expect(out?.source).toBe("stryd");
		expect(out?.fallback_used).toBe(true);
		expect(out?.fallback_reason).toBe("stride_rejected_on_recovery");
		// No picked workout fields on fallback
		expect(out?.picked_workout_id).toBeUndefined();
		expect(out?.picked_workout_title).toBeUndefined();
		expect(out?.picked_workout_type).toBeUndefined();
		expect(out?.picked_strategy_rationale).toBeUndefined();
		// Set is still carried — useful for retrospective re-picking
		expect(out?.stryd_recommendation_set).toBe(set);
	});

	it("builds a fallback payload (204_no_content_long) with empty set", () => {
		const out = buildDswPayload({
			kind: "stryd",
			userId: "ze",
			date: "2026-05-25",
			sport: "Run",
			suggestion: baseSuggestion({
				category: "long",
				prescriptionSource: "exercitator-fallback",
				fallbackReason: "204_no_content_long",
			}),
			strydRecommendationSet: null,
		});

		expect(out?.fallback_used).toBe(true);
		expect(out?.fallback_reason).toBe("204_no_content_long");
		// Promus column is NOT NULL DEFAULT '{}'; we send {} instead of null
		expect(out?.stryd_recommendation_set).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// emitDsw
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
	process.env["promus-api"] = "test-token-abc";
	process.env.PROMUS_URL = "https://promus.test.invalid";
});

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(process.env, "promus-api");
	Reflect.deleteProperty(process.env, "PROMUS_API");
	Reflect.deleteProperty(process.env, "PROMUS_URL");
});

function baseInput(
	overrides: Partial<Extract<DswEmitInput, { kind: "stryd" }>> = {},
): DswEmitInput {
	return {
		kind: "stryd",
		userId: "ze",
		date: "2026-05-25",
		sport: "Run",
		suggestion: baseSuggestion({
			prescriptionSource: "stryd",
			strydWorkoutId: 6556917896478720,
			strydWorkoutTitle: "Hill Hustle",
			strydPickRationale: "rationale",
		}),
		strydRecommendationSet: loadFixture("recommendations-workout-extfalse.json"),
		...overrides,
	};
}

describe("emitDsw", () => {
	it("posts to /api/ingest/dsw with bearer token + JSON body", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ upserted: false, records_accepted: 1 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await emitDsw(baseInput());

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, opts] = mockFetch.mock.calls[0];
		expect(url).toBe("https://promus.test.invalid/api/ingest/dsw");
		const init = opts as RequestInit;
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			Authorization: "Bearer test-token-abc",
			"Content-Type": "application/json",
		});
		const body = JSON.parse(init.body as string);
		expect(body.user_id).toBe("ze");
		expect(body.source).toBe("stryd");
		expect(body.fallback_used).toBe(false);
	});

	it("skips silently (no fetch) when buildDswPayload returns null", async () => {
		await emitDsw({
			kind: "stryd",
			userId: "pam",
			date: "2026-05-25",
			sport: "Run",
			suggestion: baseSuggestion(), // prescriptionSource undefined
			strydRecommendationSet: null,
		});
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("skips with a warn when promus-api token is missing", async () => {
		Reflect.deleteProperty(process.env, "promus-api");
		Reflect.deleteProperty(process.env, "PROMUS_API");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await emitDsw(baseInput());
		expect(mockFetch).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("token not configured"));
	});

	it("non-2xx response logs a warn but does not throw", async () => {
		mockFetch.mockResolvedValueOnce(new Response("validation failure", { status: 400 }));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(emitDsw(baseInput())).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringMatching(/Promus returned HTTP 400.*validation failure/),
		);
	});

	it("network error logs a warn but does not throw", async () => {
		mockFetch.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(emitDsw(baseInput())).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/fetch failed.*ECONNREFUSED/));
	});
});

// ---------------------------------------------------------------------------
// buildDswPayload — FORM path
// ---------------------------------------------------------------------------

describe("buildDswPayload — FORM kind", () => {
	function baseFormInput(
		overrides: Partial<Extract<DswEmitInput, { kind: "form" }>> = {},
	): DswEmitInput {
		return {
			kind: "form",
			userId: "ze",
			date: "2026-05-25",
			sport: "Swim",
			suggestion: baseSwimSuggestion({
				prescriptionSource: "form",
				formWorkoutId: FORM_ENDURANCE.id,
				formWorkoutTitle: FORM_ENDURANCE.name,
				formPickRationale: "base: picked 'Better As You Go' (score 1240, Z1+Z2)",
				// Mirror what applyFormRecommendation persists for replay.
				formOriginalWorkout: FORM_ENDURANCE,
			}),
			formRecommendationSet: FORM_SET,
			formBodies: FORM_BODIES,
			...overrides,
		};
	}

	it("returns null when prescriptionSource is undefined", () => {
		const out = buildDswPayload(baseFormInput({ suggestion: baseSwimSuggestion() }));
		expect(out).toBeNull();
	});

	it("returns null when prescriptionSource is 'exercitator' (rest)", () => {
		const out = buildDswPayload(
			baseFormInput({
				suggestion: baseSwimSuggestion({
					category: "rest",
					prescriptionSource: "exercitator",
				}),
			}),
		);
		expect(out).toBeNull();
	});

	it("returns null when the fallback is for a different vendor (e.g. Stryd)", () => {
		const out = buildDswPayload(
			baseFormInput({
				suggestion: baseSwimSuggestion({
					prescriptionSource: "exercitator-fallback",
					fallbackVendor: "stryd",
					fallbackReason: "http_503",
				}),
			}),
		);
		expect(out).toBeNull();
	});

	it("builds a full FORM-success payload with vendor_recommendation_set", () => {
		const out = buildDswPayload(baseFormInput());
		expect(out).not.toBeNull();
		expect(out?.source).toBe("form");
		expect(out?.sport).toBe("Swim");
		expect(out?.category).toBe("base");
		expect(out?.fallback_used).toBe(false);
		expect(out?.picked_workout_id).toBe(FORM_ENDURANCE.id);
		expect(out?.picked_workout_title).toBe(FORM_ENDURANCE.name);
		// type extracted from the matching candidate in the set
		expect(out?.picked_workout_type).toBe("Endurance");
		expect(out?.picked_strategy_rationale).toContain("base: picked");
		// Renamed column (Promus #168)
		expect(out?.vendor_recommendation_set).toBe(FORM_SET);
		// Legacy column NOT populated on FORM path
		expect(out?.stryd_recommendation_set).toBeUndefined();
	});

	it("bundles picked_workout_body in exercitator_context for byte-equal replay (Promus #167)", () => {
		const out = buildDswPayload(baseFormInput());
		const ctx = out?.exercitator_context as Record<string, unknown>;
		// vendor_recommendation_set carries only the 3-item /personalized
		// metadata (no setGroups). The picked body lives here for
		// future replay-from-Promus.
		expect(ctx.picked_workout_body).toBe(FORM_ENDURANCE);
		const body = ctx.picked_workout_body as { setGroups: unknown[] };
		expect(Array.isArray(body.setGroups)).toBe(true);
		expect(body.setGroups.length).toBeGreaterThan(0);
	});

	it("builds a FORM fallback payload (network error) with empty set", () => {
		const out = buildDswPayload(
			baseFormInput({
				suggestion: baseSwimSuggestion({
					prescriptionSource: "exercitator-fallback",
					fallbackVendor: "form",
					fallbackReason: "network_error",
				}),
				formRecommendationSet: null,
				formBodies: null,
			}),
		);
		expect(out?.fallback_used).toBe(true);
		expect(out?.fallback_reason).toBe("network_error");
		expect(out?.picked_workout_id).toBeUndefined();
		expect(out?.vendor_recommendation_set).toEqual({});
		// On fallback there's no picked workout — picked_workout_body
		// must be absent so a downstream replay doesn't pick up stale
		// or unrelated content.
		const ctx = out?.exercitator_context as Record<string, unknown>;
		expect(ctx.picked_workout_body).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// emitDsw — FORM env gate
// ---------------------------------------------------------------------------

describe("emitDsw — FORM gate (PROMUS_FORM_DSW_ENABLED)", () => {
	function formInput(): DswEmitInput {
		return {
			kind: "form",
			userId: "ze",
			date: "2026-05-25",
			sport: "Swim",
			suggestion: baseSwimSuggestion({
				prescriptionSource: "form",
				formWorkoutId: FORM_ENDURANCE.id,
				formWorkoutTitle: FORM_ENDURANCE.name,
				formPickRationale: "base: picked",
			}),
			formRecommendationSet: FORM_SET,
			formBodies: FORM_BODIES,
		};
	}

	beforeEach(() => {
		Reflect.deleteProperty(process.env, "PROMUS_FORM_DSW_ENABLED");
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, "PROMUS_FORM_DSW_ENABLED");
	});

	it("no-ops (no fetch) when PROMUS_FORM_DSW_ENABLED is unset", async () => {
		await emitDsw(formInput());
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("no-ops when PROMUS_FORM_DSW_ENABLED is '0'", async () => {
		process.env.PROMUS_FORM_DSW_ENABLED = "0";
		await emitDsw(formInput());
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("emits when PROMUS_FORM_DSW_ENABLED is '1'", async () => {
		process.env.PROMUS_FORM_DSW_ENABLED = "1";
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ upserted: false, records_accepted: 1 }), { status: 200 }),
		);

		await emitDsw(formInput());

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const init = mockFetch.mock.calls[0][1] as RequestInit;
		const body = JSON.parse(init.body as string);
		expect(body.source).toBe("form");
		expect(body.vendor_recommendation_set).toBeDefined();
		expect(body.stryd_recommendation_set).toBeUndefined();
	});

	it("emits when PROMUS_FORM_DSW_ENABLED is 'true'", async () => {
		process.env.PROMUS_FORM_DSW_ENABLED = "true";
		mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
		await emitDsw(formInput());
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("does NOT gate the Stryd path on PROMUS_FORM_DSW_ENABLED", async () => {
		// PROMUS_FORM_DSW_ENABLED unset — Stryd path must still fire.
		mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
		await emitDsw(baseInput());
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});
});
