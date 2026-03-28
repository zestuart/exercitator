/**
 * Generates dual prescriptions (Run + Swim) using the DSW engine.
 * Caches results per day to avoid redundant API calls on /api/send.
 */

import { type TrainingData, fetchTrainingData, suggestWorkoutFromData } from "../engine/suggest.js";
import type { VigilSummary, WorkoutSuggestion } from "../engine/types.js";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";
import { enrichLowFidelityActivities } from "../stryd/enricher.js";

export interface DataSource {
	/** Number of activities in the 14-day window. */
	activityCount: number;
	/** Date range of activities (YYYY-MM-DD). */
	activityRange: [string, string] | null;
	/** Per-device breakdown: device_name → count. */
	activityDevices: Record<string, number>;
	/** Number of wellness records in the 7-day window. */
	wellnessCount: number;
	/** Date range of wellness records (YYYY-MM-DD). */
	wellnessRange: [string, string] | null;
	/** Number of activities enriched via Stryd FIT in this generation. */
	strydEnriched: number;
	/** Stryd critical power in watts, if used as FTP source. */
	strydCp: number | null;
	/** Vigil status from the run prescription (null for swim-only or no Vigil data). */
	vigil: VigilSummary | null;
}

export interface DualPrescription {
	run: WorkoutSuggestion;
	swim: WorkoutSuggestion;
	/** HR zone ceilings from intervals.icu run sport settings. */
	runHrZones: number[] | null;
	/** HR zone ceilings from intervals.icu swim sport settings. */
	swimHrZones: number[] | null;
	dataSource: DataSource;
	generated_at: string;
}

let cached: { date: string; prescription: DualPrescription } | null = null;

export async function generatePrescriptions(
	client: IntervalsClient,
	strydClient?: StrydClient | null,
): Promise<DualPrescription> {
	const today = new Date().toISOString().slice(0, 10);
	if (cached && cached.date === today) {
		return cached.prescription;
	}

	const data = await fetchTrainingData(client);
	const preEnrichIds = new Set(data.activities.map((a) => a.id));

	// Enrich low-fidelity Apple Watch + Stryd activities with full Stryd FIT data.
	// Failures are caught internally — prescriptions always proceed.
	data.activities = await enrichLowFidelityActivities(data.activities, strydClient ?? null, client);

	// Count enrichments: new IDs that weren't in the pre-enrichment set
	const strydEnriched = data.activities.filter((a) => !preEnrichIds.has(a.id)).length;

	// Fetch authoritative critical power from Stryd (used as run FTP)
	const strydCp = await fetchStrydCp(strydClient ?? null);

	const now = new Date();

	const [run, swim] = [
		suggestWorkoutFromData(data, "Run", now, undefined, strydCp),
		suggestWorkoutFromData(data, "Swim", now),
	];

	const dataSource = buildDataSource(data, strydEnriched, strydCp, run.vigil ?? null);
	const prescription: DualPrescription = {
		run,
		swim,
		runHrZones: data.runSettings.hr_zones,
		swimHrZones: data.swimSettings.hr_zones,
		dataSource,
		generated_at: now.toISOString(),
	};

	cached = { date: today, prescription };
	return prescription;
}

export function invalidateCache(): void {
	cached = null;
}

async function fetchStrydCp(strydClient: StrydClient | null): Promise<number | null> {
	if (!strydClient) return null;
	try {
		if (!strydClient.isAuthenticated) await strydClient.login();
		return await strydClient.getLatestCriticalPower();
	} catch (err) {
		console.error("Stryd CP fetch failed:", err);
		return null;
	}
}

function buildDataSource(
	data: TrainingData,
	strydEnriched: number,
	strydCp: number | null,
	vigil: VigilSummary | null,
): DataSource {
	const { activities, wellness } = data;

	// Activity date range and device breakdown
	const actDates = activities.map((a) => a.start_date_local.slice(0, 10)).sort();
	const activityDevices: Record<string, number> = {};
	for (const a of activities) {
		const device = a.device_name ?? "Unknown";
		activityDevices[device] = (activityDevices[device] ?? 0) + 1;
	}

	// Wellness date range
	const wellDates = wellness.map((w) => w.id).sort(); // wellness.id is YYYY-MM-DD

	return {
		activityCount: activities.length,
		activityRange: actDates.length > 0 ? [actDates[0], actDates[actDates.length - 1]] : null,
		activityDevices,
		wellnessCount: wellness.length,
		wellnessRange: wellDates.length > 0 ? [wellDates[0], wellDates[wellDates.length - 1]] : null,
		strydEnriched,
		strydCp,
		vigil,
	};
}
