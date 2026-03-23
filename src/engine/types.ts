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
}

/** The six workout categories the engine can recommend */
export type WorkoutCategory = "rest" | "recovery" | "base" | "tempo" | "intervals" | "long";

/** A single segment of a structured workout */
export interface WorkoutSegment {
	name: string;
	duration_secs: number;
	target_description: string;
	target_hr_zone?: number;
	target_pace_secs?: number;
	repeats?: number;
	work_duration_secs?: number;
	rest_duration_secs?: number;
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
	warnings: string[];
}
