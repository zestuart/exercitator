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
	};
	warnings: string[];
	injury_warning: InjuryWarningBlock | null;
	segments: ApiSegment[];
}

export interface SuggestedResponse {
	generated_at: string;
	user_id: string;
	date: string;
	tz: string;
	status: "ready";
	suggestion: SuggestedWorkoutBody;
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
