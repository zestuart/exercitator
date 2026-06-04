/**
 * FORM Athletica recommendation mapper — pure bridge between Exercitator's
 * `WorkoutCategory` ladder and FORM's smart-coach personalised swim
 * suggestions.
 *
 * Three responsibilities (mirroring `src/engine/stryd-mapper.ts`):
 *
 *   1. `mapCategoryToFormType` — preferred FORM `type` discriminator
 *      (`Endurance | Power | Technique`) for a given category, or `null`
 *      to skip entirely (e.g. `rest`).
 *   2. `pickFormWorkout` — pick one of the 3 personalised candidates by
 *      content scoring (effort-level buckets per setGroup). NOT by FORM's
 *      `isRecommended` flag alone — that's a tiebreaker only.
 *   3. `formWorkoutToSegments` — flatten outer `roundsCount` loops while
 *      pre-collapsing intra-set `intervalsCount > 1 + defined rest`
 *      pairs into the existing swim segment shape (`repeats`,
 *      `work_duration_secs`, `rest_duration_secs`). Mirrors what
 *      `workout-builder.ts` emits so render + form-format + pair-collapse
 *      all keep working.
 *
 * No I/O. No async. The HTTP client lives in `src/form/client.ts`.
 *
 * Wire contract reference:
 *   ~/Documents/claude/retextor/notes/form-api/spec-recommendations.md
 */

import type {
	FormRecommendationSet,
	FormSet,
	FormSetGroup,
	FormWorkoutBody,
} from "../form/client.js";
import type { SportSettings, WorkoutCategory, WorkoutSegment } from "./types.js";

// ---------------------------------------------------------------------------
// (1) Category → preferred FORM type
// ---------------------------------------------------------------------------

/**
 * Map an Exercitator `WorkoutCategory` to the FORM workout `type` discriminator
 * we'd most like to see picked. The FORM `/personalized` endpoint doesn't
 * accept query parameters — it always returns 3 candidates (Endurance, Power,
 * Technique typically) — so this just biases the pick. `null` means the
 * swap is skipped entirely for this category.
 *
 * Vocabulary observed: `Endurance | Power | Technique`. `Speed | Recovery`
 * plausibly exist but unverified — the picker scores by content so missing
 * type names degrade gracefully.
 */
export function mapCategoryToFormType(
	category: WorkoutCategory,
): "Endurance" | "Power" | "Technique" | null {
	switch (category) {
		case "rest":
			return null;
		case "recovery":
			// Lowest-intensity option in the standard 3-tile mix.
			return "Technique";
		case "base":
		case "progression":
		case "tempo":
		case "long":
			return "Endurance";
		case "threshold":
		case "intervals":
			return "Power";
	}
}

// ---------------------------------------------------------------------------
// (2) Effort-level vocabulary maps
// ---------------------------------------------------------------------------

/**
 * CSS-relative pace offset (seconds per 100 m). Positive = slower than CSS,
 * negative = faster. Heuristic starting table; calibrate against execution
 * history once a few FORM-sourced sessions land.
 *
 * Ranking (slowest → fastest): easy < moderate < build < strong < fast/hard
 * < sprint. Drill segments override to easy regardless of level.
 */
const EFFORT_PACE_OFFSET: Record<string, number> = {
	easy: 20,
	moderate: 5,
	build: -2,
	strong: -8,
	fast: -15,
	hard: -10,
	sprint: -25,
};

/** HR zone (1–5) per effort level — used for `target_hr_zone`. */
const EFFORT_HR_ZONE: Record<string, 1 | 2 | 3 | 4 | 5> = {
	easy: 1,
	moderate: 2,
	build: 3,
	strong: 3,
	fast: 4,
	hard: 4,
	sprint: 5,
};

/** Z1–Z5 bucket for an effort level — used by the picker's content scoring. */
const EFFORT_ZONE_BUCKET: Record<string, 0 | 1 | 2 | 3 | 4> = {
	easy: 0, // Z1
	moderate: 1, // Z2
	build: 2, // Z3
	strong: 2, // Z3
	fast: 3, // Z4
	hard: 3, // Z4
	sprint: 4, // Z5
};

/** Defaults for an unknown effort level — moderate-equivalent + warning log. */
const DEFAULT_PACE_OFFSET = 5;
const DEFAULT_HR_ZONE = 2 as const;
const DEFAULT_ZONE_BUCKET = 1 as const; // Z2

function lookupPaceOffset(level: string): number {
	const v = EFFORT_PACE_OFFSET[level];
	if (v === undefined) {
		console.warn(`form-mapper: unknown effort.level '${level}' — defaulting to moderate`);
		return DEFAULT_PACE_OFFSET;
	}
	return v;
}

function lookupHrZone(level: string): 1 | 2 | 3 | 4 | 5 {
	return EFFORT_HR_ZONE[level] ?? DEFAULT_HR_ZONE;
}

function lookupZoneBucket(level: string): 0 | 1 | 2 | 3 | 4 {
	return EFFORT_ZONE_BUCKET[level] ?? DEFAULT_ZONE_BUCKET;
}

// ---------------------------------------------------------------------------
// (3) Pick scoring
// ---------------------------------------------------------------------------

/** Per-Z bucket seconds for one workout body. */
type ZoneSeconds = [number, number, number, number, number];

/** Estimate seconds for a single set including its intervalsCount × interval distance
 *  plus rest, at the CSS-relative pace implied by `set.effort.level`. */
function estimateSetSecs(set: FormSet, css_m_per_s: number): number {
	if (!Number.isFinite(css_m_per_s) || css_m_per_s <= 0) return 0;

	// Drill segments swim at easy pace regardless of declared level.
	const level = set.strokeType === "drill" ? "easy" : (set.effort?.level ?? "moderate");
	const offset = lookupPaceOffset(level);
	const cssSecsPer100m = 100 / css_m_per_s;
	const paceSecsPer100m = cssSecsPer100m + offset;
	const swimSecs = (paceSecsPer100m * set.intervalDistance) / 100;

	const intervals = Math.max(0, set.intervalsCount | 0);
	const restSecs = set.rest?.defined ?? 0;
	return intervals * swimSecs + Math.max(0, intervals - 1) * restSecs;
}

/** Accumulate per-zone seconds across the full workout body. */
function bodyZoneSeconds(body: FormWorkoutBody, css_m_per_s: number): ZoneSeconds {
	const zones: ZoneSeconds = [0, 0, 0, 0, 0];
	for (const group of body.setGroups) {
		const rounds = Math.max(1, group.roundsCount | 0);
		for (const set of group.sets) {
			// Drill bucket is always Z1 regardless of declared level (technique focus).
			const level = set.strokeType === "drill" ? "easy" : (set.effort?.level ?? "moderate");
			const bucket = lookupZoneBucket(level);
			const setSecs = estimateSetSecs(set, css_m_per_s);
			zones[bucket] += rounds * setSecs;
		}
	}
	return zones;
}

/** Category-weighted score over Z-bucket seconds. Bigger = better match. */
function categoryScore(category: WorkoutCategory, zones: ZoneSeconds): number {
	switch (category) {
		case "rest":
			return 0;
		case "recovery":
			// Prefer mostly Z1 (low Z2 OK) — penalise hard work.
			return zones[0] * 2 - (zones[3] + zones[4]) * 2;
		case "base":
		case "long":
			return zones[0] + zones[1];
		case "progression":
		case "tempo":
			return zones[1] + zones[2];
		case "threshold":
			return zones[2] + zones[3];
		case "intervals":
			return zones[3] + zones[4];
	}
}

/** Bonus weight for FORM's `isRecommended` pick — used as a tiebreaker. */
const RECOMMENDED_BONUS_SECS = 60;

/** Bonus for matching the preferred top-level `type` (mapCategoryToFormType). */
const PREFERRED_TYPE_BONUS_SECS = 30;

/** Score label per category for the rationale string. */
function scoreLabel(category: WorkoutCategory): string {
	switch (category) {
		case "tempo":
		case "progression":
			return "Z2+Z3";
		case "threshold":
			return "Z3+Z4";
		case "intervals":
			return "Z4+Z5";
		default:
			return "Z1+Z2";
	}
}

/**
 * Pick the best-matching personalised candidate for the given category.
 *
 * Scoring (bigger is better):
 *   1. Per-category zone-seconds weight (from `bodyZoneSeconds + categoryScore`).
 *   2. + RECOMMENDED_BONUS_SECS if FORM marked this candidate `isRecommended`.
 *   3. + PREFERRED_TYPE_BONUS_SECS if top-level `type` matches `mapCategoryToFormType`.
 *
 * Returns `null` for the rest category, or when no candidates remain after
 * scoring. The `rationale` string names the chosen workout, its primary
 * score, and (when present) the runner-up — same audit pattern as Stryd.
 *
 * Inputs:
 *   - `set`           — the recommendation list (3 metadata summaries)
 *   - `bodies`        — map of workout-id → FormWorkoutBody (for setGroups)
 *   - `css_m_per_s`   — user's CSS (`settings.threshold_pace`)
 */
export function pickFormWorkout(
	category: WorkoutCategory,
	set: FormRecommendationSet,
	bodies: Map<string, FormWorkoutBody>,
	css_m_per_s: number,
): { picked: FormWorkoutBody; rationale: string; isFallback: boolean } | null {
	if (category === "rest") return null;
	const candidates = set.workouts ?? [];
	if (candidates.length === 0) return null;

	const preferred = mapCategoryToFormType(category);

	const scored = candidates
		.map((rec, index) => {
			const body = bodies.get(rec.workout.id);
			if (!body) return null;
			const zones = bodyZoneSeconds(body, css_m_per_s);
			let score = categoryScore(category, zones);
			if (rec.isRecommended) score += RECOMMENDED_BONUS_SECS;
			if (preferred && rec.type === preferred) score += PREFERRED_TYPE_BONUS_SECS;
			return { rec, body, zones, score, index };
		})
		.filter((s): s is NonNullable<typeof s> => s !== null);

	if (scored.length === 0) return null;

	scored.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		return a.index - b.index;
	});

	const winner = scored[0];
	const runnerUp = scored.length > 1 ? scored[1] : null;
	const label = scoreLabel(category);
	const winnerTitle = winner.rec.workout.name;
	// "isFallback" semantic: did we pick something whose top-level type doesn't
	// match the preferred category mapping? The callsite uses this to decide
	// whether to render a soft amber chip or a green one.
	const isFallback = preferred !== null && winner.rec.type !== preferred;

	const rationale = runnerUp
		? `${category}: picked '${winnerTitle}' (score ${Math.round(winner.score)}, ${label}) ` +
			`over '${runnerUp.rec.workout.name}' (score ${Math.round(runnerUp.score)})`
		: `${category}: picked '${winnerTitle}' (score ${Math.round(winner.score)}, ${label})`;

	return { picked: winner.body, rationale, isFallback };
}

// ---------------------------------------------------------------------------
// (4) Workout → Exercitator WorkoutSegment[]
// ---------------------------------------------------------------------------

/** Defensive caps against compromised / malformed upstream responses.
 *  Real workouts top out around 8 rounds × 10 intervals per set; these caps
 *  bound flatten-explosion blast radius. */
const MAX_ROUNDS = 20;
const MAX_INTERVALS = 100;

function groupTypeToSegmentName(groupType: string): string {
	switch (groupType) {
		case "warmup":
			return "Warm-up";
		case "cooldown":
			return "Cool-down";
		case "preSet":
			// Neutral name — preSets can mix drill + freestyle sets, so
			// "Drill set" here would leak the "drill" token into
			// inferStroke and mis-classify the non-drill members.
			return "Pre-set";
		case "main":
			return "Main set";
		case "postSet":
			return "Post-set";
		default:
			return groupType;
	}
}

/** Capitalised effort label for `target_description` (e.g. "Easy", "Moderate"). */
function effortLabel(level: string): string {
	if (!level) return "Moderate";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Lowercase stroke descriptor used in `target_description`. */
function strokeDescriptor(set: FormSet): string {
	if (set.strokeType === "drill" && set.drill?.name) {
		// Lowercase + lowercase-hump-broken: "sixKickSwitch" → "six-kick-switch".
		const drillName = set.drill.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
		return `drill (${drillName})`;
	}
	if (set.strokeType === "freestyle") return "freestyle";
	if (set.strokeType === "choice") return "choice";
	return set.strokeType;
}

function paceSecsPer100m(level: string, css_m_per_s: number): number {
	const cssSecsPer100m = 100 / css_m_per_s;
	return cssSecsPer100m + lookupPaceOffset(level);
}

function paceBand(level: string, css_m_per_s: number): { low: number; high: number } {
	// ±2 s/100m band around the target — gives the user a reasonable window
	// without painting too narrow a stripe on the render layer.
	const target = paceSecsPer100m(level, css_m_per_s);
	return { low: Math.round(target - 2), high: Math.round(target + 2) };
}

function formatPace100m(secsPer100m: number): string {
	const mins = Math.floor(secsPer100m / 60);
	const secs = Math.round(secsPer100m - mins * 60);
	const ss = secs < 10 ? `0${secs}` : `${secs}`;
	return `${mins}:${ss}/100m`;
}

/** Build target_description string in the swim-builder idiom. */
function targetDescription(set: FormSet, css_m_per_s: number): string {
	const level = set.strokeType === "drill" ? "easy" : (set.effort?.level ?? "moderate");
	const stroke = strokeDescriptor(set);
	const effort = effortLabel(level);
	const pacePart =
		css_m_per_s > 0 && set.strokeType !== "drill"
			? ` ${formatPace100m(paceSecsPer100m(level, css_m_per_s))}`
			: "";
	const equip = set.equipment.length > 0 ? ` (${set.equipment.map((e) => e.type).join(", ")})` : "";
	return `${set.intervalDistance}m ${stroke}, ${effort}${pacePart}${equip}`;
}

/**
 * Emit one or more segments for a single FORM set. Pre-collapses
 * `intervalsCount > 1 + defined rest` into a `repeats`-encoded segment
 * (matches the existing swim builder shape). Other cases:
 *
 *   - intervalsCount == 1: emit one single segment.
 *   - intervalsCount > 1, no rest: emit one combined segment of total distance.
 *   - intervalsCount > 1, takeoff-based rest (rest.defined === null,
 *     rest.takeoff !== null): flatten — emit `intervalsCount` separate
 *     segments. Takeoff scheduling isn't representable on a flat
 *     WorkoutSegment so we fall back to lossless flatten.
 */
function setToSegments(
	setGroup: FormSetGroup,
	set: FormSet,
	css_m_per_s: number,
): WorkoutSegment[] {
	const intervals = Math.max(0, Math.min(set.intervalsCount | 0, MAX_INTERVALS));
	if (intervals === 0) return [];

	const level = set.strokeType === "drill" ? "easy" : (set.effort?.level ?? "moderate");
	const hrZone = lookupHrZone(level);
	const band = css_m_per_s > 0 ? paceBand(level, css_m_per_s) : null;
	const segName = groupTypeToSegmentName(setGroup.groupType);
	const swimSecs = (paceSecsPer100m(level, css_m_per_s) * set.intervalDistance) / 100;
	const restSecs = set.rest?.defined ?? null;
	const restIsDefined = restSecs !== null && restSecs > 0;
	const restIsTakeoff =
		set.rest !== null && set.rest?.takeoff !== null && set.rest?.defined === null;

	const baseSegment = (overrides: Partial<WorkoutSegment>): WorkoutSegment => ({
		name: segName,
		duration_secs: Math.round(swimSecs),
		target_description: targetDescription(set, css_m_per_s),
		target_hr_zone: hrZone,
		...(band ? { target_pace_secs_low: band.low, target_pace_secs_high: band.high } : {}),
		...overrides,
	});

	// Case 1: single interval — emit one segment.
	if (intervals === 1) return [baseSegment({})];

	// Case 2: multiple intervals, defined rest — pre-collapse as a pair.
	if (restIsDefined && restSecs !== null) {
		const totalSecs = intervals * Math.round(swimSecs) + (intervals - 1) * restSecs;
		return [
			baseSegment({
				duration_secs: totalSecs,
				repeats: intervals,
				work_duration_secs: Math.round(swimSecs),
				rest_duration_secs: restSecs,
			}),
		];
	}

	// Case 3: multiple intervals, takeoff-based rest — flatten lossy.
	if (restIsTakeoff) {
		return Array.from({ length: intervals }, () => baseSegment({}));
	}

	// Case 4: multiple intervals, no rest — combine into one continuous segment.
	const combinedDistance = intervals * set.intervalDistance;
	const combinedSecs = Math.round(swimSecs * intervals);
	const combinedDesc = targetDescription(
		{ ...set, intervalDistance: combinedDistance },
		css_m_per_s,
	);
	return [
		baseSegment({
			duration_secs: combinedSecs,
			target_description: combinedDesc,
		}),
	];
}

/**
 * Convert a FORM workout body into Exercitator's `WorkoutSegment[]`.
 *
 * `roundsCount` outer loops are flattened: a group with `roundsCount: 3`
 * and 4 sets produces (3 × 4) sets-worth of segments in order. Intra-set
 * pair-collapse is preserved so each "8× 25m drill on :15" round-iteration
 * stays as one repeats-encoded segment.
 *
 * Drill segments are coerced to easy effort (Z1) regardless of declared
 * level — drills are technique focus, not effort.
 */
export function formWorkoutToSegments(
	body: FormWorkoutBody,
	settings: SportSettings,
): WorkoutSegment[] {
	const css_m_per_s = settings.threshold_pace ?? 0;
	const segments: WorkoutSegment[] = [];

	for (const group of body.setGroups) {
		const rounds = Math.max(1, Math.min(group.roundsCount | 0, MAX_ROUNDS));
		for (let r = 0; r < rounds; r++) {
			for (const set of group.sets) {
				segments.push(...setToSegments(group, set, css_m_per_s));
			}
		}
	}

	return segments;
}
