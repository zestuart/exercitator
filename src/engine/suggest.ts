/**
 * Top-level orchestrator for the Daily Suggested Workout engine.
 */

import type { IntervalsClient } from "../intervals.js";
import { computeReadiness } from "./readiness.js";
import { selectSport } from "./sport-selector.js";
import type { ActivitySummary, SportSettings, WellnessRecord, WorkoutSuggestion } from "./types.js";
import { buildWorkout } from "./workout-builder.js";
import { selectWorkoutCategory } from "./workout-selector.js";

function dateStr(d: Date): string {
	return d.toISOString().slice(0, 10);
}

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
		client.get<SportSettings>(`/athlete/${client.athleteId}/sport-settings/Run`).catch(
			(): SportSettings => ({
				type: "Run",
				ftp: null,
				lthr: null,
				threshold_pace: null,
				hr_zones: null,
				pace_zones: null,
			}),
		),
		client.get<SportSettings>(`/athlete/${client.athleteId}/sport-settings/Swim`).catch(
			(): SportSettings => ({
				type: "Swim",
				ftp: null,
				lthr: null,
				threshold_pace: null,
				hr_zones: null,
				pace_zones: null,
			}),
		),
	]);

	// Step 1: Compute readiness
	const readiness = computeReadiness(wellness, activities, now);

	// Step 2: Select sport
	const sportSelection = selectSport(activities, readiness.score, now);

	// Step 3: Select workout category
	const category = selectWorkoutCategory(readiness.score, activities, sportSelection.sport, now);

	// Step 4: Build workout
	const settings = sportSelection.sport === "Run" ? runSettings : swimSettings;
	const latestCtl = wellness.length > 0 ? (wellness[wellness.length - 1].ctl ?? 20) : 20;
	const workout = buildWorkout(
		category,
		sportSelection.sport,
		settings,
		readiness.score,
		latestCtl,
	);

	return {
		...workout,
		readiness_score: readiness.score,
		sport_selection_reason: sportSelection.reason,
		warnings: readiness.warnings,
	};
}
