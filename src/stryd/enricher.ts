/**
 * Stryd FIT enrichment pipeline.
 *
 * Detects low-fidelity Apple Watch + Stryd activities (missing CIQ developer
 * fields), downloads the full FIT from Stryd PowerCenter, uploads it to
 * intervals.icu, and marks the original as ignored.
 *
 * Enrichment failures never break the prescription pipeline — all errors are
 * caught, logged, and the original activities returned unchanged.
 */

import { isAlreadyEnriched, recordEnrichment, saveVigilMetrics } from "../db.js";
import { hasStrydStreams, isStrydNativeRecording } from "../engine/power-source.js";
import type { ActivitySummary } from "../engine/types.js";
import { extractMetrics, parseFitBuffer } from "../engine/vigil/fit-parser.js";
import type { IntervalsClient } from "../intervals.js";
import type { StrydActivity, StrydClient } from "./client.js";

/** An activity needs enrichment if it's a Stryd native recording (Apple Watch)
 *  but lacks the CIQ developer field streams, and hasn't been enriched before. */
export function needsEnrichment(activity: ActivitySummary): boolean {
	return (
		isStrydNativeRecording(activity) &&
		!hasStrydStreams(activity) &&
		!isAlreadyEnriched(activity.id)
	);
}

/** Match an intervals.icu activity to a Stryd PowerCenter activity.
 *  Matching: same calendar day (from start_date_local) AND distance within ±5%. */
export function matchStrydActivity(
	icuActivity: ActivitySummary,
	strydActivities: StrydActivity[],
): StrydActivity | null {
	if (!icuActivity.distance || icuActivity.distance <= 0) return null;

	// Extract date portion from intervals.icu local timestamp (YYYY-MM-DD)
	const icuDate = icuActivity.start_date_local.slice(0, 10);

	for (const sa of strydActivities) {
		// Convert Stryd Unix timestamp to local date string
		const strydDate = new Date(sa.timestamp * 1000).toISOString().slice(0, 10);

		if (icuDate !== strydDate) continue;

		// Distance within ±5%
		const distRatio = Math.abs(icuActivity.distance - sa.distance) / icuActivity.distance;
		if (distRatio <= 0.05) return sa;
	}

	return null;
}

interface EnrichmentResult {
	enriched: boolean;
	activityId: string;
	strydActivityId?: number;
	reason: string;
}

async function enrichActivity(
	strydClient: StrydClient,
	intervalsClient: IntervalsClient,
	icuActivity: ActivitySummary,
	strydActivity: StrydActivity,
	athleteId: string,
): Promise<EnrichmentResult> {
	// Download full FIT from Stryd PowerCenter
	const fitBuffer = await strydClient.downloadFit(strydActivity.id);

	// Extract Vigil metrics from the FIT before uploading (incremental pipeline).
	// Failures are non-blocking — enrichment continues regardless.
	try {
		const records = await parseFitBuffer(fitBuffer);
		const activityDate = icuActivity.start_date_local.slice(0, 10);
		const metrics = extractMetrics(
			String(strydActivity.id),
			activityDate,
			records,
			"Run",
			strydActivity.rpe ?? null,
			strydActivity.feel ?? null,
			strydActivity.surface_type ?? null,
			icuActivity.id,
			athleteId,
		);
		if (metrics) {
			saveVigilMetrics(metrics);
			console.error(`Vigil: extracted metrics for Stryd ${strydActivity.id}`);
		}
	} catch (err) {
		console.error(`Vigil: metric extraction failed for Stryd ${strydActivity.id}:`, err);
	}

	// Upload to intervals.icu (creates a new activity with full developer fields)
	const result = (await intervalsClient.uploadFile(
		`/athlete/${intervalsClient.athleteId}/activities`,
		fitBuffer,
		`stryd-${strydActivity.id}.fit`,
	)) as { id: string };

	// Delete the original HealthFit activity — the enriched FIT is strictly superior.
	// Leaving both causes duplicate load and can delay intervals.icu metric computation
	// on the replacement (icu_intensity left null), breaking hard-session detection.
	try {
		await intervalsClient.delete(`/activity/${icuActivity.id}`);
	} catch (err) {
		console.error(`Stryd enrichment: failed to delete original ${icuActivity.id}:`, err);
	}

	// Record enrichment to prevent re-processing
	recordEnrichment(icuActivity.id, strydActivity.id, result.id);

	return {
		enriched: true,
		activityId: icuActivity.id,
		strydActivityId: strydActivity.id,
		reason: `Enriched: ${icuActivity.id} → ${result.id} (Stryd ${strydActivity.id})`,
	};
}

/** Scan activities for low-fidelity Apple Watch + Stryd recordings and enrich
 *  them with full Stryd FIT data. Returns the (possibly refreshed) activity list.
 *
 *  If strydClient is null or enrichment fails, returns the original activities. */
export async function enrichLowFidelityActivities(
	activities: ActivitySummary[],
	strydClient: StrydClient | null,
	intervalsClient: IntervalsClient,
	athleteId = "0",
): Promise<ActivitySummary[]> {
	if (!strydClient) return activities;

	try {
		const candidates = activities.filter(needsEnrichment);
		if (candidates.length === 0) return activities;

		// Lazy auth — only login when we actually have candidates
		if (!strydClient.isAuthenticated) {
			await strydClient.login();
		}

		const strydActivities = await strydClient.listActivities(14);
		let enrichedCount = 0;

		for (const candidate of candidates) {
			try {
				const match = matchStrydActivity(candidate, strydActivities);
				if (!match) {
					console.error(`Stryd enrichment: no match for ${candidate.id}`);
					continue;
				}

				const result = await enrichActivity(
					strydClient,
					intervalsClient,
					candidate,
					match,
					athleteId,
				);
				console.error(`Stryd enrichment: ${result.reason}`);
				enrichedCount++;
			} catch (err) {
				console.error(`Stryd enrichment failed for ${candidate.id}:`, err);
			}
		}

		// Re-fetch activities if any were enriched (the new activity replaces the old)
		if (enrichedCount > 0) {
			const now = new Date();
			const d14Ago = new Date(now.getTime() - 14 * 86_400_000);
			return intervalsClient.get<ActivitySummary[]>(
				`/athlete/${intervalsClient.athleteId}/activities`,
				{
					oldest: d14Ago.toISOString().slice(0, 10),
					newest: now.toISOString().slice(0, 10),
				},
			);
		}

		return activities;
	} catch (err) {
		console.error("Stryd enrichment pipeline failed:", err);
		return activities;
	}
}
