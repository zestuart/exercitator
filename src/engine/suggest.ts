/**
 * Top-level orchestrator for the Daily Suggested Workout engine.
 *
 * Exports three layers:
 *   fetchTrainingData()            — shared data-fetching (4 API calls)
 *   suggestWorkoutForSport()       — full pipeline for a fixed sport
 *   suggestWorkout()               — auto-selects sport, then runs pipeline
 */

import type { IntervalsClient } from "../intervals.js";
import { detectPowerSource } from "./power-source.js";
import { computeReadiness } from "./readiness.js";
import { selectSport } from "./sport-selector.js";
import { applyStaleness, computeStaleness } from "./staleness.js";
import { selectTerrain } from "./terrain-selector.js";
import type {
	ActivitySummary,
	PowerContext,
	SportSettings,
	VigilSummary,
	WellnessRecord,
	WorkoutSuggestion,
} from "./types.js";
import { runVigilPipeline } from "./vigil/index.js";
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

// ---------------------------------------------------------------------------
// Shared data-fetching layer
// ---------------------------------------------------------------------------

export interface TrainingData {
	activities: ActivitySummary[];
	wellness: WellnessRecord[];
	runSettings: SportSettings;
	swimSettings: SportSettings;
}

export async function fetchTrainingData(client: IntervalsClient): Promise<TrainingData> {
	const now = new Date();
	const d14Ago = new Date(now.getTime() - 14 * 86_400_000);
	const d7Ago = new Date(now.getTime() - 7 * 86_400_000);

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

	return { activities, wellness, runSettings, swimSettings };
}

// ---------------------------------------------------------------------------
// Pipeline for a fixed sport
// ---------------------------------------------------------------------------

export function suggestWorkoutFromData(
	data: TrainingData,
	sport: "Run" | "Swim",
	now: Date = new Date(),
	sportSelectionReason?: string,
	strydCp?: number | null,
	athleteId = "0",
): WorkoutSuggestion {
	const { activities, wellness, runSettings, swimSettings } = data;

	const powerContext = detectPowerSource(activities);

	// Override FTP with Stryd critical power when available — authoritative
	// source directly from the foot pod, not inferred by intervals.icu.
	// If the athlete has a valid CP but no recent Stryd run data (e.g. ran
	// with just Apple Watch), upgrade the source to "stryd" — the CP API
	// only returns a value if the athlete IS a Stryd user.
	if (strydCp != null) {
		powerContext.ftp = Math.round(strydCp);
		powerContext.rolling_ftp = Math.round(strydCp);
		if (powerContext.source === "none") {
			powerContext.source = "stryd";
			powerContext.confidence = "low";
			if (!powerContext.warnings.some((w) => w.includes("Stryd"))) {
				powerContext.warnings.push(
					"FTP set from Stryd critical power API \u2014 no recent Stryd run data",
				);
			}
		}
	}
	const readiness = computeReadiness(wellness, activities, now);
	const staleness = computeStaleness(activities, sport, now);

	// Vigil: biomechanical deviation alert (running sports only, requires Stryd metrics in DB)
	// Stryd stores all activities as sport="Run" regardless of intervals.icu classification,
	// so always query with "Run" for the Vigil pipeline.
	const isRunSport = ["Run", "VirtualRun", "TrailRun", "Treadmill"].includes(sport);
	const vigilResult = isRunSport ? runVigilPipeline(athleteId, "Run", now) : null;

	const readinessCategory = selectWorkoutCategory(
		readiness.score,
		activities,
		sport,
		now,
		powerContext,
		vigilResult?.alert,
	);
	const category = applyStaleness(readinessCategory, staleness.tier);

	const terrainSelection = selectTerrain(category, activities, now, sport);

	const settings = sport === "Run" ? runSettings : swimSettings;
	const latestCtl = wellness.length > 0 ? (wellness[wellness.length - 1].ctl ?? 20) : 20;
	const workout = buildWorkout(
		category,
		sport,
		settings,
		readiness.score,
		latestCtl,
		powerContext,
		staleness.paceBufferSecs,
		staleness.hrOnly,
	);

	// Power context warnings (Stryd/Garmin detection) are only relevant for running
	const warnings = [
		...readiness.warnings,
		...(sport === "Run" ? powerContext.warnings : []),
		...staleness.warnings,
	];

	// Build Vigil summary for output (only when active or building)
	let vigil: VigilSummary | undefined;
	if (vigilResult && vigilResult.status !== "inactive") {
		vigil = {
			severity: vigilResult.alert.severity,
			summary: vigilResult.alert.summary,
			recommendation: vigilResult.alert.recommendation,
			flags: vigilResult.alert.flags.map((f) => ({
				metric: f.metric,
				zScore: f.zScore,
				weight: f.weight,
				weightedZ: f.weightedZ,
				value7d: f.value7d,
				value30d: f.value30d,
			})),
			baselineWindow: vigilResult.baselineWindow,
			acuteWindow: vigilResult.acuteWindow,
			status: vigilResult.status,
		};
	}

	return {
		...workout,
		readiness_score: readiness.score,
		sport_selection_reason: sportSelectionReason ?? `Forced: ${sport}`,
		terrain: terrainSelection.terrain,
		terrain_rationale: terrainSelection.rationale,
		power_context: powerContext,
		warnings,
		vigil,
	};
}

// ---------------------------------------------------------------------------
// Convenience: fetch + fixed sport
// ---------------------------------------------------------------------------

export async function suggestWorkoutForSport(
	client: IntervalsClient,
	sport: "Run" | "Swim",
): Promise<WorkoutSuggestion> {
	const data = await fetchTrainingData(client);
	return suggestWorkoutFromData(data, sport);
}

// ---------------------------------------------------------------------------
// Full auto: fetch + select sport + pipeline
// ---------------------------------------------------------------------------

export async function suggestWorkout(client: IntervalsClient): Promise<WorkoutSuggestion> {
	const data = await fetchTrainingData(client);
	const now = new Date();

	const powerContext = detectPowerSource(data.activities);
	const readiness = computeReadiness(data.wellness, data.activities, now);
	const sportSelection = selectSport(data.activities, readiness.score, now, powerContext);

	return suggestWorkoutFromData(data, sportSelection.sport, now, sportSelection.reason);
}
