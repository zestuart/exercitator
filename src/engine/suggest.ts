/**
 * Top-level orchestrator for the Daily Suggested Workout engine.
 *
 * Exports three layers:
 *   fetchTrainingData()            — shared data-fetching (4 API calls)
 *   suggestWorkoutForSport()       — full pipeline for a fixed sport
 *   suggestWorkout()               — auto-selects sport, then runs pipeline
 */

import { getVigilMetrics } from "../db.js";
import type { GarminClient } from "../garmin/client.js";
import type { IntervalsClient } from "../intervals.js";
import type { PromusClient } from "../promus/client.js";
import type { StrydClient } from "../stryd/client.js";
import {
	type CrossTrainingStrain,
	assessCrossTrainingStrain,
	findTodayCrossTraining,
	isCrossTraining,
} from "./cross-training-strain.js";
import { localDateStr } from "./date-utils.js";
import { detectPowerSource, resolveRunFtp } from "./power-source.js";
import { computeReadiness } from "./readiness.js";
import { selectSport } from "./sport-selector.js";
import { applyStaleness, computeStaleness } from "./staleness.js";
import { selectTerrain } from "./terrain-selector.js";
import type {
	ActivitySummary,
	NightlyHealth,
	PowerContext,
	RestMessage,
	SportSettings,
	VigilSummary,
	WellnessRecord,
	WorkoutSuggestion,
} from "./types.js";
import { runVigilPipeline } from "./vigil/index.js";
import { buildWorkout } from "./workout-builder.js";
import { selectWorkoutCategory } from "./workout-selector.js";

// Re-export for Praescriptor consumption
export type { VigilResult } from "./vigil/index.js";

/** Stryd Critical Power input for the engine. `ageDays` = null means unknown
 *  age. The engine treats Stryd CP as authoritative when present regardless
 *  of age — keeping CP fresh is the athlete's responsibility (book a CP test
 *  when fitness has materially shifted). `ageDays` is still surfaced on the
 *  HTTP API `critical_power.updated_at` and Praescriptor's data-source row so
 *  staleness is visible to the human in the loop. */
export interface StrydCpInput {
	cp: number;
	ageDays: number | null;
}

const DEFAULT_SPORT_SETTINGS: Omit<SportSettings, "type"> = {
	ftp: null,
	lthr: null,
	threshold_pace: null,
	hr_zones: null,
	pace_zones: null,
	power_zones: null,
};

// ---------------------------------------------------------------------------
// Shared data-fetching layer
// ---------------------------------------------------------------------------

export interface TrainingData {
	activities: ActivitySummary[];
	wellness: WellnessRecord[];
	runSettings: SportSettings;
	swimSettings: SportSettings;
	/**
	 * Overnight WHOOP health telemetry for `promus-whoop` users. Empty for
	 * users on the default intervals.icu wellness source — readiness then reads
	 * sleep/HRV from `wellness` as before.
	 */
	health: NightlyHealth[];
	/**
	 * Promus Vigor Vitae (in-house Body-Battery recovery, 0–100) at fetch time,
	 * and its categorical level. Best-effort: null for non-`promus-whoop` users
	 * or when the VV read failed. Drives the acute readiness component (it
	 * mean-reverts, so it is a now/last-night signal, not a trend signal).
	 */
	vigorVitae: number | null;
	vigorVitaeLevel: string | null;
	/**
	 * Set when a `promus-whoop` user's overnight telemetry could not be obtained
	 * (Promus unreachable/non-2xx, or no WHOOP night for today). When present,
	 * the engine returns a `health_unavailable` suggestion instead of prescribing
	 * from degraded readiness inputs.
	 */
	healthError?: { reason: string; message: string };
}

/**
 * Promus health-telemetry inputs for `fetchTrainingData`. Omitted (or with a
 * null client) for users on the default intervals.icu wellness source.
 */
export interface HealthFetchOptions {
	promusClient: PromusClient | null;
	whoopSerial: string | null;
	/**
	 * Effective (override-resolved) telemetry source — see `UserProfile.healthSource`.
	 * "auto" tries WHOOP then falls back to Garmin. Undefined keeps intervals wellness.
	 */
	healthSource?: "promus-whoop" | "garmin" | "auto";
	/** Garmin bridge client — built when the effective source is "garmin" or "auto". */
	garminClient?: GarminClient | null;
}

export async function fetchTrainingData(
	client: IntervalsClient,
	tz?: string,
	health?: HealthFetchOptions,
): Promise<TrainingData> {
	const now = new Date();
	const d14Ago = new Date(now.getTime() - 14 * 86_400_000);
	const d7Ago = new Date(now.getTime() - 7 * 86_400_000);

	const [activities, wellness, runSettings, swimSettings] = await Promise.all([
		client.get<ActivitySummary[]>(`/athlete/${client.athleteId}/activities`, {
			oldest: localDateStr(d14Ago, tz),
			newest: localDateStr(now, tz),
		}),
		client.get<WellnessRecord[]>(`/athlete/${client.athleteId}/wellness`, {
			oldest: localDateStr(d7Ago, tz),
			newest: localDateStr(now, tz),
		}),
		client
			.get<SportSettings>(`/athlete/${client.athleteId}/sport-settings/Run`)
			.catch((): SportSettings => ({ type: "Run", ...DEFAULT_SPORT_SETTINGS })),
		client
			.get<SportSettings>(`/athlete/${client.athleteId}/sport-settings/Swim`)
			.catch((): SportSettings => ({ type: "Swim", ...DEFAULT_SPORT_SETTINGS })),
	]);

	const healthResult = await fetchHealthTelemetry(now, tz, health);

	return {
		activities,
		wellness,
		runSettings,
		swimSettings,
		health: healthResult.health,
		vigorVitae: healthResult.vigorVitae,
		vigorVitaeLevel: healthResult.vigorVitaeLevel,
		healthError: healthResult.error,
	};
}

/** Overnight health telemetry feeding the readiness engine. `error` present =
 *  the source could not supply usable data (the engine then hard-fails or, in
 *  `auto` mode, falls back). `health: []` with no error = intervals wellness. */
export interface HealthTelemetry {
	health: NightlyHealth[];
	vigorVitae: number | null;
	vigorVitaeLevel: string | null;
	error?: { reason: string; message: string };
}

/**
 * Resolve overnight health telemetry for the effective `healthSource`:
 *   - undefined → intervals.icu wellness (no-op, `health: []`).
 *   - "promus-whoop" → WHOOP via Promus, hard-fail on a missing today-night.
 *   - "garmin" → Garmin Connect via the bridge, hard-fail when Garmin has no data.
 *   - "auto" → WHOOP primary; on any WHOOP error fall back to Garmin, and only
 *     surface an error when BOTH are unavailable. This is what lets a WHOOP
 *     strap hiatus degrade to Garmin instead of blocking every prescription.
 */
export async function fetchHealthTelemetry(
	now: Date,
	tz: string | undefined,
	opts: HealthFetchOptions | undefined,
): Promise<HealthTelemetry> {
	const source = opts?.healthSource;
	if (!opts || !source) {
		return { health: [], vigorVitae: null, vigorVitaeLevel: null };
	}
	if (source === "garmin") {
		return fetchGarminTelemetry(now, tz, opts);
	}
	if (source === "auto") {
		const whoop = await fetchWhoopTelemetry(now, tz, opts);
		if (!whoop.error) return whoop;
		if (!opts.garminClient) return whoop;
		const garmin = await fetchGarminTelemetry(now, tz, opts);
		if (!garmin.error) return garmin;
		// Both sources down — report the primary (WHOOP) error, noting the fallback.
		return {
			...whoop,
			error: {
				reason: whoop.error.reason,
				message: `${whoop.error.message} Garmin fallback also unavailable (${garmin.error.reason}).`,
			},
		};
	}
	return fetchWhoopTelemetry(now, tz, opts);
}

/**
 * WHOOP telemetry via Promus. Hard-fail policy (2026-06-03): a WHOOP night for
 * today's local wake date MUST be present; any transport/non-2xx error, or a
 * missing today-row, yields an `error`. We never fall back to intervals wellness
 * (the unreliable source we removed) — but the `auto` dispatcher above may fall
 * back to Garmin.
 */
async function fetchWhoopTelemetry(
	now: Date,
	tz: string | undefined,
	opts: HealthFetchOptions,
): Promise<HealthTelemetry> {
	const { promusClient, whoopSerial } = opts;
	if (!promusClient || !whoopSerial) {
		return {
			health: [],
			vigorVitae: null,
			vigorVitaeLevel: null,
			error: {
				reason: "promus_not_configured",
				message:
					"Health telemetry source is set to WHOOP but the Promus client or strap serial is not configured.",
			},
		};
	}

	const today = localDateStr(now, tz);
	const start = localDateStr(new Date(now.getTime() - 7 * 86_400_000), tz);

	let sleepRows: Awaited<ReturnType<PromusClient["getWhoopSleep"]>>;
	let hrvRows: Awaited<ReturnType<PromusClient["getWhoopHrvNightly"]>>;
	// Vigor Vitae is best-effort: fetched concurrently but its failure is NEVER
	// fatal (caught to null inline). A missing VV falls back to the sleep-duration
	// band for the acute readiness component — it must not block a prescription.
	let vigorVitae: number | null = null;
	let vigorVitaeLevel: string | null = null;
	try {
		const [core, vv] = await Promise.all([
			Promise.all([
				promusClient.getWhoopSleep(whoopSerial, start, today),
				promusClient.getWhoopHrvNightly(whoopSerial, 7),
			]),
			// `Promise.resolve().then(...)` so a *synchronous* throw (e.g. the
			// method missing on a stub) also becomes a rejection the .catch can
			// trap — VV must never disturb the core sleep/HRV result or its error.
			Promise.resolve()
				.then(() => promusClient.getVigorVitaeCurrent(whoopSerial))
				.catch((err) => {
					const m = err instanceof Error ? err.message : String(err);
					console.warn(`fetchWhoopTelemetry: Vigor Vitae unavailable (non-fatal): ${m}`);
					return null;
				}),
		]);
		[sleepRows, hrvRows] = core;
		if (vv) {
			vigorVitae = vv.value;
			vigorVitaeLevel = vv.level;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const reason = /\bHTTP (\d{3})\b/.test(msg)
			? `promus_http_${msg.match(/\bHTTP (\d{3})\b/)?.[1]}`
			: /timeout|abort|fetch|network/i.test(msg)
				? "promus_unreachable"
				: "promus_error";
		return {
			health: [],
			vigorVitae: null,
			vigorVitaeLevel: null,
			error: {
				reason,
				message: "Could not reach Promus to read last night's WHOOP telemetry.",
			},
		};
	}

	const health = mergeWhoopHealth(sleepRows, hrvRows);

	// Hard-fail unless today's night is present (and carries real sleep).
	const todayRow = health.find((h) => h.date === today);
	if (!todayRow || todayRow.sleepSecs == null) {
		return {
			health,
			vigorVitae,
			vigorVitaeLevel,
			error: {
				reason: "whoop_today_missing",
				message:
					"No WHOOP sleep for last night (strap data syncs via Nunc, not the WHOOP app). Wear the strap and let it sync, or switch the health source to Garmin.",
			},
		};
	}

	return { health, vigorVitae, vigorVitaeLevel };
}

/**
 * Garmin Connect telemetry via the garmin-bridge sidecar. Body Battery is the
 * acute signal AND the liveness gate (a live BB means the Garmin device is being
 * worn); a transport failure fetching it means Garmin is unavailable, and a null
 * value means no data. Sleep + overnight HRV are best-effort — a single missing
 * night must not block, because the readiness blend renormalises over present
 * components. Unlike WHOOP there is no "today's sleep must exist" hard-fail:
 * Garmin is the graceful fallback, and BB carries the acute reading regardless.
 */
async function fetchGarminTelemetry(
	now: Date,
	tz: string | undefined,
	opts: HealthFetchOptions,
): Promise<HealthTelemetry> {
	const garminClient = opts.garminClient;
	if (!garminClient) {
		return {
			health: [],
			vigorVitae: null,
			vigorVitaeLevel: null,
			error: {
				reason: "garmin_not_configured",
				message: "Health source is set to Garmin but the Garmin bridge client is not configured.",
			},
		};
	}

	const today = localDateStr(now, tz);
	const start = localDateStr(new Date(now.getTime() - 7 * 86_400_000), tz);

	let bb: Awaited<ReturnType<GarminClient["getBodyBatteryCurrent"]>>;
	try {
		bb = await garminClient.getBodyBatteryCurrent();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const reason = /reauth/i.test(msg)
			? "garmin_reauth_required"
			: /\bHTTP (\d{3})\b/.test(msg)
				? `garmin_http_${msg.match(/\bHTTP (\d{3})\b/)?.[1]}`
				: /timeout|abort|fetch|network/i.test(msg)
					? "garmin_unreachable"
					: "garmin_error";
		return {
			health: [],
			vigorVitae: null,
			vigorVitaeLevel: null,
			error: { reason, message: "Could not reach the Garmin bridge for recovery telemetry." },
		};
	}

	const [sleepRows, hrvRows] = await Promise.all([
		garminClient.getSleepNightly(start, today).catch(() => []),
		garminClient.getHrvNightly(7).catch(() => []),
	]);
	const health = mergeWhoopHealth(sleepRows, hrvRows);

	if (bb.value == null) {
		return {
			health,
			vigorVitae: null,
			vigorVitaeLevel: null,
			error: {
				reason: "garmin_no_data",
				message:
					"Garmin has no current Body Battery reading — wear the Garmin device and let it sync.",
			},
		};
	}

	return { health, vigorVitae: bb.value, vigorVitaeLevel: bb.level };
}

/**
 * Merge WHOOP sleep rows (`wake_date`) and nightly-HRV rows (`wake_day_utc`)
 * into a single per-date `NightlyHealth[]`, sorted ascending by date so the
 * readiness "most recent night is last" convention holds.
 */
export function mergeWhoopHealth(
	sleepRows: { wake_date: string; duration_s: number | null }[],
	hrvRows: { wake_day_utc: string; rmssd_median_ms: number | null }[],
): NightlyHealth[] {
	const byDate = new Map<string, NightlyHealth>();
	for (const s of sleepRows) {
		byDate.set(s.wake_date, {
			date: s.wake_date,
			sleepSecs: s.duration_s ?? null,
			hrvRmssd: null,
		});
	}
	for (const h of hrvRows) {
		const existing = byDate.get(h.wake_day_utc);
		if (existing) {
			existing.hrvRmssd = h.rmssd_median_ms ?? null;
		} else {
			byDate.set(h.wake_day_utc, {
				date: h.wake_day_utc,
				sleepSecs: null,
				hrvRmssd: h.rmssd_median_ms ?? null,
			});
		}
	}
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Stryd RPE augmentation
// ---------------------------------------------------------------------------

/**
 * Augment activities with Stryd RPE from vigil_metrics.
 * If an activity has no perceived_exertion but has a Stryd RPE ≥ 7,
 * set perceived_exertion to the Stryd RPE so isHardSession() detects it.
 */
function augmentStrydRpe(
	activities: ActivitySummary[],
	athleteId: string,
	now: Date,
	tz?: string,
): void {
	const d14Ago = localDateStr(new Date(now.getTime() - 14 * 86_400_000), tz);
	const newest = localDateStr(now, tz);

	let metrics: ReturnType<typeof getVigilMetrics>;
	try {
		metrics = getVigilMetrics(athleteId, "Run", d14Ago, newest);
	} catch {
		return; // DB not available (e.g. in tests without DB)
	}

	// Build a map from activity date → Stryd RPE for quick lookup
	const rpeByDate = new Map<string, number>();
	for (const m of metrics) {
		if (m.strydRpe != null && m.strydRpe >= 7) {
			rpeByDate.set(m.activityDate, m.strydRpe);
		}
	}

	for (const a of activities) {
		if (a.perceived_exertion != null) continue;
		const date = a.start_date_local.slice(0, 10);
		const strydRpe = rpeByDate.get(date);
		if (strydRpe != null) {
			a.perceived_exertion = strydRpe;
		}
	}
}

// ---------------------------------------------------------------------------
// Same-sport already-trained-today suppression
// ---------------------------------------------------------------------------

/**
 * Activity types that count as "the user already did Run today" / "Swim today".
 * Must stay in sync with the analogous lists in readiness.ts / sport-selector.ts /
 * staleness.ts / workout-selector.ts — there is no shared module yet.
 */
const RUN_TYPES_FOR_SUPPRESSION = ["Run", "VirtualRun", "TrailRun", "Treadmill"];
const SWIM_TYPES_FOR_SUPPRESSION = ["Swim", "OpenWaterSwim", "VirtualSwim"];

function findTodayActivityForSport(
	activities: ActivitySummary[],
	sport: "Run" | "Swim",
	now: Date,
	tz?: string,
): ActivitySummary | null {
	const today = localDateStr(now, tz);
	const types = sport === "Run" ? RUN_TYPES_FOR_SUPPRESSION : SWIM_TYPES_FOR_SUPPRESSION;
	for (const a of activities) {
		if (!types.includes(a.type)) continue;
		if (a.start_date_local.slice(0, 10) !== today) continue;
		return a;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Pipeline for a fixed sport
// ---------------------------------------------------------------------------

export function suggestWorkoutFromData(
	data: TrainingData,
	sport: "Run" | "Swim",
	now: Date = new Date(),
	sportSelectionReason?: string,
	strydCp?: StrydCpInput | null,
	athleteId = "0",
	tz?: string,
	powerSourceOverride?: "stryd" | "garmin" | null,
): WorkoutSuggestion {
	const { activities, wellness, runSettings, swimSettings } = data;

	// Resolve the run FTP from the effective power source. A manual Praescriptor
	// override (Auto/Stryd/Garmin) wins over the rolling-window auto-detection;
	// each source draws its FTP from where that value actually lives:
	//   - Garmin -> intervals.icu FTP (intervals derives it from Garmin power).
	//   - Stryd  -> the Stryd critical-power API (foot-pod authoritative, not
	//     intervals' NP-derived FTP, which caused engine/Praescriptor disagreement
	//     and issue #31; the athlete books a fresh CP test when fitness shifts).
	// No cross-scale approximation (the old / 0.87 Stryd->Garmin factor is gone).
	// Only running reads the FTP; swim carries the context but never uses it.
	const powerContext = resolveRunFtp(
		detectPowerSource(activities),
		powerSourceOverride ?? null,
		strydCp?.cp ?? null,
		activities,
	);

	// Health-telemetry hard-fail: a `promus-whoop` user whose overnight WHOOP
	// data is missing for today (or Promus is unreachable) gets no prescription.
	// Readiness here would be computed from degraded sleep/HRV inputs, so we
	// short-circuit before computeReadiness rather than after.
	if (data.healthError) {
		return {
			sport,
			category: "rest",
			title: "Health telemetry unavailable",
			rationale: data.healthError.message,
			total_duration_secs: 0,
			estimated_load: 0,
			segments: [],
			readiness_score: 0,
			sport_selection_reason: sportSelectionReason ?? `Forced: ${sport}`,
			terrain: "any",
			terrain_rationale: "Suppressed — health telemetry unavailable",
			power_context: powerContext,
			warnings: [data.healthError.message],
			status: "health_unavailable",
			healthUnavailableReason: data.healthError.reason,
			healthUnavailableMessage: data.healthError.message,
		};
	}

	// Whole-athlete readiness: no `sport` filter, so the recency component
	// reflects time since the LAST activity of ANY sport. This is a deliberate
	// multi-sport choice — a hard ride or swim should temper today's run
	// readiness (and the displayed number is identical across the Run/Swim
	// cards, Praescriptor header, and the HTTP API status/dashboard/suggested
	// blocks). The engine's category gating reads this same score.
	const readiness = computeReadiness(wellness, activities, now, {
		ftp: powerContext.ftp > 0 ? powerContext.ftp : undefined,
		health: data.health,
		vigorVitae: data.vigorVitae,
	});

	// Suppression short-circuit: if the user has already done the requested
	// sport today, skip the engine pipeline entirely (no Vigil, no category
	// resolution, no Stryd/FORM swap downstream). The renderer shows the
	// Quies card with a swap CTA instead of segments. Readiness is computed
	// above so the readiness panel still has its score.
	const trainedToday = findTodayActivityForSport(activities, sport, now, tz);
	if (trainedToday) {
		const otherSport: "Run" | "Swim" = sport === "Run" ? "Swim" : "Run";
		const otherTrained = findTodayActivityForSport(activities, otherSport, now, tz);
		const restMessage: RestMessage = {
			trainedSport: sport,
			trainedActivityId: trainedToday.id,
			trainedActivityType: trainedToday.type,
			trainedAt: trainedToday.start_date_local,
			alternateSport: otherTrained ? null : otherSport,
		};
		return {
			sport,
			category: "rest",
			title: `${sport} already complete today`,
			rationale:
				restMessage.alternateSport === null
					? "Both sports trained today — rest is the prescription."
					: `Already trained ${sport} today (${trainedToday.type}). Rest, or swap to ${restMessage.alternateSport}.`,
			total_duration_secs: 0,
			estimated_load: 0,
			segments: [],
			readiness_score: readiness.score,
			sport_selection_reason: sportSelectionReason ?? `Forced: ${sport}`,
			terrain: "any",
			terrain_rationale: "Suppressed — already trained today",
			power_context: powerContext,
			warnings: [],
			status: "already_trained",
			restMessage,
		};
	}

	const staleness = computeStaleness(activities, sport, now);

	// Vigil: biomechanical deviation alert (running sports only, requires Stryd metrics in DB)
	// Stryd stores all activities as sport="Run" regardless of intervals.icu classification,
	// so always query with "Run" for the Vigil pipeline.
	const isRunSport = ["Run", "VirtualRun", "TrailRun", "Treadmill"].includes(sport);
	const vigilResult = isRunSport ? runVigilPipeline(athleteId, "Run", now, tz) : null;

	// Stryd RPE as hard-session signal: augment perceived_exertion from Vigil metrics.
	// Only for running sports where we have Stryd data in the DB.
	if (isRunSport && athleteId !== "0") {
		augmentStrydRpe(activities, athleteId, now, tz);
	}

	// Cross-training strain assessment: assess today's weight/climbing activities.
	// Build strain map for all recent cross-training (for hard-session guard).
	const crossTrainingStrains = new Map<string, CrossTrainingStrain>();
	const crossTrainingActivities = activities.filter((a) => isCrossTraining(a.type));
	for (const ct of crossTrainingActivities) {
		// HRV stream would require an API call — skip tier 1 in the sync pipeline.
		// Tier 1 (HRV) is available via the async Praescriptor path.
		const strain = assessCrossTrainingStrain(ct, activities);
		crossTrainingStrains.set(ct.id, strain);
	}

	// Prescription gating: if any same-day cross-training has unknown strain, block.
	const todayCrossTraining = findTodayCrossTraining(activities, now, tz);
	for (const ct of todayCrossTraining) {
		const strain = crossTrainingStrains.get(ct.id);
		if (strain && strain.level === "unknown") {
			return {
				sport,
				category: "base",
				title: "Awaiting cross-training RPE",
				rationale: strain.summary,
				total_duration_secs: 0,
				estimated_load: 0,
				segments: [],
				readiness_score: readiness.score,
				sport_selection_reason: sportSelectionReason ?? `Forced: ${sport}`,
				terrain: "any",
				terrain_rationale: "Pending cross-training strain assessment",
				power_context: powerContext,
				warnings: [`Cross-training strain unknown: ${ct.type} (${ct.id})`],
				status: "awaiting_input",
				awaitingInput: {
					reason: "cross_training_rpe",
					activityId: ct.id,
					activityName: `${ct.type} ${ct.start_date_local.slice(0, 10)}`,
					activityType: ct.type,
					prompt: `Rate your ${ct.type.replace(/([A-Z])/g, " $1").trim()} session (1–10 RPE):`,
				},
			};
		}
	}

	const readinessCategory = selectWorkoutCategory(
		readiness.score,
		activities,
		sport,
		now,
		powerContext,
		vigilResult?.alert,
		crossTrainingStrains,
		tz,
		readiness.components.hrv,
		readiness.sleepDebt,
	);
	const category = applyStaleness(readinessCategory, staleness.tier);

	const terrainSelection = selectTerrain(category, activities, now, sport);

	const settings = sport === "Run" ? runSettings : swimSettings;
	const latestCtl = wellness.length > 0 ? (wellness[wellness.length - 1].ctl ?? 20) : 20;
	const workout = buildWorkout(
		category,
		sport,
		settings,
		readiness.score,
		latestCtl,
		powerContext,
		staleness.paceBufferSecs,
		staleness.hrOnly,
	);

	// Power context warnings (Stryd/Garmin detection) are only relevant for running
	const warnings = [
		...readiness.warnings,
		...(sport === "Run" ? powerContext.warnings : []),
		...staleness.warnings,
	];

	// Build Vigil summary for output (only when active or building)
	let vigil: VigilSummary | undefined;
	if (vigilResult && vigilResult.status !== "inactive") {
		vigil = {
			severity: vigilResult.alert.severity,
			summary: vigilResult.alert.summary,
			recommendation: vigilResult.alert.recommendation,
			flags: vigilResult.alert.flags.map((f) => ({
				metric: f.metric,
				zScore: f.zScore,
				weight: f.weight,
				weightedZ: f.weightedZ,
				value7d: f.value7d,
				value30d: f.value30d,
			})),
			baselineWindow: vigilResult.baselineWindow,
			acuteWindow: vigilResult.acuteWindow,
			status: vigilResult.status,
		};
	}

	return {
		...workout,
		readiness_score: readiness.score,
		sport_selection_reason: sportSelectionReason ?? `Forced: ${sport}`,
		terrain: terrainSelection.terrain,
		terrain_rationale: terrainSelection.rationale,
		power_context: powerContext,
		...(powerSourceOverride ? { powerSourceOverride } : {}),
		warnings,
		vigil,
	};
}

// ---------------------------------------------------------------------------
// Convenience: fetch + fixed sport
// ---------------------------------------------------------------------------

export async function suggestWorkoutForSport(
	client: IntervalsClient,
	sport: "Run" | "Swim",
): Promise<WorkoutSuggestion> {
	const data = await fetchTrainingData(client);
	return suggestWorkoutFromData(data, sport);
}

// ---------------------------------------------------------------------------
// Full auto: fetch + select sport + pipeline
// ---------------------------------------------------------------------------

export async function suggestWorkout(
	client: IntervalsClient,
	tz?: string,
	strydClient?: StrydClient | null,
	health?: HealthFetchOptions,
	powerSourceOverride?: "stryd" | "garmin" | null,
): Promise<WorkoutSuggestion> {
	const data = await fetchTrainingData(client, tz, health);
	const now = new Date();

	const strydCp = await fetchStrydCpInput(strydClient ?? null, now);

	const powerContext = detectPowerSource(data.activities);
	const readiness = computeReadiness(data.wellness, data.activities, now, {
		health: data.health,
		vigorVitae: data.vigorVitae,
	});
	const sportSelection = selectSport(data.activities, readiness.score, now, powerContext);

	return suggestWorkoutFromData(
		data,
		sportSelection.sport,
		now,
		sportSelection.reason,
		strydCp,
		"0",
		tz,
		powerSourceOverride,
	);
}

/** Resolve Stryd CP and its age in days, or null if unavailable. Shared by
 *  the MCP entry, Praescriptor, and the HTTP API so they all compute
 *  staleness against the same age basis. Failures are swallowed (logged) so
 *  a Stryd outage never breaks workout generation. */
export async function fetchStrydCpInput(
	strydClient: StrydClient | null,
	now: Date = new Date(),
): Promise<StrydCpInput | null> {
	if (!strydClient) return null;
	try {
		if (!strydClient.isAuthenticated) await strydClient.login();
		const result = await strydClient.getLatestCriticalPower();
		if (!result) return null;
		const ageDays = Math.floor((now.getTime() / 1000 - result.createdAt) / 86_400);
		return { cp: result.criticalPower, ageDays };
	} catch (err) {
		console.error("Stryd CP fetch failed:", err);
		return null;
	}
}
