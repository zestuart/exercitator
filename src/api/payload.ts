/**
 * Engine → wire DTO mappers.
 *
 * Keeping transforms in one file lets the wire contract evolve independently
 * of the engine's internal types.
 */

import { groupPairSegments } from "../engine/segment-groups.js";
import type {
	ActivitySummary,
	NightlyHealth,
	PowerContext,
	WellnessRecord,
	WorkoutSegment,
	WorkoutSuggestion,
} from "../engine/types.js";
import type { VigilResult } from "../engine/vigil/index.js";
import type { VigilAlert, VigilFlag } from "../engine/vigil/types.js";
import type {
	ApiSegment,
	CriticalPowerBlock,
	CriticalPowerSource,
	InjuryWarningBlock,
	LastWorkoutBlock,
	ReadinessAdvisory,
	ReadinessBlock,
	ReadinessTier,
	SegmentTarget,
	SuggestedWorkoutBody,
	TrainingLoadBlock,
} from "./types.js";

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/** Most recent element's accessor value that is non-null, scanning from the end. */
function lastNonNull<T>(items: T[], get: (item: T) => number | null): number | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const v = get(items[i]);
		if (v != null) return v;
	}
	return null;
}

function tierForScore(score: number | null): ReadinessTier {
	if (score === null) return "unknown";
	if (score >= 60) return "ready";
	if (score >= 30) return "caution";
	return "recover";
}

function advisoryForTier(tier: ReadinessTier): ReadinessAdvisory {
	switch (tier) {
		case "ready":
			return "green";
		case "caution":
			return "amber";
		case "recover":
			return "red";
		case "unknown":
			return "grey";
	}
}

export function readinessFromEngine(
	score: number,
	wellness: WellnessRecord[],
	hasEnoughData: boolean,
	health?: NightlyHealth[],
): ReadinessBlock {
	const maybeScore = hasEnoughData ? score : null;
	const tier = tierForScore(maybeScore);
	const latest = wellness.length > 0 ? wellness[wellness.length - 1] : undefined;

	// HRV + Sleep component badges must follow the same source as the readiness
	// score: WHOOP telemetry for `promus-whoop` users (non-empty `health`), else
	// intervals.icu wellness. Without this the score reflects WHOOP while the
	// badges read the (now-null) intervals fields and show "unknown" — the
	// Nunc/Excubitor mismatch surfaced 2026-06-03.
	const useHealth = health != null && health.length > 0;
	const latestHealthHrv = useHealth ? lastNonNull(health, (h) => h.hrvRmssd) : null;
	const latestHealthSleepSecs = useHealth ? lastNonNull(health, (h) => h.sleepSecs) : null;

	const hrvValue = useHealth ? latestHealthHrv : (latest?.hrv ?? null);
	const hrvStatus = hrvValue == null ? "unknown" : hrvValue < 40 ? "low" : "ok";

	const sleepStatus = useHealth
		? latestHealthSleepSecs == null
			? "unknown"
			: latestHealthSleepSecs < 6 * 3600
				? "low"
				: "ok"
		: latest?.sleepScore != null
			? latest.sleepScore < 60
				? "low"
				: "ok"
			: latest?.sleepSecs != null
				? latest.sleepSecs < 6 * 3600
					? "low"
					: "ok"
				: "unknown";
	// soreness/fatigue are intervals.icu's 1–4 dropdown (low=1, avg=2, high=3, extreme=4);
	// flag "low" at high/extreme (>= 3), not the old 0–10 assumption (>= 6, unreachable).
	const sorenessStatus = latest?.soreness == null ? "unknown" : latest.soreness >= 3 ? "low" : "ok";
	const fatigueStatus = latest?.fatigue == null ? "unknown" : latest.fatigue >= 3 ? "low" : "ok";

	return {
		score: maybeScore,
		tier,
		advisory: advisoryForTier(tier),
		components: {
			hrv: hrvStatus,
			sleep: sleepStatus,
			soreness: sorenessStatus,
			fatigue: fatigueStatus,
		},
	};
}

// ---------------------------------------------------------------------------
// Injury warning (Vigil)
// ---------------------------------------------------------------------------

function vigilFlagFromEngine(flag: VigilFlag): InjuryWarningBlock["flags"][number] {
	return {
		metric: flag.metric,
		z_score: flag.zScore,
		weight: flag.weight,
		value_7d: flag.value7d,
		value_30d: flag.value30d,
	};
}

export function injuryWarningFromVigil(result: VigilResult | null): InjuryWarningBlock {
	if (!result) {
		return { severity: 0, status: "inactive", summary: null, flags: [] };
	}
	return {
		severity: result.alert.severity,
		status: result.status,
		summary: result.alert.summary,
		flags: result.alert.flags.map(vigilFlagFromEngine),
	};
}

export function injuryWarningFromAlertOnly(alert: VigilAlert | null): InjuryWarningBlock | null {
	if (!alert || alert.severity === 0) return null;
	return {
		severity: alert.severity,
		status: "active",
		summary: alert.summary,
		flags: alert.flags.map(vigilFlagFromEngine),
	};
}

// ---------------------------------------------------------------------------
// Critical power
// ---------------------------------------------------------------------------

/**
 * Map the engine's bare PowerSource ("stryd" | "garmin" | "none") onto the
 * spec wire enum. The single signal that distinguishes stryd_direct from
 * stryd_intervals is whether a CP value was fetched from the Stryd API
 * (typically via getLatestCriticalPower()) — i.e. `strydCpProvided=true`.
 *
 * Used by both critical_power.source and suggestion.power_context.source so
 * the two never disagree (issue #25).
 */
export function mapWirePowerSource(
	engineSource: PowerContext["source"],
	strydCpProvided: boolean,
): CriticalPowerSource {
	if (strydCpProvided) return "stryd_direct";
	if (engineSource === "stryd") return "stryd_intervals";
	if (engineSource === "garmin") return "intervals_inferred";
	return "none";
}

export function criticalPowerFromContext(
	powerContext: PowerContext,
	strydCp: number | null,
	strydCpUpdatedAt: string | null,
): CriticalPowerBlock {
	// `watts` is the authoritative critical-power figure for the wire.
	// Stryd CP wins when present, full stop — `/status` and `/dashboard`
	// build their `powerContext` directly from `detectPowerSource()` and
	// never route through `suggestWorkoutFromData`'s engine-level override,
	// so the function itself must enforce the precedence (regression of
	// #31, fixed in #32). Fall through to `powerContext.ftp` (intervals.icu
	// rolling FTP) only when no Stryd CP is available.
	const chosenFtp = strydCp ?? (powerContext.ftp > 0 ? powerContext.ftp : null);
	return {
		watts: chosenFtp != null ? Math.round(chosenFtp) : null,
		source: mapWirePowerSource(powerContext.source, strydCp != null),
		updated_at: strydCpUpdatedAt,
		confidence: powerContext.confidence === "high" ? "high" : "low",
	};
}

// ---------------------------------------------------------------------------
// Training load
// ---------------------------------------------------------------------------

export function trainingLoadFromActivities(
	wellness: WellnessRecord[],
	activities: ActivitySummary[],
	now: Date = new Date(),
): TrainingLoadBlock {
	const latest = wellness.length > 0 ? wellness[wellness.length - 1] : null;
	const ctl = latest?.ctl ?? null;
	const atl = latest?.atl ?? null;
	const tsb = ctl != null && atl != null ? ctl - atl : null;

	const sevenDaysAgo = now.getTime() - 7 * 86_400_000;
	const weeklyTss = activities
		.filter((a) => new Date(a.start_date_local).getTime() >= sevenDaysAgo)
		.reduce((sum, a) => sum + (a.icu_training_load ?? 0), 0);

	// Trend: compare latest CTL vs CTL 7 days ago
	let trend_7d: "rising" | "flat" | "falling" | null = null;
	const withCtl = wellness.filter((w) => w.ctl != null);
	if (withCtl.length >= 2 && ctl != null) {
		const earliest = withCtl[0].ctl as number;
		const delta = ctl - earliest;
		if (delta > 1.5) trend_7d = "rising";
		else if (delta < -1.5) trend_7d = "falling";
		else trend_7d = "flat";
	}

	return {
		fitness_ctl: ctl,
		fatigue_atl: atl,
		form_tsb: tsb,
		weekly_tss: weeklyTss > 0 ? Math.round(weeklyTss) : null,
		trend_7d,
	};
}

// ---------------------------------------------------------------------------
// Last workout
// ---------------------------------------------------------------------------

export function lastWorkoutFromActivities(activities: ActivitySummary[]): LastWorkoutBlock | null {
	if (activities.length === 0) return null;
	const latest = activities.reduce((best, a) =>
		a.start_date_local > best.start_date_local ? a : best,
	);
	// intervals.icu returns local-time strings like "2026-04-22T06:15:00"; treat as UTC for the wire.
	const startedAt = latest.start_date_local.endsWith("Z")
		? latest.start_date_local
		: `${latest.start_date_local}Z`;
	return {
		id: latest.id,
		started_at: startedAt,
		name: latest.type,
		type: latest.type,
		duration_s: latest.moving_time,
		tss: latest.icu_training_load ?? null,
		intensity_factor:
			latest.icu_intensity != null ? +(latest.icu_intensity / 100).toFixed(2) : null,
	};
}

// ---------------------------------------------------------------------------
// Workout segments — polymorphic target shape
// ---------------------------------------------------------------------------

type Stroke = "free" | "back" | "breast" | "fly" | "im" | "kick" | "drill" | "mixed";

function inferStroke(seg: WorkoutSegment): Stroke {
	const name = seg.name.toLowerCase();
	const desc = seg.target_description.toLowerCase();
	if (/back/.test(name) || /back/.test(desc)) return "back";
	if (/breast/.test(name) || /breast/.test(desc)) return "breast";
	if (/fly|butterfly/.test(name) || /fly|butterfly/.test(desc)) return "fly";
	if (/\bim\b|medley/.test(name) || /\bim\b|medley/.test(desc)) return "im";
	if (/kick/.test(name) || /kick/.test(desc)) return "kick";
	if (/drill/.test(name) || /drill/.test(desc)) return "drill";
	if (/free/.test(name) || /free/.test(desc)) return "free";
	return "mixed";
}

export function segmentToApi(seg: WorkoutSegment, sport: "Run" | "Swim"): ApiSegment {
	let target: SegmentTarget | null = null;

	if (sport === "Run" && seg.target_power_low != null && seg.target_power_high != null) {
		target = { kind: "power", low_w: seg.target_power_low, high_w: seg.target_power_high };
	} else if (
		sport === "Swim" &&
		seg.target_pace_secs_low != null &&
		seg.target_pace_secs_high != null
	) {
		target = {
			kind: "pace",
			stroke: inferStroke(seg),
			low_s_per_100m: seg.target_pace_secs_low,
			high_s_per_100m: seg.target_pace_secs_high,
		};
	} else if (seg.target_hr_zone != null) {
		target = { kind: "hr", zone: seg.target_hr_zone };
	}

	return {
		name: seg.name,
		duration_s: seg.duration_secs,
		target_description: seg.target_description,
		target,
		target_hr_zone: seg.target_hr_zone ?? null,
		...(seg.repeats != null && { repeats: seg.repeats }),
		...(seg.work_duration_secs != null && { work_duration_s: seg.work_duration_secs }),
		...(seg.rest_duration_secs != null && { rest_duration_s: seg.rest_duration_secs }),
	};
}

/**
 * Emit a pair-group (consecutive work+rest repeated N times) as a single
 * ApiSegment with both the work and rest targets populated. This mirrors
 * what Praescriptor's render shows for the same data — clients see one
 * "5× Work set" entry instead of 10 flat rows.
 *
 * Engine-built intervals also use the `repeats / work_duration_s /
 * rest_duration_s` shape (with rest implicit-easy), so API consumers
 * already handle this triple — the new `rest_target` / `rest_target_description`
 * are additive and unused by engine-built segments.
 */
function pairGroupToApi(
	group: {
		kind: "pair";
		work: WorkoutSegment;
		rest: WorkoutSegment;
		repeats: number;
	},
	sport: "Run" | "Swim",
): ApiSegment {
	const work = segmentToApi(group.work, sport);
	const rest = segmentToApi(group.rest, sport);
	const totalSecs = group.repeats * (group.work.duration_secs + group.rest.duration_secs);

	return {
		// "Work set" matches what Praescriptor shows for the same data.
		name: `${group.work.name} set`,
		duration_s: totalSecs,
		target_description: work.target_description,
		target: work.target,
		target_hr_zone: work.target_hr_zone,
		repeats: group.repeats,
		work_duration_s: group.work.duration_secs,
		rest_duration_s: group.rest.duration_secs,
		...(rest.target != null && { rest_target: rest.target }),
		...(rest.target_description && { rest_target_description: rest.target_description }),
	};
}

// ---------------------------------------------------------------------------
// WorkoutSuggestion → SuggestedWorkoutBody
// ---------------------------------------------------------------------------

export function suggestionToApi(
	s: WorkoutSuggestion,
	strydCpProvided = false,
): SuggestedWorkoutBody {
	return {
		sport: s.sport,
		category: s.category,
		title: s.title,
		rationale: s.rationale,
		total_duration_s: s.total_duration_secs,
		estimated_load: s.estimated_load,
		readiness_score: s.readiness_score,
		sport_selection_reason: s.sport_selection_reason,
		terrain: s.terrain,
		terrain_rationale: s.terrain_rationale,
		power_context: {
			source: mapWirePowerSource(s.power_context.source, strydCpProvided),
			ftp: s.power_context.ftp,
			confidence: s.power_context.confidence,
		},
		warnings: s.warnings,
		injury_warning: s.vigil
			? {
					severity: s.vigil.severity,
					status: s.vigil.status,
					summary: s.vigil.summary,
					flags: s.vigil.flags.map((f) => ({
						metric: f.metric,
						z_score: f.zScore,
						weight: f.weight,
						value_7d: f.value7d,
						value_30d: f.value30d,
					})),
				}
			: null,
		segments: groupPairSegments(s.segments).map((g) =>
			g.kind === "pair" ? pairGroupToApi(g, s.sport) : segmentToApi(g.seg, s.sport),
		),
		...(s.prescriptionSource && { prescription_source: s.prescriptionSource }),
		...(s.fallbackVendor && { fallback_vendor: s.fallbackVendor }),
		...(s.fallbackReason && { fallback_reason: s.fallbackReason }),
		...(s.strydWorkoutId !== undefined && { stryd_workout_id: s.strydWorkoutId }),
		...(s.strydWorkoutTitle && { stryd_workout_title: s.strydWorkoutTitle }),
		...(s.strydPickRationale && { stryd_pick_rationale: s.strydPickRationale }),
		...(s.formWorkoutId && { form_workout_id: s.formWorkoutId }),
		...(s.formWorkoutTitle && { form_workout_title: s.formWorkoutTitle }),
		...(s.formPickRationale && { form_pick_rationale: s.formPickRationale }),
	};
}
