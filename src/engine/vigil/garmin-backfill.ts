/**
 * Vigil Garmin backfill pipeline.
 *
 * Pulls Garmin-recorded runs from the garmin-bridge, parses each original FIT,
 * extracts the Garmin metric subset (`garmin-fit.ts`), and populates
 * vigil_metrics with source "garmin". This is the Garmin analogue of the Stryd
 * backfill (`backfill.ts`) — but there is NO enrichment/replace step: Garmin
 * runs already live in intervals.icu as source "GARMIN_CONNECT", so this only
 * reads the FIT and records metrics; the intervals activity is untouched.
 *
 * Failures never break the prescription pipeline — all errors are caught and
 * logged, matching the Stryd path.
 */

import { hasAnyVigilMetrics, hasVigilMetrics, saveVigilMetrics } from "../../db.js";
import type { GarminActivity, GarminClient } from "../../garmin/client.js";
import { localDateStr } from "../date-utils.js";
import { parseFitBuffer } from "./fit-parser.js";
import { extractGarminMetrics } from "./garmin-fit.js";

/** Delay between FIT downloads — each bridge call hits Garmin once. */
const DOWNLOAD_DELAY_MS = 500;

/** Default backfill depth on first run (bridge caps at 90 days). */
const BACKFILL_DAYS = 90;

/** Incremental window once a Garmin baseline already exists. */
const INCREMENTAL_SYNC_DAYS = 14;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A Garmin activity is a run if its type key mentions running (running,
 *  trail_running, treadmill_running, …). */
function isRun(activity: GarminActivity): boolean {
	return (activity.sport ?? "").toLowerCase().includes("running");
}

/** Local date (YYYY-MM-DD) for a Garmin activity from its local start time. */
function activityDate(activity: GarminActivity): string | null {
	const s = activity.start_local ?? activity.start_gmt;
	return s ? s.slice(0, 10) : null;
}

/**
 * Process a single Garmin run: download FIT, parse, extract metrics, save.
 * Returns true if metrics were extracted and saved. Deduped on the Garmin
 * activity id (distinct from Stryd ids), so re-runs are cheap.
 */
export async function processGarminActivity(
	garminClient: GarminClient,
	activity: GarminActivity,
	athleteId: string,
): Promise<boolean> {
	const activityId = String(activity.id);
	if (hasVigilMetrics(activityId)) return false;

	const date = activityDate(activity);
	if (!date) return false;

	try {
		const fitBuffer = await garminClient.getActivityFit(activity.id);
		const records = await parseFitBuffer(fitBuffer);
		const metrics = extractGarminMetrics(activityId, date, records, "Run", null, athleteId);
		if (metrics) {
			saveVigilMetrics(metrics);
			return true;
		}
	} catch (err) {
		console.error(`Vigil: failed to process Garmin activity ${activityId}:`, err);
	}
	return false;
}

/**
 * Backfill Garmin run metrics over the last `days` days.
 * Rate-limited between FIT downloads to stay gentle on Garmin.
 *
 * @returns Number of activities successfully processed
 */
export async function runGarminBackfill(
	garminClient: GarminClient,
	athleteId: string,
	days = BACKFILL_DAYS,
	tz?: string,
): Promise<number> {
	const now = new Date();
	const start = localDateStr(new Date(now.getTime() - days * 86_400_000), tz);
	const end = localDateStr(now, tz);

	const activities = (await garminClient.getActivities(start, end)).filter(isRun);
	console.error(`Vigil Garmin backfill: ${activities.length} runs in last ${days} days`);

	let processed = 0;
	for (let i = 0; i < activities.length; i++) {
		const success = await processGarminActivity(garminClient, activities[i], athleteId);
		if (success) {
			processed++;
			console.error(
				`Vigil Garmin backfill: processed ${activities[i].id} (${activityDate(activities[i])}) [${processed}/${activities.length}]`,
			);
		}
		if (i < activities.length - 1) await sleep(DOWNLOAD_DELAY_MS);
	}

	console.error(
		`Vigil Garmin backfill complete: ${processed} new metrics from ${activities.length} runs`,
	);
	return processed;
}

/** Per-athlete in-flight guard (Garmin path). */
const backfillsInFlight = new Set<string>();

/** Per-athlete daily debounce (Garmin path): one Garmin sync per UTC day. */
const lastSyncByAthlete = new Map<string, string>();

/**
 * Ensure Garmin Vigil metrics are current for this athlete. First encounter
 * (no Garmin metrics in DB) → 90-day backfill; thereafter a 14-day incremental
 * sync. Independent of the Stryd first-time gate (source-scoped), so a
 * populated Stryd baseline never suppresses the Garmin backfill.
 *
 * No-op when no GarminClient is available (health source not garmin/auto).
 * Debounced to once per UTC day per athlete. Awaitable — Praescriptor blocks
 * on it so the day's alert reflects Garmin runs.
 */
export async function runGarminVigilBackfillIfNeeded(
	garminClient: GarminClient | null,
	athleteId: string,
	tz?: string,
): Promise<void> {
	if (!garminClient) return;
	if (backfillsInFlight.has(athleteId)) return;

	const isFirstTime = !hasAnyVigilMetrics(athleteId, "garmin");
	const today = new Date().toISOString().slice(0, 10);
	if (!isFirstTime && lastSyncByAthlete.get(athleteId) === today) return;

	backfillsInFlight.add(athleteId);
	try {
		const days = isFirstTime ? BACKFILL_DAYS : INCREMENTAL_SYNC_DAYS;
		if (isFirstTime) {
			console.error(`Vigil: no Garmin metrics for ${athleteId} — running ${days}-day backfill`);
		}
		const count = await runGarminBackfill(garminClient, athleteId, days, tz);
		if (count > 0) {
			console.error(`Vigil: Garmin sync added ${count} new activities for ${athleteId}`);
		}
		lastSyncByAthlete.set(athleteId, today);
	} catch (err) {
		console.error(`Vigil Garmin backfill/sync failed for ${athleteId}:`, err);
	} finally {
		backfillsInFlight.delete(athleteId);
	}
}

/** Test-only: clear the per-athlete daily-sync debounce. */
export function _resetGarminVigilSyncDebounceForTesting(): void {
	lastSyncByAthlete.clear();
}
