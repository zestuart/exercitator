import { describe, expect, it } from "vitest";
import type { WorkoutSuggestion } from "../../src/engine/types.js";
import type { UserProfile } from "../../src/users.js";
import { type RenderData, renderPage } from "../../src/web/render.js";

const ZE_PROFILE: UserProfile = {
	id: "ze",
	displayName: "Ze",
	sports: ["Run", "Swim"],
	deities: true,
	stryd: true,
	apiKeyEnv: "INTERVALS_ICU_API_KEY",
	strydEmailEnv: "STRYD_EMAIL",
	strydPasswordEnv: "STRYD_PASSWORD",
};

/** A distance-based Stryd run ("The Tom Workout" — 1-mile reps). */
function distanceRun(): WorkoutSuggestion {
	const mile = 1609.344;
	return {
		sport: "Run",
		category: "long",
		title: "The Tom Workout (Distance)",
		rationale: "Alternating threshold.",
		total_duration_secs: 1320, // WU + CD only (distance reps carry no seconds)
		estimated_load: 43,
		segments: [
			{ name: "Warm-up", duration_secs: 660, target_description: "Stryd 70–80% CP (225–257W)" },
			{
				name: "Work",
				duration_secs: 0,
				duration_type: "distance",
				distance_m: mile,
				target_description: "Stryd 91–95% CP (292–305W)",
				target_power_low: 292,
				target_power_high: 305,
			},
			{
				name: "Recovery",
				duration_secs: 0,
				duration_type: "distance",
				distance_m: mile,
				target_description: "Stryd 81–85% CP (260–273W)",
				target_power_low: 260,
				target_power_high: 273,
			},
			{ name: "Cool-down", duration_secs: 660, target_description: "Stryd 70–80% CP (225–257W)" },
		],
		readiness_score: 66,
		sport_selection_reason: "Forced: Run",
		terrain: "any",
		terrain_rationale: "",
		power_context: {
			source: "garmin",
			ftp: 321,
			rolling_ftp: 321,
			correction_factor: 1.0,
			confidence: "high",
			warnings: [],
		},
		warnings: [],
		prescriptionSource: "stryd",
	};
}

function renderData(): RenderData {
	const inv = { opening: "Diana watches.", rationale_header: "Minerva", closing: "Go forth." };
	return {
		profile: ZE_PROFILE,
		run: distanceRun(),
		swim: { ...distanceRun(), sport: "Swim", segments: [] },
		runInvocations: inv,
		swimInvocations: inv,
		runHrZones: [130, 145, 160, 175, 190],
		swimHrZones: [120, 135, 150, 165, 180],
		dataSource: {
			activityCount: 10,
			activityRange: ["2026-07-01", "2026-07-14"],
			activityDevices: { STRYD: 2 },
			wellnessCount: 7,
			wellnessRange: ["2026-07-08", "2026-07-14"],
			strydEnriched: 1,
			strydCp: 292,
			runPowerSource: "garmin",
			runFtp: 321,
			vigil: null,
		},
		generatedAt: "2026-07-14T07:25:00Z",
	};
}

describe("renderPage — distance-based workout", () => {
	it("renders metric distance for reps instead of 0min", () => {
		const html = renderPage(renderData());
		// Each 1-mile rep reads as 1.61 km.
		expect(html).toContain("1.61 km");
		// The run card must not show the old broken 0-minute interval rows.
		const runCard = html.slice(html.indexOf('id="card-run"'));
		expect(runCard.slice(0, runCard.indexOf('id="card-swim"'))).not.toContain("0min");
	});

	it("adds a distance meta-pill summarising the metric total", () => {
		const html = renderPage(renderData());
		// 2 × 1 mile = 3.22 km of distance-based work.
		expect(html).toContain("3.22 km");
	});
});
