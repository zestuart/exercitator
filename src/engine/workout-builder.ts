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
	progression: 0.78,
	tempo: 0.9,
	threshold: 1.05,
	intervals: 1.2,
	long: 0.8,
};

/** Minimum total session duration in seconds per category × sport. */
const MIN_DURATION: Record<WorkoutCategory, { Run: number; Swim: number }> = {
	rest: { Run: 0, Swim: 0 },
	recovery: { Run: 1200, Swim: 1200 }, // 20 min
	base: { Run: 1500, Swim: 1500 }, // 25 min
	progression: { Run: 1800, Swim: 1800 }, // 30 min
	tempo: { Run: 1800, Swim: 1800 }, // 30 min
	threshold: { Run: 2400, Swim: 2400 }, // 40 min — sustained Z3 needs runway
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

	// Recovery: low end of Stryd Z1 Easy (65–75% CP). Sub-65% is walking
	// territory — if the prescription wants less than this, prescribe rest
	// instead. Cool-down step still drops to walk pace at the end.
	const z1Low = hasPower ? powerZone(power.ftp, 0.65, 0.75) : null;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 1.3 + paceBufferSecs / 1000
		: null;

	const mainDesc = hasPower
		? dualTargetDesc(
				`Stryd Z1 Easy ${z1Low?.low}–${z1Low?.high}W`,
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
			target_description: "Easy walk to gentle jog",
			target_hr_zone: 1,
			stryd_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: scaled(1350, scale),
			target_description: mainDesc,
			target_hr_zone: 1,
			stryd_zone: 1,
			...(z1Low && { target_power_low: z1Low.low, target_power_high: z1Low.high }),
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

	// Base endurance: full Stryd Z1 Easy (65–80% CP). Aligns with Stryd's
	// published Easy zone — start at 65%, settle at 75–78%, ceiling at 80%.
	const z1 = hasPower ? powerZone(power.ftp, 0.65, 0.8) : null;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 1.15 + paceBufferSecs / 1000
		: null;

	const mainDesc = hasPower
		? dualTargetDesc(
				`Stryd Z1 Easy ${z1?.low}–${z1?.high}W`,
				hrCapDesc(settings, 1),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)
		: paceWithBuffer && !hrOnly
			? `Steady easy, ${formatPace(paceWithBuffer, "km")} | ${hrZoneDesc(2)}`
			: `Steady ${hrZoneDesc(2)}`;

	return [
		{
			name: "Warm-up",
			duration_secs: scaled(600, scale),
			target_description: "Progressive walk to easy run",
			target_hr_zone: 1,
			stryd_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: scaled(2100, scale),
			target_description: mainDesc,
			target_hr_zone: 2,
			stryd_zone: 1,
			...(z1 && { target_power_low: z1.low, target_power_high: z1.high }),
		},
		{
			name: "Cool-down",
			duration_secs: scaled(300, scale),
			target_description: "Easy jog to walk",
			target_hr_zone: 1,
		},
	];
}

function buildRunProgression(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, power, paceBufferSecs, hrOnly } = ctx;
	const hasPower = !hrOnly && power.source !== "none" && power.ftp > 0;

	// Progression run: thirds split. Each third climbs through a sub-band of
	// Stryd's Z1/Z2:
	//   1st  65–72% CP — easy start
	//   2nd  72–80% CP — comfortable
	//   3rd  80–87% CP — building (low Stryd Z2 Moderate, sweet-spot floor)
	const t1 = hasPower ? powerZone(power.ftp, 0.65, 0.72) : null;
	const t2 = hasPower ? powerZone(power.ftp, 0.72, 0.8) : null;
	const t3 = hasPower ? powerZone(power.ftp, 0.8, 0.87) : null;

	const pacePerKm = settings.threshold_pace
		? settings.threshold_pace + paceBufferSecs / 1000
		: null;

	function thirdDesc(
		zone: { low: number; high: number } | null,
		paceMul: number,
		zoneLabel: string,
	): string {
		const paceTarget = pacePerKm ? pacePerKm * paceMul : null;
		if (hasPower && zone) {
			return dualTargetDesc(
				`${zoneLabel} ${zone.low}–${zone.high}W`,
				hrCapDesc(settings, 2),
				paceTarget ? formatPace(paceTarget, "km") : null,
			);
		}
		if (paceTarget && !hrOnly) return `${zoneLabel}, ${formatPace(paceTarget, "km")}`;
		return zoneLabel;
	}

	const thirdSecs = scaled(900, scale); // 15 min each third by default

	return [
		{
			name: "Warm-up",
			duration_secs: scaled(600, scale),
			target_description: "Progressive walk to easy run",
			target_hr_zone: 1,
			stryd_zone: 1,
		},
		{
			name: "Easy third",
			duration_secs: thirdSecs,
			target_description: thirdDesc(t1, 1.25, "Stryd Z1 Easy (low)"),
			target_hr_zone: 1,
			stryd_zone: 1,
			...(t1 && { target_power_low: t1.low, target_power_high: t1.high }),
		},
		{
			name: "Steady third",
			duration_secs: thirdSecs,
			target_description: thirdDesc(t2, 1.15, "Stryd Z1 Easy (high)"),
			target_hr_zone: 2,
			stryd_zone: 1,
			...(t2 && { target_power_low: t2.low, target_power_high: t2.high }),
		},
		{
			name: "Building third",
			duration_secs: thirdSecs,
			target_description: thirdDesc(t3, 1.08, "Stryd Z2 Moderate (low)"),
			target_hr_zone: 3,
			stryd_zone: 2,
			...(t3 && { target_power_low: t3.low, target_power_high: t3.high }),
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

	// Tempo / sweet-spot: Stryd Z2 Moderate (80–90% CP). Stryd calls this
	// "Extensive Threshold Stimulus" — sustained sub-LT work. 2×10 min with
	// 3 min easy recovery between is the classic structure.
	const z2 = hasPower ? powerZone(power.ftp, 0.8, 0.9) : null;

	const reps = 2;
	const workSecs = scaled(600, scale);
	const restSecs = 180;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 1.05 + paceBufferSecs / 1000
		: null;

	const workDesc = hasPower
		? dualTargetDesc(
				`Stryd Z2 Moderate ${z2?.low}–${z2?.high}W`,
				hrCapDesc(settings, 2),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)
		: paceWithBuffer && !hrOnly
			? `Sweet-spot ${formatPace(paceWithBuffer, "km")} | ${hrZoneDesc(3)}`
			: hrZoneDesc(3);

	return [
		{
			name: "Warm-up",
			duration_secs: scaled(600, scale),
			target_description: "Progressive build through Stryd Z1 Easy",
			target_hr_zone: 2,
			stryd_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: reps * (workSecs + restSecs),
			target_description: `${Math.round(workSecs / 60)}min ${workDesc} / 3min Stryd Z1 Easy recovery`,
			target_hr_zone: 3,
			stryd_zone: 2,
			...(z2 && { target_power_low: z2.low, target_power_high: z2.high }),
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

function buildRunThreshold(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, power, paceBufferSecs, hrOnly } = ctx;
	const hasPower = !hrOnly && power.source !== "none" && power.ftp > 0;

	// Threshold: Stryd Z3 Threshold (90–100% CP). Stryd calls this
	// "Intensive Threshold Stimulus" — sustained at LT. 3×15 min with
	// 3 min recovery; the longer reps demand a real warm-up.
	const z3 = hasPower ? powerZone(power.ftp, 0.9, 1.0) : null;

	const reps = 3;
	const workSecs = scaled(900, scale);
	const restSecs = 180;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 0.97 + paceBufferSecs / 1000
		: null;

	const workDesc = hasPower
		? dualTargetDesc(
				`Stryd Z3 Threshold ${z3?.low}–${z3?.high}W`,
				hrCapDesc(settings, 3),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)
		: paceWithBuffer && !hrOnly
			? `Threshold ${formatPace(paceWithBuffer, "km")} | ${hrZoneDesc(4)}`
			: hrZoneDesc(4);

	return [
		{
			name: "Warm-up",
			duration_secs: scaled(900, scale),
			target_description: "Progressive build through Stryd Z1 Easy → Z2 Moderate",
			target_hr_zone: 2,
			stryd_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: reps * (workSecs + restSecs),
			target_description: `${Math.round(workSecs / 60)}min ${workDesc} / 3min Stryd Z1 Easy recovery`,
			target_hr_zone: 4,
			stryd_zone: 3,
			...(z3 && { target_power_low: z3.low, target_power_high: z3.high }),
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

function buildRunIntervals(ctx: BuildContext): WorkoutSegment[] {
	const { settings, scale, power, paceBufferSecs, hrOnly } = ctx;
	const hasPower = !hrOnly && power.source !== "none" && power.ftp > 0;

	// Intervals / VO2max: Stryd Z4 Interval (100–115% CP). 5+ × 2:30 with
	// 2 min Z1 Easy jog recovery is the bread-and-butter VO2max session.
	const z4 = hasPower ? powerZone(power.ftp, 1.0, 1.15) : null;

	const reps = Math.max(5, Math.round(7 * scale));
	const workSecs = 150;
	const restSecs = 120;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 0.9 + paceBufferSecs / 1000
		: null;

	const workDesc = hasPower
		? dualTargetDesc(
				`Stryd Z4 Interval ${z4?.low}–${z4?.high}W`,
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
			target_description: "Progressive build through Stryd Z1 Easy → Z2 Moderate",
			target_hr_zone: 2,
			stryd_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: reps * (workSecs + restSecs),
			target_description: `2.5min ${workDesc} / 2min Stryd Z1 Easy jog`,
			target_hr_zone: 4,
			stryd_zone: 4,
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

	// Long: full Stryd Z1 Easy (65–80% CP) sustained, with optional 10 min
	// Stryd Z2 Moderate pickup near the end. Duration is the stimulus, not
	// intensity — keep it conversational.
	const z1 = hasPower ? powerZone(power.ftp, 0.65, 0.8) : null;

	const paceWithBuffer = settings.threshold_pace
		? settings.threshold_pace * 1.15 + paceBufferSecs / 1000
		: null;

	const mainSecs = scaled(4200, scale);
	const mainDesc = hasPower
		? `${dualTargetDesc(
				`Stryd Z1 Easy ${z1?.low}–${z1?.high}W`,
				hrCapDesc(settings, 1),
				paceWithBuffer ? formatPace(paceWithBuffer, "km") : null,
			)} with optional 10min Stryd Z2 Moderate pickup`
		: paceWithBuffer && !hrOnly
			? `Steady easy, ${formatPace(paceWithBuffer, "km")} with optional 10min Z2 pickup`
			: `Steady ${hrZoneDesc(2)} with optional Z3 pickup`;

	return [
		{
			name: "Warm-up",
			duration_secs: scaled(600, scale),
			target_description: "Progressive warm-up",
			target_hr_zone: 1,
			stryd_zone: 1,
		},
		{
			name: "Main set",
			duration_secs: mainSecs,
			target_description: mainDesc,
			target_hr_zone: 2,
			stryd_zone: 1,
			...(z1 && { target_power_low: z1.low, target_power_high: z1.high }),
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
 * Build swim pace description. intervals.icu stores threshold_pace in metres
 * per second (matching activity.average_speed and pace_zones percent-of-speed
 * semantics). Convert to seconds per 100 m via 100/x, then apply zone offset
 * and staleness buffer, format as mm:ss/100m. When hrOnly is true, pace
 * targets are suppressed.
 */
function swimPaceDesc(
	settings: SportSettings,
	zoneOffsetSecs: number,
	label: string,
	paceBufferSecs = 0,
	hrOnly = false,
): string {
	if (hrOnly) return label;
	if (settings.threshold_pace && settings.threshold_pace > 0) {
		const cssPer100m = 100 / settings.threshold_pace;
		const pace = cssPer100m + zoneOffsetSecs + paceBufferSecs;
		return `${label} ${formatPace(pace, "100m")}`;
	}
	return label;
}

/** 300m warm-up: 3 × 100m (free, kick, pull) with 10s rest between drills. */
function swimWarmUp300(scale: number): WorkoutSegment[] {
	return [
		{
			name: "Warm-up",
			duration_secs: scaled(130, scale),
			target_description: "100m easy free",
			target_hr_zone: 1,
			rest_duration_secs: 10,
		},
		{
			name: "Warm-up",
			duration_secs: scaled(130, scale),
			target_description: "100m kick with board",
			target_hr_zone: 1,
			rest_duration_secs: 10,
		},
		{
			name: "Warm-up",
			duration_secs: scaled(120, scale),
			target_description: "100m pull with buoy",
			target_hr_zone: 1,
			rest_duration_secs: 20,
		},
	];
}

/** 400m warm-up: 4 × 100m (free, kick, pull, drill/swim) with 10s rest between drills. */
function swimWarmUp400(scale: number): WorkoutSegment[] {
	const drills = swimWarmUp300(scale);
	// Override pull rest back to 10s (between drills, not end-of-warmup)
	drills[drills.length - 1].rest_duration_secs = 10;
	return [
		...drills,
		{
			name: "Warm-up",
			duration_secs: scaled(120, scale),
			target_description: "100m drill/swim choice",
			target_hr_zone: 1,
			rest_duration_secs: 20,
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
			rest_duration_secs: 20,
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
			// Note: rest_duration_secs serves double duty here — it's the rest between
			// repeats AND the rest after the last rep before cool-down.
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
			rest_duration_secs: 20,
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
		progression: buildRunProgression,
		tempo: buildRunTempo,
		threshold: buildRunThreshold,
		intervals: buildRunIntervals,
		long: buildRunLong,
	},
	Swim: {
		rest: () => [],
		recovery: buildSwimRecovery,
		base: buildSwimBase,
		// Swim doesn't have power-based zones, so progression / threshold map
		// onto the existing structures: progression → base (longer warm-up
		// build), threshold → tempo. Swim is unaffected by the Stryd zone
		// re-mapping.
		progression: buildSwimBase,
		tempo: buildSwimTempo,
		threshold: buildSwimTempo,
		intervals: buildSwimIntervals,
		long: buildSwimLong,
	},
};

const TITLES: Record<WorkoutCategory, Record<string, string>> = {
	rest: { Run: "Rest Day", Swim: "Rest Day" },
	recovery: { Run: "Recovery Run", Swim: "Recovery Swim" },
	base: { Run: "Easy Base Run", Swim: "Endurance Swim" },
	progression: { Run: "Progression Run", Swim: "Endurance Swim" },
	tempo: { Run: "Sweet-spot Tempo Run", Swim: "Threshold Swim" },
	threshold: { Run: "Threshold Run", Swim: "Threshold Swim" },
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

function buildRationale(category: WorkoutCategory, _readiness: number, sport: string): string {
	const isRun = sport === "Run";
	switch (category) {
		case "rest":
			return "Full rest is recommended to allow recovery.";
		case "recovery":
			return `A gentle ${sport.toLowerCase()} session to promote blood flow without adding fatigue.`;
		case "base":
			return `Building aerobic base with steady-state ${sport.toLowerCase()}.`;
		case "progression":
			return isRun
				? "Aerobic build that climbs through Stryd Z1 Easy into low Z2 Moderate over thirds — endurance work with a productive sting at the end."
				: "Aerobic build that progresses from easy to moderate effort over the session.";
		case "tempo":
			return isRun
				? "Sweet-spot tempo (Stryd Z2 Moderate) — sub-LT sustained work to lift threshold without the cost of true threshold."
				: "Threshold-paced sets to lift lactate clearance and pace tolerance.";
		case "threshold":
			return isRun
				? "Threshold intervals at Stryd Z3 (Intensive Threshold Stimulus) — sustained 15-min reps at lactate threshold."
				: "Sustained threshold sets at lactate threshold.";
		case "intervals":
			return isRun
				? "High-intensity intervals at Stryd Z4 to build VO2max and running economy."
				: "High-intensity intervals to build VO2max and speed.";
		case "long":
			return `No long session this week. Extended ${sport.toLowerCase()} for endurance.`;
	}
}
