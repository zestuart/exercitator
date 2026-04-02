/**
 * Generates structured WorkoutSegment[] for each category × sport combination.
 * Running workouts include dual-target prescription: power (primary) + HR (safety cap).
 */

import type {
	PowerContext,
	SportSettings,
	TerrainPreference,
	WorkoutCategory,
	WorkoutSegment,
	WorkoutSuggestion,
} from "./types.js";

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

/** Minimum total session duration in seconds per category × sport. */
const MIN_DURATION: Record<WorkoutCategory, { Run: number; Swim: number }> = {
	rest: { Run: 0, Swim: 0 },
	recovery: { Run: 1200, Swim: 1200 }, // 20 min
	base: { Run: 1500, Swim: 1500 }, // 25 min
	tempo: { Run: 1800, Swim: 1800 }, // 30 min
	intervals: { Run: 1800, Swim: 1800 }, // 30 min
	long: { Run: 2700, Swim: 2100 }, // 45 min run, 35 min swim
};

/** Derive power zone boundaries from FTP as percentages. */
function powerZone(ftp: number, lowPct: number, highPct: number): { low: number; high: number } {
	return {
		low: Math.round(ftp * lowPct),
		high: Math.round(ftp * highPct),
	};
}

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

/** Build a dual-target description: power primary + HR safety cap. */
function dualTargetDesc(powerDesc: string, hrCap: string, paceDesc: string | null): string {
	const parts = [powerDesc];
	if (paceDesc) parts.push(paceDesc);
	parts.push(`HR cap: ${hrCap}`);
	return parts.join(" | ");
}

/** Get HR zone boundary from settings. */
function hrZoneBoundary(settings: SportSettings, zoneIndex: number): number | null {
	if (!settings.hr_zones || zoneIndex >= settings.hr_zones.length) return null;
	return settings.hr_zones[zoneIndex];
}

/** Format HR cap description from settings. */
function hrCapDesc(settings: SportSettings, zoneIndex: number): string {
	const boundary = hrZoneBoundary(settings, zoneIndex);
	if (boundary) return `<${boundary}bpm`;
	return hrZoneDesc(zoneIndex + 1);
}

interface BuildContext {
	settings: SportSettings;
	scale: number;
	power: PowerContext;
	/** Extra seconds to add to pace targets (per 100m for swim, per km for run). */
	paceBufferSecs: number;
	/** When true, suppress pace/power targets and use HR zones only. */
	hrOnly: boolean;
}

// ---------------------------------------------------------------------------
// Running workouts with dual-target prescription
// ---------------------------------------------------------------------------

function buildRunRecovery(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, power, paceBufferSecs, hrOnly } = ctx;
	const hasPower = !hrOnly && power.source !== "none" && power.ftp > 0;

	// Z1 recovery: < 55% FTP
	const z1 = hasPower ? powerZone(power.ftp, 0, 0.55) : null;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 1.3 + paceBufferSecs / 1000
		: null;

	const mainDesc = hasPower
		? dualTargetDesc(
				`Z1 power <${z1?.high}W`,
				hrCapDesc(settings, 1),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)
		: paceWithBuffer && !hrOnly
			? `Very easy jog, ${formatPace(paceWithBuffer, "km")} | ${hrZoneDesc(1)}`
			: hrZoneDesc(1);

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
			target_description: mainDesc,
			target_hr_zone: 1,
			...(z1 && { target_power_low: 0, target_power_high: z1.high }),
		},
		{
			name: "Cool-down",
			duration_secs: scaled(300, scale),
			target_description: "Easy walk",
			target_hr_zone: 1,
		},
	];
}

function buildRunBase(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, power, paceBufferSecs, hrOnly } = ctx;
	const hasPower = !hrOnly && power.source !== "none" && power.ftp > 0;

	// Z2 endurance: 55–75% FTP
	const z2 = hasPower ? powerZone(power.ftp, 0.55, 0.75) : null;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 1.15 + paceBufferSecs / 1000
		: null;

	const mainDesc = hasPower
		? dualTargetDesc(
				`Z2 power ${z2?.low}–${z2?.high}W`,
				hrCapDesc(settings, 0),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)
		: paceWithBuffer && !hrOnly
			? `Steady Z2, ${formatPace(paceWithBuffer, "km")} | ${hrZoneDesc(2)}`
			: `Steady ${hrZoneDesc(2)}`;

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
			target_description: mainDesc,
			target_hr_zone: 2,
			...(z2 && { target_power_low: z2.low, target_power_high: z2.high }),
		},
		{
			name: "Cool-down",
			duration_secs: scaled(300, scale),
			target_description: "Easy jog to walk",
			target_hr_zone: 1,
		},
	];
}

function buildRunTempo(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, power, paceBufferSecs, hrOnly } = ctx;
	const hasPower = !hrOnly && power.source !== "none" && power.ftp > 0;

	// Z3 tempo: 76–90% FTP
	const z3 = hasPower ? powerZone(power.ftp, 0.76, 0.9) : null;

	const reps = 2;
	const workSecs = scaled(600, scale);
	const restSecs = 180;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace + paceBufferSecs / 1000
		: null;

	const workDesc = hasPower
		? dualTargetDesc(
				`Z3 power ${z3?.low}–${z3?.high}W`,
				hrCapDesc(settings, 2),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)
		: paceWithBuffer && !hrOnly
			? `Threshold ${formatPace(paceWithBuffer, "km")} | ${hrZoneDesc(3)}`
			: hrZoneDesc(3);

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
			target_description: `${Math.round(workSecs / 60)}min ${workDesc} / 3min Z1 recovery`,
			target_hr_zone: 3,
			...(z3 && { target_power_low: z3.low, target_power_high: z3.high }),
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

function buildRunIntervals(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, power, paceBufferSecs, hrOnly } = ctx;
	const hasPower = !hrOnly && power.source !== "none" && power.ftp > 0;

	// Z4 VO2max: 91–105% FTP
	const z4 = hasPower ? powerZone(power.ftp, 0.91, 1.05) : null;

	const reps = Math.max(5, Math.round(7 * scale));
	const workSecs = 150;
	const restSecs = 120;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 0.9 + paceBufferSecs / 1000
		: null;

	const workDesc = hasPower
		? dualTargetDesc(
				`Z4 power ${z4?.low}–${z4?.high}W`,
				hrCapDesc(settings, 3),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)
		: paceWithBuffer && !hrOnly
			? `${formatPace(paceWithBuffer, "km")} | ${hrZoneDesc(4)}`
			: hrZoneDesc(4);

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
			target_description: `2.5min ${workDesc} / 2min Z1 jog`,
			target_hr_zone: 4,
			...(z4 && { target_power_low: z4.low, target_power_high: z4.high }),
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

function buildRunLong(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, power, paceBufferSecs, hrOnly } = ctx;
	const hasPower = !hrOnly && power.source !== "none" && power.ftp > 0;

	// Z2 endurance: 55–75% FTP, with optional Z3 pickup
	const z2 = hasPower ? powerZone(power.ftp, 0.55, 0.75) : null;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 1.15 + paceBufferSecs / 1000
		: null;

	const mainSecs = scaled(4200, scale);
	const mainDesc = hasPower
		? `${dualTargetDesc(
				`Z2 power ${z2?.low}–${z2?.high}W`,
				hrCapDesc(settings, 1),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)} with optional 10min Z3 pickup`
		: paceWithBuffer && !hrOnly
			? `Steady Z2, ${formatPace(paceWithBuffer, "km")} with optional 10min Z3 pickup`
			: `Steady ${hrZoneDesc(2)} with optional 10min Z3 pickup`;

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
			target_description: mainDesc,
			target_hr_zone: 2,
			...(z2 && { target_power_low: z2.low, target_power_high: z2.high }),
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
// Swimming workouts (unchanged — no power source applicable)
// ---------------------------------------------------------------------------

/**
 * Build swim pace description. intervals.icu stores threshold_pace in secs/metre.
 * Convert to secs/100m, apply zone offset + staleness buffer, format as mm:ss/100m.
 * When hrOnly is true, pace targets are suppressed.
 */
function swimPaceDesc(
	settings: SportSettings,
	zoneOffsetSecs: number,
	label: string,
	paceBufferSecs = 0,
	hrOnly = false,
): string {
	if (hrOnly) return label;
	if (settings.threshold_pace) {
		const cssPer100m = settings.threshold_pace * 100;
		const pace = cssPer100m + zoneOffsetSecs + paceBufferSecs;
		return `${label} ${formatPace(pace, "100m")}`;
	}
	return label;
}

/** 300m warm-up: 3 × 100m (free, kick, pull) — used by base, tempo, intervals. */
function swimWarmUp300(scale: number): WorkoutSegment[] {
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(120, scale),
			target_description: "100m easy free",
			target_hr_zone: 1,
		},
		{
			name: "Warm-up",
			duration_secs: scaled(120, scale),
			target_description: "100m kick with board",
			target_hr_zone: 1,
		},
		{
			name: "Warm-up",
			duration_secs: scaled(120, scale),
			target_description: "100m pull with buoy",
			target_hr_zone: 1,
		},
	];
}

/** 400m warm-up: 4 × 100m (free, kick, pull, drill/swim) — used by long. */
function swimWarmUp400(scale: number): WorkoutSegment[] {
	return [
		...swimWarmUp300(scale),
		{
			name: "Warm-up",
			duration_secs: scaled(120, scale),
			target_description: "100m drill/swim choice",
			target_hr_zone: 1,
		},
	];
}

function buildSwimRecovery(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, paceBufferSecs, hrOnly } = ctx;
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(240, scale),
			target_description: swimPaceDesc(settings, 20, "200m easy free, Z1", paceBufferSecs, hrOnly),
			target_hr_zone: 1,
		},
		{
			name: "Drill set",
			duration_secs: scaled(480, scale),
			target_description: "50m drill/swim on :15 rest",
			target_hr_zone: 1,
			repeats: 4,
			work_duration_secs: scaled(105, scale),
			rest_duration_secs: 15,
		},
		{
			name: "Main set",
			duration_secs: scaled(480, scale),
			target_description: swimPaceDesc(settings, 18, "400m pull Z1", paceBufferSecs, hrOnly),
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

function buildSwimBase(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, paceBufferSecs, hrOnly } = ctx;
	const reps = Math.max(4, Math.round(6 * scale));
	return [
		...swimWarmUp300(scale),
		{
			name: "Main set",
			duration_secs: scaled(reps * 270, scale),
			target_description: swimPaceDesc(settings, 10, "200m Z2 on :20 rest", paceBufferSecs, hrOnly),
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

function buildSwimTempo(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, paceBufferSecs, hrOnly } = ctx;
	return [
		...swimWarmUp300(scale),
		{
			name: "Threshold set",
			duration_secs: scaled(4 * 270, scale),
			target_description: swimPaceDesc(
				settings,
				0,
				"200m Z3 descending on :30 rest",
				paceBufferSecs,
				hrOnly,
			),
			target_hr_zone: 3,
			repeats: 4,
			work_duration_secs: scaled(240, scale),
			rest_duration_secs: 30,
		},
		{
			name: "Speed set",
			duration_secs: scaled(4 * 70, scale),
			target_description: swimPaceDesc(settings, -6, "50m Z4 on :20 rest", paceBufferSecs, hrOnly),
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

function buildSwimIntervals(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, paceBufferSecs, hrOnly } = ctx;
	return [
		...swimWarmUp300(scale),
		{
			name: "Main set",
			duration_secs: scaled(8 * 105, scale),
			target_description: swimPaceDesc(settings, -6, "100m Z4 on :15 rest", paceBufferSecs, hrOnly),
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
			target_description: "50m sprint on :30 rest",
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

function buildSwimLong(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, paceBufferSecs, hrOnly } = ctx;
	const mainMetres = Math.round(2500 * scale);
	const segments400 = Math.ceil(mainMetres / 400);
	return [
		...swimWarmUp400(scale),
		{
			name: "Main set",
			duration_secs: scaled(segments400 * 430, scale),
			target_description: swimPaceDesc(
				settings,
				10,
				"400m Z2 continuous with :10 rest between segments",
				paceBufferSecs,
				hrOnly,
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

const BUILDERS: Record<string, Record<WorkoutCategory, (ctx: BuildContext) => WorkoutSegment[]>> = {
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
	powerContext?: PowerContext,
	paceBufferSecs = 0,
	hrOnly = false,
): Omit<
	WorkoutSuggestion,
	| "sport_selection_reason"
	| "warnings"
	| "readiness_score"
	| "terrain"
	| "terrain_rationale"
	| "power_context"
> {
	const power: PowerContext = powerContext ?? {
		source: "none",
		ftp: 0,
		rolling_ftp: null,
		correction_factor: 1.0,
		confidence: "low",
		warnings: [],
	};

	const scale = durationScale(ctl);
	const ctx: BuildContext = { settings, scale, power, paceBufferSecs, hrOnly };
	const builder = BUILDERS[sport][category];
	const segments = builder(ctx);

	// Enforce minimum session duration — scale all segments up proportionally
	const rawTotal = segments.reduce((s, seg) => s + seg.duration_secs, 0);
	const minDuration = MIN_DURATION[category][sport];
	if (rawTotal > 0 && rawTotal < minDuration) {
		const uplift = minDuration / rawTotal;
		for (const seg of segments) {
			seg.duration_secs = Math.round(seg.duration_secs * uplift);
		}
	}

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
