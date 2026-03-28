/**
 * Vigil backfill pipeline.
 *
 * Fetches Stryd FIT files, parses developer fields, and populates
 * vigil_metrics. Supports both initial 90-day backfill and incremental
 * per-activity extraction during enrichment.
 *
 * Failures never break the prescription pipeline — all errors are
 * caught and logged.
 */

import { hasVigilMetrics, saveVigilMetrics } from "../../db.js";
import type { StrydActivity, StrydClient } from "../../stryd/client.js";
import { extractMetrics, parseFitBuffer } from "./fit-parser.js";

/** Delay between FIT downloads to avoid hammering the Stryd API. */
const DOWNLOAD_DELAY_MS = 500;

/** Default backfill depth on first run. */
const BACKFILL_DAYS = 90;

function strydTimestampToDate(ts: number): string {
	return new Date(ts * 1000).toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process a single Stryd activity: download FIT, parse, extract metrics, save.
 * Returns true if metrics were extracted and saved.
 */
export async function processStrydActivity(
	strydClient: StrydClient,
	activity: StrydActivity,
	sport = "Run",
	icuActivityId: string | null = null,
): Promise<boolean> {
	const activityId = String(activity.id);

	if (hasVigilMetrics(activityId)) return false;

	try {
		const fitBuffer = await strydClient.downloadFit(activity.id);
		const records = await parseFitBuffer(fitBuffer);

		const metrics = extractMetrics(
			activityId,
			strydTimestampToDate(activity.timestamp),
			records,
			sport,
			activity.rpe ?? null,
			activity.feel ?? null,
			activity.surface_type ?? null,
			icuActivityId,
		);

		if (metrics) {
			saveVigilMetrics(metrics);
			return true;
		}
	} catch (err) {
		console.error(`Vigil: failed to process Stryd activity ${activityId}:`, err);
	}

	return false;
}

/**
 * Run the initial 90-day backfill from Stryd.
 *
 * Fetches all activities for the backfill period, downloads each FIT file,
 * extracts metrics, and saves to SQLite. Rate-limited to avoid API throttling.
 *
 * @returns Number of activities successfully processed
 */
export async function runBackfill(strydClient: StrydClient, days = BACKFILL_DAYS): Promise<number> {
	if (!strydClient.isAuthenticated) {
		await strydClient.login();
	}

	const activities = await strydClient.listActivities(days);
	console.error(`Vigil backfill: ${activities.length} Stryd activities in last ${days} days`);

	let processed = 0;

	for (const activity of activities) {
		const success = await processStrydActivity(strydClient, activity);
		if (success) {
			processed++;
			console.error(
				`Vigil backfill: processed ${activity.id} (${strydTimestampToDate(activity.timestamp)}) [${processed}/${activities.length}]`,
			);
		}

		// Rate limit: pause between downloads
		if (activities.indexOf(activity) < activities.length - 1) {
			await sleep(DOWNLOAD_DELAY_MS);
		}
	}

	console.error(
		`Vigil backfill complete: ${processed} new metrics from ${activities.length} activities`,
	);
	return processed;
}
