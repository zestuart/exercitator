/**
 * Top-level orchestrator for the Daily Suggested Workout engine.
 */

import type { IntervalsClient } from "../intervals.js";
import { detectPowerSource } from "./power-source.js";
import { computeReadiness } from "./readiness.js";
import { selectSport } from "./sport-selector.js";
import { selectTerrain } from "./terrain-selector.js";
import type {
	ActivitySummary,
	PowerContext,
	SportSettings,
	WellnessRecord,
	WorkoutSuggestion,
} from "./types.js";
import { buildWorkout } from "./workout-builder.js";
import { selectWorkoutCategory } from "./workout-selector.js";

function dateStr(d: Date): string {
	return d.toISOString().slice(0, 10);
}

const DEFAULT_SPORT_SETTINGS: Omit<SportSettings, "type"> = {
	ftp: null,
	lthr: null,
	threshold_pace: null,
	hr_zones: null,
	pace_zones: null,
	power_zones: null,
};

export async function suggestWorkout(client: IntervalsClient): Promise<WorkoutSuggestion> {
	const now = new Date();
	const d14Ago = new Date(now.getTime() - 14 * 86_400_000);
	const d7Ago = new Date(now.getTime() - 7 * 86_400_000);

	// Fetch all data in parallel
	const [activities, wellness, runSettings, swimSettings] = await Promise.all([
		client.get<ActivitySummary[]>(`/athlete/${client.athleteId}/activities`, {
			oldest: dateStr(d14Ago),
			newest: dateStr(now),
		}),
		client.get<WellnessRecord[]>(`/athlete/${client.athleteId}/wellness`, {
			oldest: dateStr(d7Ago),
			newest: dateStr(now),
		}),
		client
			.get<SportSettings>(`/athlete/${client.athleteId}/sport-settings/Run`)
			.catch((): SportSettings => ({ type: "Run", ...DEFAULT_SPORT_SETTINGS })),
		client
			.get<SportSettings>(`/athlete/${client.athleteId}/sport-settings/Swim`)
			.catch((): SportSettings => ({ type: "Swim", ...DEFAULT_SPORT_SETTINGS })),
	]);

	// Step 1: Detect power source
	const powerContext = detectPowerSource(activities);

	// Step 2: Compute readiness
	const readiness = computeReadiness(wellness, activities, now);

	// Step 3: Select sport
	const sportSelection = selectSport(activities, readiness.score, now, powerContext);

	// Step 4: Select workout category
	const category = selectWorkoutCategory(
		readiness.score,
		activities,
		sportSelection.sport,
		now,
		powerContext,
	);

	// Step 5: Select terrain
	const terrainSelection = selectTerrain(category, activities, now);

	// Step 6: Build workout
	const settings = sportSelection.sport === "Run" ? runSettings : swimSettings;
	const latestCtl = wellness.length > 0 ? (wellness[wellness.length - 1].ctl ?? 20) : 20;
	const workout = buildWorkout(
		category,
		sportSelection.sport,
		settings,
		readiness.score,
		latestCtl,
		powerContext,
	);

	// Combine all warnings
	const warnings = [...readiness.warnings, ...powerContext.warnings];

	return {
		...workout,
		readiness_score: readiness.score,
		sport_selection_reason: sportSelection.reason,
		terrain: terrainSelection.terrain,
		terrain_rationale: terrainSelection.rationale,
		power_context: powerContext,
		warnings,
	};
}
