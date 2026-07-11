/**
 * DTOs for the HTTP API responses.
 *
 * These are the wire shapes — see phase2/exercitator-http-api-spec.md §5.
 * They deliberately do not re-export engine types so the wire contract is
 * independent from internal refactors.
 */

export interface HealthResponse {
	ok: boolean;
	intervals_reachable: boolean;
	stryd_reachable: boolean;
	cache_age_s: number;
	version: string;
	users_configured: string[];
}

export type ReadinessTier = "ready" | "caution" | "recover" | "unknown";
export type ReadinessAdvisory = "green" | "amber" | "red" | "grey";
export type ComponentStatus = "ok" | "low" | "unknown";

export interface ReadinessBlock {
	score: number | null;
	tier: ReadinessTier;
	advisory: ReadinessAdvisory;
	components: {
		hrv: ComponentStatus;
		sleep: ComponentStatus;
		soreness: ComponentStatus;
		fatigue: ComponentStatus;
	};
	/**
	 * Promus Vigor Vitae (in-house Body-Battery recovery, 0–100) — the acute
	 * component now driving the readiness score for `promus-whoop` users. Null
	 * when unavailable (non-WHOOP user, or VV read failed → score fell back to
	 * the sleep-duration band). The `sleep` badge above still reflects real
	 * sleep duration.
	 */
	vigor_vitae: { value: number; level: string } | null;
}

export interface InjuryWarningFlag {
	metric: string;
	z_score: number;
	weight: number;
	value_7d: number;
	value_30d: number;
}

export interface InjuryWarningBlock {
	severity: 0 | 1 | 2 | 3;
	status: "active" | "building" | "inactive" | "unknown";
	summary: string | null;
	flags: InjuryWarningFlag[];
}

export type CriticalPowerSource =
	| "stryd_direct"
	| "stryd_intervals"
	| "intervals_inferred"
	| "none";

export interface CriticalPowerBlock {
	watts: number | null;
	source: CriticalPowerSource;
	updated_at: string | null;
	confidence: "high" | "medium" | "low";
}

export interface TrainingLoadBlock {
	fitness_ctl: number | null;
	fatigue_atl: number | null;
	form_tsb: number | null;
	weekly_tss: number | null;
	trend_7d: "rising" | "flat" | "falling" | null;
}

export interface LastWorkoutBlock {
	id: string;
	started_at: string;
	name: string;
	type: string;
	duration_s: number;
	tss: number | null;
	intensity_factor: number | null;
}

export interface StatusResponse {
	generated_at: string;
	user_id: string;
	athlete_id: string;
	readiness: ReadinessBlock;
	injury_warning: InjuryWarningBlock;
	critical_power: CriticalPowerBlock;
	training_load: TrainingLoadBlock;
	last_workout: LastWorkoutBlock | null;
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

export type TargetKind = "power" | "pace" | "hr";

export type SegmentTarget =
	| { kind: "power"; low_w: number; high_w: number }
	| {
			kind: "pace";
			stroke: "free" | "back" | "breast" | "fly" | "im" | "kick" | "drill" | "mixed";
			low_s_per_100m: number;
			high_s_per_100m: number;
	  }
	| { kind: "hr"; zone: number; low_bpm?: number; high_bpm?: number };

export interface ApiSegment {
	name: string;
	duration_s: number;
	target_description: string;
	target: SegmentTarget | null;
	target_hr_zone: number | null;
	repeats?: number;
	work_duration_s?: number;
	rest_duration_s?: number;
	/**
	 * Power/target for the REST portion of a `repeats` block, when distinct
	 * from sub-Z1 implicit recovery. Set by Stryd-sourced fartlek-style
	 * pairs where Stryd specifies a particular recovery power band
	 * (e.g. 60–70 % CP). Engine-built intervals leave these unset and the
	 * client is expected to render the rest as easy recovery.
	 */
	rest_target?: SegmentTarget;
	rest_target_description?: string;
}

export interface SuggestedWorkoutBody {
	sport: "Run" | "Swim";
	category: string;
	title: string;
	rationale: string;
	total_duration_s: number;
	estimated_load: number;
	readiness_score: number;
	sport_selection_reason: string;
	terrain: string;
	terrain_rationale: string;
	power_context: {
		source: CriticalPowerSource;
		ftp: number;
		confidence: "high" | "low";
		/**
		 * Active manual power-source override driving this prescription:
		 *   "auto"   — the rolling-window heuristic chose the source
		 *   "stryd"  — athlete pinned Stryd (targets at Stryd scale)
		 *   "garmin" — athlete pinned Garmin (FTP scaled from Stryd by ÷0.87)
		 */
		override: "auto" | "stryd" | "garmin";
	};
	warnings: string[];
	injury_warning: InjuryWarningBlock | null;
	segments: ApiSegment[];
	/**
	 * Where the segments came from. Only set when a vendor-swap layer ran.
	 *   "stryd"                — Stryd-served Run workout (ze)
	 *   "form"                 — FORM-served Swim workout (ze)
	 *   "exercitator-fallback" — vendor attempted but unavailable; engine output
	 *   "exercitator"          — explicit engine output (rest day; no swap attempted)
	 *   omitted                — engine output (default)
	 */
	prescription_source?: "stryd" | "form" | "exercitator" | "exercitator-fallback";
	/** Which vendor was attempted when prescription_source === "exercitator-fallback". */
	fallback_vendor?: "stryd" | "form";
	/** Why the swap fell back (only when prescription_source === "exercitator-fallback"). */
	fallback_reason?: string;
	/** Stryd workout id (only when prescription_source === "stryd"). */
	stryd_workout_id?: number;
	/** Stryd workout title (only when prescription_source === "stryd"). */
	stryd_workout_title?: string;
	/** pickStrydWorkout's rationale (only when prescription_source === "stryd"). */
	stryd_pick_rationale?: string;
	/** FORM workout id (UUID-v7; only when prescription_source === "form"). */
	form_workout_id?: string;
	/** FORM workout title (only when prescription_source === "form"). */
	form_workout_title?: string;
	/** pickFormWorkout's rationale (only when prescription_source === "form"). */
	form_pick_rationale?: string;
}

/**
 * Suppression block emitted alongside `suggestion` when the requested sport
 * has already been trained today. `suggestion` is still present (with
 * segments: [], category: "rest") so older clients degrade gracefully;
 * newer clients should branch on `status === "already_trained"` and render
 * `rest_message` instead of the segment list. `invocation` is the
 * server-generated Quies opening line for clients that want to display the
 * pre-rendered deity (or plain, for non-deity profiles) message; clients
 * may ignore it and render their own.
 *
 * Introduced in API version 0.2.0.
 */
export interface RestMessageBlock {
	trained_sport: "Run" | "Swim";
	trained_activity_id: string;
	trained_activity_type: string;
	trained_at: string;
	alternate_sport: "Run" | "Swim" | null;
	invocation: string;
}

/**
 * Server-rendered liturgical narration accompanying a `status: "ready"`
 * suggestion. Mirrors what Praescriptor renders on its cards: the patron
 * deity's `opening` greeting (Diana for Run, Amphitrite for Swim, profiled
 * by the workout's category + readiness + warnings), the `rationale_header`
 * ("Under Minerva's Counsel") above the engine's rationale text, and
 * Apollo's `closing` blessing.
 *
 * For profiles with `deities: false` (Pam), this block carries plain
 * English instead — the field is always populated on `ready` responses
 * so clients don't have to branch on the user's profile to know whether
 * to render it. Clients may ignore this entirely and substitute their
 * own narration.
 *
 * Cache: identical to Praescriptor's invocations cache — keyed by
 * (sport, category, date) and shared across the process. First-of-day
 * `/dashboard` or `/workouts/suggested` calls cost one Anthropic API
 * round-trip; subsequent same-day calls are free.
 *
 * Introduced in API version 0.2.1.
 */
export interface InvocationBlock {
	opening: string;
	rationale_header: string;
	closing: string;
}

export interface SuggestedResponse {
	generated_at: string;
	user_id: string;
	date: string;
	tz: string;
	status: "ready" | "already_trained" | "health_unavailable";
	suggestion: SuggestedWorkoutBody;
	/** Present iff status === "already_trained". Introduced in 0.2.0. */
	rest_message?: RestMessageBlock;
	/** Present iff status === "ready". Introduced in 0.2.1. */
	invocation?: InvocationBlock;
	/** Present iff status === "health_unavailable". Introduced in 0.2.2. */
	health_unavailable?: HealthUnavailableBlock;
}

/**
 * Why a prescription could not be produced: the user's overnight WHOOP
 * telemetry (Sleep + HRV source) is missing for today or Promus is
 * unreachable. The engine hard-fails rather than prescribe from degraded
 * readiness inputs. Introduced in 0.2.2.
 */
export interface HealthUnavailableBlock {
	reason: string;
	message: string;
}

export interface TodayScheduledWorkout {
	id: string;
	name: string;
	type: string;
	planned_duration_s: number | null;
	planned_tss: number | null;
	target_power_w: [number, number] | null;
	structured: boolean;
	stryd_pushed: boolean;
}

export interface TodayCompletedWorkout {
	id: string;
	name: string;
	type: string;
	started_at: string;
	duration_s: number;
	tss: number | null;
	intensity_factor: number | null;
	avg_power_w: number | null;
	planned_id: string | null;
}

export interface TodayResponse {
	date: string;
	tz: string;
	scheduled: TodayScheduledWorkout[];
	completed: TodayCompletedWorkout[];
}

export interface DashboardResponse {
	status: StatusResponse;
	today: TodayResponse;
	suggested: SuggestedResponse | null;
	awaiting_input: {
		reason: string;
		activity_id: string;
		activity_name: string;
		activity_type: string;
		prompt: string;
	} | null;
	/** Present when the suggested block hard-failed on missing WHOOP telemetry. */
	health_unavailable: HealthUnavailableBlock | null;
}

// ---------------------------------------------------------------------------
// Cross-training
// ---------------------------------------------------------------------------

export interface CrossTrainingRpeRequest {
	rpe: number;
}

export interface CrossTrainingRpeResponse {
	activity_id: string;
	rpe: number;
	strain_tier: "easy" | "moderate" | "hard" | "unknown";
	applied_to_today: boolean;
}
