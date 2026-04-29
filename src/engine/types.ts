/** Activity summary as returned by intervals.icu list_activities */
export interface ActivitySummary {
	id: string;
	start_date_local: string;
	type: string;
	moving_time: number;
	distance: number | null;
	icu_training_load: number;
	icu_atl: number;
	icu_ctl: number;
	average_heartrate: number | null;
	max_heartrate: number | null;
	icu_hr_zone_times: number[] | null;
	perceived_exertion: number | null;
	power_load: number | null;
	hr_load: number | null;
	icu_weighted_avg_watts: number | null;
	icu_average_watts: number | null;
	icu_ftp: number | null;
	icu_rolling_ftp: number | null;
	power_field: string | null;
	stream_types: string[] | null;
	device_name: string | null;
	total_elevation_gain: number | null;
	/** Weighted average power as % of FTP (e.g. 90.07 = IF 0.90) */
	icu_intensity: number | null;
	/** Original filename from recording device (e.g. "2026-03-27-111107-Outdoor Running-Stryd.fit") */
	external_id: string | null;
	/** Upload source (e.g. "GARMIN_CONNECT", "OAUTH_CLIENT", "FILE_UPLOAD") */
	source: string | null;
	/** Duration (seconds) × RPE (1–10). Garmin-computed for weight training. */
	session_rpe: number | null;
	/** Total kilograms lifted in the session. Garmin-computed. */
	kg_lifted: number | null;
}

/** Wellness record for a single day */
export interface WellnessRecord {
	id: string;
	ctl: number | null;
	atl: number | null;
	restingHR: number | null;
	hrv: number | null;
	sleepSecs: number | null;
	sleepScore: number | null;
	readiness: number | null;
	weight: number | null;
	soreness: number | null;
	fatigue: number | null;
	stress: number | null;
}

/** Sport-specific settings from intervals.icu */
export interface SportSettings {
	type: string;
	ftp: number | null;
	lthr: number | null;
	threshold_pace: number | null;
	hr_zones: number[] | null;
	pace_zones: number[] | null;
	power_zones: number[] | null;
}

/** Power source detection result */
export type PowerSource = "stryd" | "garmin" | "none";

export interface PowerContext {
	source: PowerSource;
	ftp: number;
	rolling_ftp: number | null;
	correction_factor: number;
	confidence: "high" | "low";
	warnings: string[];
}

/**
 * Workout categories the engine can recommend, ordered by intensity:
 *
 *   rest        — no work
 *   recovery    — Stryd Z1 Easy, low end (very gentle jog)
 *   base        — Stryd Z1 Easy, full band (steady aerobic)
 *   progression — Z1 Easy → low Z2 Moderate, thirds split
 *   tempo       — Stryd Z2 Moderate, sweet-spot (extensive threshold)
 *   threshold   — Stryd Z3 Threshold, sustained (intensive threshold)
 *   intervals   — Stryd Z4 Interval, VO2max
 *   long        — Stryd Z1 Easy duration build, optional Z2 pickup
 */
export type WorkoutCategory =
	| "rest"
	| "recovery"
	| "base"
	| "progression"
	| "tempo"
	| "threshold"
	| "intervals"
	| "long";

/** Terrain guidance */
export type TerrainPreference = "flat" | "rolling" | "hilly" | "trail" | "pool" | "any";

/** A single segment of a structured workout */
export interface WorkoutSegment {
	name: string;
	duration_secs: number;
	target_description: string;
	target_hr_zone?: number;
	target_power_low?: number;
	target_power_high?: number;
	target_pace_secs_low?: number;
	target_pace_secs_high?: number;
	repeats?: number;
	work_duration_secs?: number;
	rest_duration_secs?: number;
	/**
	 * Stryd power zone (1–5) for Stryd workout export. Maps to Stryd's
	 * published 5-zone model:
	 *   1 Easy 65–80%, 2 Moderate 80–90%, 3 Threshold 90–100%,
	 *   4 Interval 100–115%, 5 Repetition 115–130% (% of CP).
	 *
	 * Distinct from `target_hr_zone` — HR and power zones can diverge.
	 * When unset, Stryd export falls back to a conservative recovery band
	 * (sub-Z1) for warm-up / cool-down / rest, or to `target_hr_zone`
	 * with the Stryd map for working segments.
	 */
	stryd_zone?: number;
}

/** Vigil alert summary for inclusion in workout suggestion output. */
export interface VigilSummary {
	severity: 0 | 1 | 2 | 3;
	summary: string;
	recommendation: string;
	flags: {
		metric: string;
		zScore: number;
		weight: number;
		weightedZ: number;
		value7d: number;
		value30d: number;
	}[];
	baselineWindow: string;
	acuteWindow: string;
	status: "active" | "building" | "inactive";
}

/** Awaiting-input metadata when prescription is blocked. */
export interface AwaitingInput {
	reason: "cross_training_rpe";
	activityId: string;
	activityName: string;
	activityType: string;
	prompt: string;
}

/** Complete workout suggestion returned by the engine */
export interface WorkoutSuggestion {
	sport: "Run" | "Swim";
	category: WorkoutCategory;
	title: string;
	rationale: string;
	total_duration_secs: number;
	estimated_load: number;
	segments: WorkoutSegment[];
	readiness_score: number;
	sport_selection_reason: string;
	terrain: TerrainPreference;
	terrain_rationale: string;
	power_context: PowerContext;
	warnings: string[];
	vigil?: VigilSummary;
	/** 'ready' (default) or 'awaiting_input' when cross-training strain is unknown. */
	status?: "ready" | "awaiting_input";
	/** Present when status is 'awaiting_input'. */
	awaitingInput?: AwaitingInput;
}
