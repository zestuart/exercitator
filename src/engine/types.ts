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

/**
 * One night of overnight health telemetry, sourced from Promus WHOOP for users
 * flagged `healthSource: "promus-whoop"`. Feeds the Sleep and HRV readiness
 * components in place of intervals.icu wellness. `date` is the wake date
 * (YYYY-MM-DD) the night is attributed to — the key readiness joins on.
 */
export interface NightlyHealth {
	date: string;
	/** Total sleep duration in seconds (WHOOP `duration_s`). */
	sleepSecs: number | null;
	/** Nightly median RMSSD in ms (WHOOP `rmssd_median_ms`). */
	hrvRmssd: number | null;
}

/**
 * Thrown when a `promus-whoop` user's overnight health telemetry cannot be
 * obtained — Promus unreachable/non-2xx, or no WHOOP night present for today's
 * wake date. Callers convert this into a `health_unavailable` suggestion
 * rather than producing a prescription from degraded readiness inputs.
 */
export class HealthUnavailableError extends Error {
	constructor(
		message: string,
		/** Machine-readable reason for surfacing on the blocked card. */
		readonly reason: string,
	) {
		super(message);
		this.name = "HealthUnavailableError";
	}
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
	/**
	 * Segment duration basis. Absent (or "time") means the segment runs for
	 * `duration_secs`. "distance" means it runs for `distance_m` metres and
	 * `duration_secs` is not meaningful (left at 0) — the render/serialisation
	 * layers key off this to show distance instead of "0min". Populated by the
	 * Stryd swap when a served library workout uses distance-based segments
	 * (e.g. "The Tom Workout (Distance)" — 1-mile reps).
	 */
	duration_type?: "time" | "distance";
	/**
	 * Canonical segment distance in metres, set when `duration_type` is
	 * "distance". The Stryd source carries the distance in the authored
	 * template's own unit (`distance_unit_selected`, e.g. "mile"); the mapper
	 * converts to metres here so every downstream surface is metric.
	 */
	distance_m?: number;
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

/**
 * Suppression metadata when the requested sport is already trained today.
 * `alternateSport` is the opposite sport — null if both sports have already
 * been trained today (rest-only). Render layer may further hide the swap
 * CTA when the user's profile doesn't have the alternate sport configured.
 */
export interface RestMessage {
	trainedSport: "Run" | "Swim";
	trainedActivityId: string;
	trainedActivityType: string;
	trainedAt: string;
	alternateSport: "Run" | "Swim" | null;
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
	/**
	 * Active manual run power-source override applied to `power_context`.
	 *   "stryd" / "garmin" — athlete pinned the source via Praescriptor.
	 * Undefined / absent means auto-detection (the rolling-window heuristic).
	 */
	powerSourceOverride?: "stryd" | "garmin";
	warnings: string[];
	vigil?: VigilSummary;
	/**
	 * Suggestion status:
	 *   'ready'            — engine produced a prescription (default).
	 *   'awaiting_input'   — cross-training strain unknown; blocked on RPE.
	 *   'already_trained'  — requested sport already done today; show the
	 *                        Quies suppression card and the swap CTA
	 *                        (renderer hides segments).
	 *   'health_unavailable' — a `promus-whoop` user's overnight WHOOP telemetry
	 *                        is missing for today or Promus is unreachable; we
	 *                        refuse to prescribe from degraded readiness inputs
	 *                        (renderer hides segments and shows a sync prompt).
	 */
	status?: "ready" | "awaiting_input" | "already_trained" | "health_unavailable";
	/** Present when status is 'awaiting_input'. */
	awaitingInput?: AwaitingInput;
	/** Present when status is 'already_trained'. */
	restMessage?: RestMessage;
	/** Present when status is 'health_unavailable': machine-readable cause. */
	healthUnavailableReason?: string;
	/** Present when status is 'health_unavailable': user-facing explanation. */
	healthUnavailableMessage?: string;
	/**
	 * Where the segments came from. Set by Praescriptor's Stryd swap layer
	 * (src/web/prescriptions.ts) when the user has `runRecommendationSource:
	 * "stryd"`. The engine itself never sets this.
	 *
	 *   "stryd"                — segments are from a Stryd-served workout
	 *   "exercitator-fallback" — Stryd query failed or no candidate matched;
	 *                            fell back to the engine's own segments
	 *   undefined / "exercitator" — engine output (default; rendered with no chip)
	 */
	prescriptionSource?: "stryd" | "form" | "exercitator" | "exercitator-fallback";
	/**
	 * Which external vendor was attempted when `prescriptionSource` is
	 * "exercitator-fallback". `undefined` on the success path (the
	 * specific vendor is encoded in `prescriptionSource` directly). Used
	 * by the render layer to phrase the fallback chip correctly
	 * ("Stryd unavailable" vs "FORM unavailable").
	 */
	fallbackVendor?: "stryd" | "form";
	/** When prescriptionSource is "exercitator-fallback": why we fell back. */
	fallbackReason?: string;
	/** Stryd workout id (when prescriptionSource is "stryd"). */
	strydWorkoutId?: number;
	/** Stryd workout title (when prescriptionSource is "stryd"). */
	strydWorkoutTitle?: string;
	/** Pick rationale returned by pickStrydWorkout (when prescriptionSource is "stryd"). */
	strydPickRationale?: string;
	/**
	 * The Stryd recommendation-set id this workout came from. Used by the
	 * send-to-{stryd,intervals} flows to fire `PATCH /recommendations/{id}`
	 * with `{selected_id: <workoutId>}` so Stryd's recommendation engine
	 * learns that the user picked this option, regardless of which
	 * execution channel (Stryd watch / intervals.icu) they chose.
	 * String per the wire contract (int64 serialised as a string).
	 */
	strydRecommendationSetId?: string;
	/**
	 * The original Stryd `workout` payload from the recommendation, preserved
	 * verbatim so the push-to-Stryd flow can round-trip the workout back to
	 * Stryd's calendar with the original block structure (repeat + nested
	 * segments) and exact `intensity_percent` bands intact. Without this, our
	 * flat WorkoutSegment[] representation loses the repeat shape and the
	 * stryd-format converter substitutes Z1 Easy bands for everything because
	 * Stryd-sourced segments don't carry `stryd_zone`. Typed as `unknown` here
	 * to avoid a cycle with `src/stryd/client.ts`; the swap layer narrows.
	 */
	strydOriginalWorkout?: unknown;
	/** FORM workout id (UUID-v7, when prescriptionSource is "form"). */
	formWorkoutId?: string;
	/** FORM workout name/title (when prescriptionSource is "form"). */
	formWorkoutTitle?: string;
	/** Pick rationale returned by pickFormWorkout (when prescriptionSource is "form"). */
	formPickRationale?: string;
	/**
	 * The original FORM `setGroups[]`-bearing workout body, preserved
	 * verbatim. Used by replay-from-Promus + the FORM-text emitter so the
	 * fallback paste channel keeps working byte-equal even after the
	 * primary segments are flattened/collapsed. Typed `unknown` here to
	 * avoid a cycle with `src/form/client.ts`; the swap/render layers
	 * narrow.
	 */
	formOriginalWorkout?: unknown;
}
