/**
 * Generates structured WorkoutSegment[] for each category × sport combination.
 */

import type { SportSettings, WorkoutCategory, WorkoutSegment, WorkoutSuggestion } from "./types.js";

/** Duration scale factor: CTL/50, clamped [0.6, 1.5]. */
function durationScale(ctl: number): number {
	return Math.min(Math.max(ctl / 50, 0.6), 1.5);
}

/** Scale a duration in seconds by the CTL factor. */
function scaled(baseSecs: number, scale: number): number {
	return Math.round(baseSecs * scale);
}

/** Intensity factors for estimated load calculation. */
const INTENSITY_FACTOR: Record<WorkoutCategory, number> = {
	rest: 0,
	recovery: 0.5,
	base: 0.7,
	tempo: 1.0,
	intervals: 1.2,
	long: 0.8,
};

/** Format pace as mm:ss/km or mm:ss/100m. */
function formatPace(secsPer: number, unit: string): string {
	const mins = Math.floor(secsPer / 60);
	const secs = Math.round(secsPer % 60);
	return `${mins}:${secs.toString().padStart(2, "0")}/${unit}`;
}

/** Generate HR zone target description. */
function hrZoneDesc(zone: number): string {
	return `Z${zone} heart rate`;
}

// ---------------------------------------------------------------------------
// Running workouts
// ---------------------------------------------------------------------------

function buildRunRecovery(settings: SportSettings, scale: number): WorkoutSegment[] {
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(300, scale),
			target_description: "Easy walk",
			target_hr_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: scaled(1350, scale),
			target_description: settings.threshold_pace
				? `Very easy jog, ${formatPace(settings.threshold_pace * 1.3, "km")}`
				: hrZoneDesc(1),
			target_hr_zone: 1,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(300, scale),
			target_description: "Easy walk",
			target_hr_zone: 1,
		},
	];
}

function buildRunBase(settings: SportSettings, scale: number): WorkoutSegment[] {
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(600, scale),
			target_description: "Progressive walk to easy run",
			target_hr_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: scaled(2100, scale),
			target_description: settings.threshold_pace
				? `Steady Z2, ${formatPace(settings.threshold_pace * 1.15, "km")}`
				: `Steady ${hrZoneDesc(2)}`,
			target_hr_zone: 2,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(300, scale),
			target_description: "Easy jog to walk",
			target_hr_zone: 1,
		},
	];
}

function buildRunTempo(settings: SportSettings, scale: number): WorkoutSegment[] {
	const reps = 2;
	const workSecs = scaled(600, scale);
	const restSecs = 180;
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(600, scale),
			target_description: "Progressive warm-up to Z2",
			target_hr_zone: 2,
		},
		{
			name: "Main set",
			duration_secs: reps * (workSecs + restSecs),
			target_description: settings.threshold_pace
				? `${reps}×${Math.round(workSecs / 60)}min at threshold ${formatPace(settings.threshold_pace, "km")} / 3min Z1 recovery`
				: `${reps}×${Math.round(workSecs / 60)}min ${hrZoneDesc(3)} / 3min Z1 recovery`,
			target_hr_zone: 3,
			repeats: reps,
			work_duration_secs: workSecs,
			rest_duration_secs: restSecs,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(300, scale),
			target_description: "Easy jog",
			target_hr_zone: 1,
		},
	];
}

function buildRunIntervals(settings: SportSettings, scale: number): WorkoutSegment[] {
	const reps = Math.max(5, Math.round(7 * scale));
	const workSecs = 150;
	const restSecs = 120;
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(600, scale),
			target_description: "Progressive warm-up to Z2",
			target_hr_zone: 2,
		},
		{
			name: "Main set",
			duration_secs: reps * (workSecs + restSecs),
			target_description: settings.threshold_pace
				? `${reps}×2.5min at ${formatPace(settings.threshold_pace * 0.9, "km")} / 2min Z1 jog`
				: `${reps}×2.5min ${hrZoneDesc(4)} / 2min Z1 jog`,
			target_hr_zone: 4,
			repeats: reps,
			work_duration_secs: workSecs,
			rest_duration_secs: restSecs,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(600, scale),
			target_description: "Easy jog to walk",
			target_hr_zone: 1,
		},
	];
}

function buildRunLong(settings: SportSettings, scale: number): WorkoutSegment[] {
	const mainSecs = scaled(4200, scale);
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(600, scale),
			target_description: "Progressive warm-up",
			target_hr_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: mainSecs,
			target_description: settings.threshold_pace
				? `Steady Z2, ${formatPace(settings.threshold_pace * 1.15, "km")} with optional 10min Z3 pickup`
				: `Steady ${hrZoneDesc(2)} with optional 10min Z3 pickup`,
			target_hr_zone: 2,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(600, scale),
			target_description: "Easy jog to walk",
			target_hr_zone: 1,
		},
	];
}

// ---------------------------------------------------------------------------
// Swimming workouts
// ---------------------------------------------------------------------------

function swimPaceDesc(settings: SportSettings, zoneOffset: number, label: string): string {
	if (settings.threshold_pace) {
		const pace = settings.threshold_pace + zoneOffset;
		return `${label} ${formatPace(pace, "100m")}`;
	}
	return label;
}

function buildSwimRecovery(settings: SportSettings, scale: number): WorkoutSegment[] {
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(240, scale),
			target_description: swimPaceDesc(settings, 20, "200m easy free, Z1"),
			target_hr_zone: 1,
		},
		{
			name: "Drill set",
			duration_secs: scaled(480, scale),
			target_description: "4×50m drill/swim on :15 rest",
			target_hr_zone: 1,
			repeats: 4,
			work_duration_secs: scaled(105, scale),
			rest_duration_secs: 15,
		},
		{
			name: "Main set",
			duration_secs: scaled(480, scale),
			target_description: swimPaceDesc(settings, 18, "400m pull Z1"),
			target_hr_zone: 1,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(240, scale),
			target_description: "200m easy",
			target_hr_zone: 1,
		},
	];
}

function buildSwimBase(settings: SportSettings, scale: number): WorkoutSegment[] {
	const reps = Math.max(4, Math.round(6 * scale));
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(360, scale),
			target_description: "300m (100 free/100 kick/100 pull)",
			target_hr_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: scaled(reps * 270, scale),
			target_description: swimPaceDesc(settings, 10, `${reps}×200m Z2 on :20 rest`),
			target_hr_zone: 2,
			repeats: reps,
			work_duration_secs: scaled(250, scale),
			rest_duration_secs: 20,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(240, scale),
			target_description: "200m easy",
			target_hr_zone: 1,
		},
	];
}

function buildSwimTempo(settings: SportSettings, scale: number): WorkoutSegment[] {
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(360, scale),
			target_description: "300m progressive warm-up",
			target_hr_zone: 1,
		},
		{
			name: "Threshold set",
			duration_secs: scaled(4 * 270, scale),
			target_description: swimPaceDesc(settings, 0, "4×200m Z3 descending on :30 rest"),
			target_hr_zone: 3,
			repeats: 4,
			work_duration_secs: scaled(240, scale),
			rest_duration_secs: 30,
		},
		{
			name: "Speed set",
			duration_secs: scaled(4 * 70, scale),
			target_description: swimPaceDesc(settings, -6, "4×50m Z4 on :20 rest"),
			target_hr_zone: 4,
			repeats: 4,
			work_duration_secs: scaled(50, scale),
			rest_duration_secs: 20,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(240, scale),
			target_description: "200m easy",
			target_hr_zone: 1,
		},
	];
}

function buildSwimIntervals(settings: SportSettings, scale: number): WorkoutSegment[] {
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(360, scale),
			target_description: "300m progressive warm-up",
			target_hr_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: scaled(8 * 105, scale),
			target_description: swimPaceDesc(settings, -6, "8×100m Z4 on :15 rest"),
			target_hr_zone: 4,
			repeats: 8,
			work_duration_secs: scaled(90, scale),
			rest_duration_secs: 15,
		},
		{
			name: "Recovery",
			duration_secs: scaled(240, scale),
			target_description: "200m easy",
			target_hr_zone: 1,
		},
		{
			name: "Sprint set",
			duration_secs: scaled(4 * 65, scale),
			target_description: "4×50m sprint on :30 rest",
			target_hr_zone: 5,
			repeats: 4,
			work_duration_secs: scaled(35, scale),
			rest_duration_secs: 30,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(240, scale),
			target_description: "200m easy",
			target_hr_zone: 1,
		},
	];
}

function buildSwimLong(settings: SportSettings, scale: number): WorkoutSegment[] {
	const mainMetres = Math.round(2500 * scale);
	const segments400 = Math.ceil(mainMetres / 400);
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(480, scale),
			target_description: "400m progressive warm-up",
			target_hr_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: scaled(segments400 * 430, scale),
			target_description: swimPaceDesc(
				settings,
				10,
				`${segments400}×400m Z2 continuous with :10 rest between segments`,
			),
			target_hr_zone: 2,
			repeats: segments400,
			work_duration_secs: scaled(420, scale),
			rest_duration_secs: 10,
		},
		{
			name: "Cool-down",
			duration_secs: scaled(240, scale),
			target_description: "200m easy",
			target_hr_zone: 1,
		},
	];
}

// ---------------------------------------------------------------------------
// Builder dispatch
// ---------------------------------------------------------------------------

const BUILDERS: Record<
	string,
	Record<WorkoutCategory, (s: SportSettings, sc: number) => WorkoutSegment[]>
> = {
	Run: {
		rest: () => [],
		recovery: buildRunRecovery,
		base: buildRunBase,
		tempo: buildRunTempo,
		intervals: buildRunIntervals,
		long: buildRunLong,
	},
	Swim: {
		rest: () => [],
		recovery: buildSwimRecovery,
		base: buildSwimBase,
		tempo: buildSwimTempo,
		intervals: buildSwimIntervals,
		long: buildSwimLong,
	},
};

const TITLES: Record<WorkoutCategory, Record<string, string>> = {
	rest: { Run: "Rest Day", Swim: "Rest Day" },
	recovery: { Run: "Recovery Run", Swim: "Recovery Swim" },
	base: { Run: "Easy Base Run", Swim: "Endurance Swim" },
	tempo: { Run: "Threshold Tempo Run", Swim: "Threshold Swim" },
	intervals: { Run: "VO2max Intervals", Swim: "Speed Intervals" },
	long: { Run: "Long Run", Swim: "Distance Swim" },
};

export function buildWorkout(
	category: WorkoutCategory,
	sport: "Run" | "Swim",
	settings: SportSettings,
	readinessScore: number,
	ctl: number,
): Omit<WorkoutSuggestion, "sport_selection_reason" | "warnings" | "readiness_score"> {
	const scale = durationScale(ctl);
	const builder = BUILDERS[sport][category];
	const segments = builder(settings, scale);

	const totalDuration = segments.reduce((s, seg) => s + seg.duration_secs, 0);
	const estimatedLoad = Math.round((totalDuration / 60) * INTENSITY_FACTOR[category]);

	const rationale = buildRationale(category, readinessScore, sport);

	return {
		sport,
		category,
		title: TITLES[category][sport],
		rationale,
		total_duration_secs: totalDuration,
		estimated_load: estimatedLoad,
		segments,
	};
}

function buildRationale(category: WorkoutCategory, readiness: number, sport: string): string {
	switch (category) {
		case "rest":
			return `Readiness is very low (${readiness}/100). Full rest is recommended to allow recovery.`;
		case "recovery":
			return `Readiness is low (${readiness}/100). A gentle ${sport.toLowerCase()} session to promote blood flow without adding fatigue.`;
		case "base":
			return `Moderate readiness (${readiness}/100). Building aerobic base with steady-state ${sport.toLowerCase()}.`;
		case "tempo":
			return `Good readiness (${readiness}/100). Threshold work to improve lactate clearance.`;
		case "intervals":
			return `High readiness (${readiness}/100). High-intensity intervals to build VO2max and speed.`;
		case "long":
			return `Moderate-to-good readiness (${readiness}/100) and no long session this week. Extended ${sport.toLowerCase()} for endurance.`;
	}
}
