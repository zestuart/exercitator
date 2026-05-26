/**
 * Integration tests for FORM-sourced segments through the render-adjacent
 * pure helpers — `groupPairSegments` (engine) and `suggestionToApi` (API
 * payload). Render itself is HTML output and tested elsewhere via
 * snapshots; this file verifies the data shape that drives it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { suggestionToApi } from "../../src/api/payload.js";
import { formWorkoutToSegments } from "../../src/engine/form-mapper.js";
import { groupPairSegments } from "../../src/engine/segment-groups.js";
import type { SportSettings, WorkoutSuggestion } from "../../src/engine/types.js";
import type { FormWorkoutBody } from "../../src/form/client.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "form-personalized");
const ENDURANCE = JSON.parse(
	readFileSync(join(FIXTURE_DIR, "workout-endurance.json"), "utf-8"),
) as FormWorkoutBody;
const POWER = JSON.parse(
	readFileSync(join(FIXTURE_DIR, "workout-power.json"), "utf-8"),
) as FormWorkoutBody;

const SETTINGS: SportSettings = {
	sport: "Swim",
	threshold_pace: 0.94,
	hr_zones: [118, 125, 131, 139, 143, 147, 161],
} as unknown as SportSettings;

function makeFormSuggestion(body: FormWorkoutBody): WorkoutSuggestion {
	const segments = formWorkoutToSegments(body, SETTINGS);
	return {
		sport: "Swim",
		category: "base",
		title: body.name,
		rationale: body.description,
		total_duration_secs: segments.reduce((s, seg) => s + seg.duration_secs, 0),
		estimated_load: 30,
		segments,
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
		prescriptionSource: "form",
		formWorkoutId: body.id,
		formWorkoutTitle: body.name,
		formPickRationale: "base: picked",
		formOriginalWorkout: body,
	};
}

describe("FORM segments → groupPairSegments", () => {
	it("Endurance fixture: every pre-collapsed pair stays as a single (no double-collapse)", () => {
		const segments = formWorkoutToSegments(ENDURANCE, SETTINGS);
		const groups = groupPairSegments(segments);
		// Endurance fixture produces 6 pre-collapsed segments (warmup +
		// 2 preSet + 2 main + cooldown). None of them flat-pair-match
		// each other, so all 6 stay as single groups.
		expect(groups).toHaveLength(6);
		for (const g of groups) {
			expect(g.kind).toBe("single");
		}
		// At least one segment carries the FORM pre-collapse markers.
		const withRepeats = segments.filter((s) => (s.repeats ?? 0) > 1);
		expect(withRepeats.length).toBeGreaterThan(0);
		const drill = withRepeats.find((s) => s.target_description.includes("drill"));
		expect(drill?.repeats).toBe(10);
		expect(drill?.rest_duration_secs).toBe(15);
	});

	it("Power fixture: 3 rounds × 4 sets emits 12 single groups (multi-segment rounds don't pair-collapse)", () => {
		const segments = formWorkoutToSegments(POWER, SETTINGS);
		// 3 setGroup types ({warmup, preSet, main, cooldown}), with main rounds=3.
		// Main alone: 3 rounds × 4 sets = 12 segments. Plus warmup, preSet
		// (which has rounds=1), cooldown.
		const main = segments.filter((s) => s.name === "Main set");
		expect(main).toHaveLength(12);
		const groups = groupPairSegments(segments);
		// Every group should be a single — the round structure
		// [A,B,C,D,A,B,C,D,A,B,C,D] doesn't match the A-B-A-B pair
		// detector. Known UX gap; flagged for future N-tuple-collapse work.
		for (const g of groups) {
			expect(g.kind).toBe("single");
		}
	});
});

describe("FORM-sourced WorkoutSuggestion → suggestionToApi", () => {
	it("Endurance fixture: ApiSegments carry hr_zone, distance, and FORM provenance fields", () => {
		const suggestion = makeFormSuggestion(ENDURANCE);
		const out = suggestionToApi(suggestion, false);

		expect(out.prescription_source).toBe("form");
		expect(out.form_workout_id).toBe(ENDURANCE.id);
		expect(out.form_workout_title).toBe(ENDURANCE.name);
		expect(out.form_pick_rationale).toContain("base: picked");
		// fallback_vendor only on fallback path
		expect(out.fallback_vendor).toBeUndefined();
		expect(out.fallback_reason).toBeUndefined();

		// Every segment carries a target_description; HR zone shows up
		// where the source set had a non-zero level.
		expect(out.segments.length).toBe(6);
		const drill = out.segments.find((s) => s.target_description.includes("drill"));
		expect(drill).toBeDefined();
		expect(drill?.target_hr_zone).toBe(1); // drill → easy → Z1
		// Pre-collapsed pair surfaces as repeats on the API too.
		expect(drill?.repeats).toBe(10);
		expect(drill?.rest_duration_s).toBe(15);
	});

	it("Power fixture: 12-segment main set survives the API round-trip intact", () => {
		const suggestion = makeFormSuggestion(POWER);
		const out = suggestionToApi(suggestion, false);
		const main = out.segments.filter((s) => s.name === "Main set");
		expect(main).toHaveLength(12);
		// First main segment is the 150m strong → Z3.
		expect(main[0].target_description).toMatch(/150m/);
		expect(main[0].target_hr_zone).toBe(3);
	});

	it("FORM fallback path: ApiSegment exposes fallback_vendor='form' + reason", () => {
		// Engine-only suggestion with a fallback flag (synthetic — happens
		// when the FORM swap can't reach the vendor).
		const fallback: WorkoutSuggestion = {
			...makeFormSuggestion(ENDURANCE),
			prescriptionSource: "exercitator-fallback",
			fallbackVendor: "form",
			fallbackReason: "http_503",
			formWorkoutId: undefined,
			formWorkoutTitle: undefined,
			formPickRationale: undefined,
			formOriginalWorkout: undefined,
		};
		const out = suggestionToApi(fallback, false);
		expect(out.prescription_source).toBe("exercitator-fallback");
		expect(out.fallback_vendor).toBe("form");
		expect(out.fallback_reason).toBe("http_503");
		expect(out.form_workout_id).toBeUndefined();
	});
});

describe("FORM determinism guard (Phase 7 replay)", () => {
	// These snapshots lock the FORM-text + intervals.icu description
	// bytes for the Endurance fixture against a fixed CSS (0.94 m/s).
	// If the swim builder, mapper, form-format, intervals-format, or
	// any helper they call drifts, this hash changes and the test
	// fails — a structural signal that replay-from-Promus would now
	// diverge from the freshly-rendered output.
	//
	// To update intentionally (e.g. after a calibrated table change):
	//   rtk vitest run -u tests/web/form-render-integration.test.ts
	//
	// Mirror script for operator-side replay:
	//   tsx scripts/replay-form-dsw.ts <suggestion.json>
	//
	// Once Promus #167 (DSW read endpoint) lands, the same hashes
	// here form the determinism contract for replay-from-Promus.

	it("Endurance fixture renders to byte-stable FORM-text + intervals description", async () => {
		const { createHash } = await import("node:crypto");
		const { buildFormDescription } = await import("../../src/web/form-format.js");
		const { buildIntervalsDescription } = await import("../../src/web/intervals-format.js");

		const suggestion = makeFormSuggestion(ENDURANCE);
		const formText = buildFormDescription(suggestion);
		const intervals = buildIntervalsDescription(suggestion);
		const formHash = createHash("sha256").update(formText).digest("hex");
		const intervalsHash = createHash("sha256").update(intervals).digest("hex");

		// Snapshots — update with -u after a deliberate change.
		expect({ formHash, intervalsHash }).toMatchInlineSnapshot(`
			{
			  "formHash": "859b1b0ed4b1ab54384559a623c13a3262cb3611ee03320de461089b61421f7f",
			  "intervalsHash": "6e8af55bbd12c6c9e8e47ae22a0805c9135af34b1da1c2d390c95b50c7d6684a",
			}
		`);

		// Sanity asserts so a regression has obvious failure messages
		// before falling through to the snapshot.
		expect(formText).toContain("10 x 25 DCH Easy 15 sec rest");
		expect(formText).toContain("2 x 50 FR Easy 15 sec rest");
		expect(formText).toContain("2 x 200 FR Mod 35 sec rest");
		expect(formText).not.toMatch(/\d+:\d+\/100m/);
		expect(intervals).toContain("2:06/100m");
		expect(intervals).toContain("1:51/100m");
	});
});

describe("formatDuration via groupPairSegments — sub-minute swim rests", () => {
	// The render layer calls formatDuration on `seg.rest_duration_secs`.
	// FORM emits 15s / 25s / 30s / 35s defined rest. The contract is that
	// these values flow through to the segment intact — the render path
	// formats them via its own helper (covered in render snapshot tests).
	it("FORM rest durations are preserved on the segment", () => {
		const segments = formWorkoutToSegments(ENDURANCE, SETTINGS);
		const restValues = segments
			.map((s) => s.rest_duration_secs)
			.filter((v): v is number => typeof v === "number");
		// Endurance fixture: rests of 15s, 35s, 25s on the various sets.
		expect(restValues).toEqual(expect.arrayContaining([15, 35, 25]));
		// All sub-minute or just-above.
		for (const v of restValues) {
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThan(120);
		}
	});
});
