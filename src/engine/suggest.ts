/**
 * Top-level orchestrator for the Daily Suggested Workout engine.
 *
 * Exports three layers:
 *   fetchTrainingData()            — shared data-fetching (4 API calls)
 *   suggestWorkoutForSport()       — full pipeline for a fixed sport
 *   suggestWorkout()               — auto-selects sport, then runs pipeline
 */

import { getVigilMetrics } from "../db.js";
import type { IntervalsClient } from "../intervals.js";
import {
	type CrossTrainingStrain,
	assessCrossTrainingStrain,
	findTodayCrossTraining,
	isCrossTraining,
} from "./cross-training-strain.js";
import { localDateStr } from "./date-utils.js";
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

// Re-export for Praescriptor consumption
export type { VigilResult } from "./vigil/index.js";

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

export async function fetchTrainingData(
	client: IntervalsClient,
	tz?: string,
): Promise<TrainingData> {
	const now = new Date();
	const d14Ago = new Date(now.getTime() - 14 * 86_400_000);
	const d7Ago = new Date(now.getTime() - 7 * 86_400_000);

	const [activities, wellness, runSettings, swimSettings] = await Promise.all([
		client.get<ActivitySummary[]>(`/athlete/${client.athleteId}/activities`, {
			oldest: localDateStr(d14Ago, tz),
			newest: localDateStr(now, tz),
		}),
		client.get<WellnessRecord[]>(`/athlete/${client.athleteId}/wellness`, {
			oldest: localDateStr(d7Ago, tz),
			newest: localDateStr(now, tz),
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
// Stryd RPE augmentation
// ---------------------------------------------------------------------------

/**
 * Augment activities with Stryd RPE from vigil_metrics.
 * If an activity has no perceived_exertion but has a Stryd RPE ≥ 7,
 * set perceived_exertion to the Stryd RPE so isHardSession() detects it.
 */
function augmentStrydRpe(
	activities: ActivitySummary[],
	athleteId: string,
	now: Date,
	tz?: string,
): void {
	const d14Ago = localDateStr(new Date(now.getTime() - 14 * 86_400_000), tz);
	const newest = localDateStr(now, tz);

	let metrics: ReturnType<typeof getVigilMetrics>;
	try {
		metrics = getVigilMetrics(athleteId, "Run", d14Ago, newest);
	} catch {
		return; // DB not available (e.g. in tests without DB)
	}

	// Build a map from activity date → Stryd RPE for quick lookup
	const rpeByDate = new Map<string, number>();
	for (const m of metrics) {
		if (m.strydRpe != null && m.strydRpe >= 7) {
			rpeByDate.set(m.activityDate, m.strydRpe);
		}
	}

	for (const a of activities) {
		if (a.perceived_exertion != null) continue;
		const date = a.start_date_local.slice(0, 10);
		const strydRpe = rpeByDate.get(date);
		if (strydRpe != null) {
			a.perceived_exertion = strydRpe;
		}
	}
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
	tz?: string,
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
	const vigilResult = isRunSport ? runVigilPipeline(athleteId, "Run", now, tz) : null;

	// Stryd RPE as hard-session signal: augment perceived_exertion from Vigil metrics.
	// Only for running sports where we have Stryd data in the DB.
	if (isRunSport && athleteId !== "0") {
		augmentStrydRpe(activities, athleteId, now, tz);
	}

	// Cross-training strain assessment: assess today's weight/climbing activities.
	// Build strain map for all recent cross-training (for hard-session guard).
	const crossTrainingStrains = new Map<string, CrossTrainingStrain>();
	const crossTrainingActivities = activities.filter((a) => isCrossTraining(a.type));
	for (const ct of crossTrainingActivities) {
		// HRV stream would require an API call — skip tier 1 in the sync pipeline.
		// Tier 1 (HRV) is available via the async Praescriptor path.
		const strain = assessCrossTrainingStrain(ct, activities);
		crossTrainingStrains.set(ct.id, strain);
	}

	// Prescription gating: if any same-day cross-training has unknown strain, block.
	const todayCrossTraining = findTodayCrossTraining(activities, now, tz);
	for (const ct of todayCrossTraining) {
		const strain = crossTrainingStrains.get(ct.id);
		if (strain && strain.level === "unknown") {
			return {
				sport,
				category: "base",
				title: "Awaiting cross-training RPE",
				rationale: strain.summary,
				total_duration_secs: 0,
				estimated_load: 0,
				segments: [],
				readiness_score: readiness.score,
				sport_selection_reason: sportSelectionReason ?? `Forced: ${sport}`,
				terrain: "any",
				terrain_rationale: "Pending cross-training strain assessment",
				power_context: powerContext,
				warnings: [`Cross-training strain unknown: ${ct.type} (${ct.id})`],
				status: "awaiting_input",
				awaitingInput: {
					reason: "cross_training_rpe",
					activityId: ct.id,
					activityName: `${ct.type} ${ct.start_date_local.slice(0, 10)}`,
					activityType: ct.type,
					prompt: `Rate your ${ct.type.replace(/([A-Z])/g, " $1").trim()} session (1–10 RPE):`,
				},
			};
		}
	}

	const readinessCategory = selectWorkoutCategory(
		readiness.score,
		activities,
		sport,
		now,
		powerContext,
		vigilResult?.alert,
		crossTrainingStrains,
		tz,
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

export async function suggestWorkout(
	client: IntervalsClient,
	tz?: string,
): Promise<WorkoutSuggestion> {
	const data = await fetchTrainingData(client, tz);
	const now = new Date();

	const powerContext = detectPowerSource(data.activities);
	const readiness = computeReadiness(data.wellness, data.activities, now);
	const sportSelection = selectSport(data.activities, readiness.score, now, powerContext);

	return suggestWorkoutFromData(
		data,
		sportSelection.sport,
		now,
		sportSelection.reason,
		undefined,
		"0",
		tz,
	);
}
