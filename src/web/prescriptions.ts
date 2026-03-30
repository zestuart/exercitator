/**
 * Generates prescriptions using the DSW engine.
 * Caches results per user per day to avoid redundant API calls on /api/send.
 */

import { hasAnyVigilMetrics } from "../db.js";
import { type TrainingData, fetchTrainingData, suggestWorkoutFromData } from "../engine/suggest.js";
import type { VigilSummary, WorkoutSuggestion } from "../engine/types.js";
import { runBackfill } from "../engine/vigil/backfill.js";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";
import { enrichLowFidelityActivities } from "../stryd/enricher.js";
import type { UserProfile } from "./users.js";

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

export interface Prescription {
	run: WorkoutSuggestion | null;
	swim: WorkoutSuggestion | null;
	/** HR zone ceilings from intervals.icu run sport settings. */
	runHrZones: number[] | null;
	/** HR zone ceilings from intervals.icu swim sport settings. */
	swimHrZones: number[] | null;
	dataSource: DataSource;
	generated_at: string;
}

const cache = new Map<string, { date: string; prescription: Prescription }>();

export async function generatePrescriptions(
	client: IntervalsClient,
	profile: UserProfile,
	strydClient?: StrydClient | null,
): Promise<Prescription> {
	const today = new Date().toISOString().slice(0, 10);
	const cached = cache.get(profile.id);
	if (cached && cached.date === today) {
		return cached.prescription;
	}

	const data = await fetchTrainingData(client);
	const preEnrichIds = new Set(data.activities.map((a) => a.id));

	// Stryd enrichment only for users with stryd: true
	if (profile.stryd) {
		data.activities = await enrichLowFidelityActivities(
			data.activities,
			strydClient ?? null,
			client,
			profile.id,
		);
	}

	const strydEnriched = data.activities.filter((a) => !preEnrichIds.has(a.id)).length;

	// Vigil: one-off 90-day backfill if vigil_metrics is empty for this athlete.
	if (profile.stryd) {
		await runVigilBackfillIfNeeded(strydClient ?? null, profile.id);
	}

	// Fetch authoritative critical power from Stryd (used as run FTP)
	const strydCp = profile.stryd ? await fetchStrydCp(strydClient ?? null) : null;

	const now = new Date();
	const hasSport = (s: "Run" | "Swim") => profile.sports.includes(s);

	const run = hasSport("Run")
		? suggestWorkoutFromData(data, "Run", now, undefined, strydCp, profile.id)
		: null;
	const swim = hasSport("Swim") ? suggestWorkoutFromData(data, "Swim", now) : null;

	// Vigil wellness write: update injury field when severity ≥ 2 (run prescription only).
	// Severity 2 → Niggle (2), Severity 3 → Poor (3). Never write 4 (Injured) automatically.
	if (run?.vigil && (run.vigil.severity === 2 || run.vigil.severity === 3)) {
		writeVigilInjury(client, run.vigil.severity).catch((err) =>
			console.error("Vigil wellness write failed:", err),
		);
	}

	const dataSource = buildDataSource(data, strydEnriched, strydCp, run?.vigil ?? null);
	const prescription: Prescription = {
		run,
		swim,
		runHrZones: hasSport("Run") ? data.runSettings.hr_zones : null,
		swimHrZones: hasSport("Swim") ? data.swimSettings.hr_zones : null,
		dataSource,
		generated_at: now.toISOString(),
	};

	cache.set(profile.id, { date: today, prescription });
	return prescription;
}

export function invalidateCache(userId?: string): void {
	if (userId) {
		cache.delete(userId);
	} else {
		cache.clear();
	}
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

async function runVigilBackfillIfNeeded(
	strydClient: StrydClient | null,
	athleteId: string,
): Promise<void> {
	if (!strydClient) return;
	if (hasAnyVigilMetrics(athleteId)) return;

	try {
		console.error("Vigil: no metrics found — running 90-day backfill from Stryd");
		const count = await runBackfill(strydClient, athleteId);
		console.error(`Vigil: backfill complete — ${count} activities processed`);
	} catch (err) {
		console.error("Vigil backfill failed:", err);
	}
}

async function writeVigilInjury(client: IntervalsClient, severity: 2 | 3): Promise<void> {
	const today = new Date().toISOString().slice(0, 10);
	// intervals.icu injury field: 2 = Niggle, 3 = Poor, 4 = Injured (never automatic)
	const injury = severity === 3 ? 3 : 2;
	await client.put(`/athlete/${client.athleteId}/wellness/${today}`, { injury });
}

function buildDataSource(
	data: TrainingData,
	strydEnriched: number,
	strydCp: number | null,
	vigil: VigilSummary | null,
): DataSource {
	const { activities, wellness } = data;

	const actDates = activities.map((a) => a.start_date_local.slice(0, 10)).sort();
	const activityDevices: Record<string, number> = {};
	for (const a of activities) {
		const device = a.device_name ?? "Unknown";
		activityDevices[device] = (activityDevices[device] ?? 0) + 1;
	}

	const wellDates = wellness.map((w) => w.id).sort();

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
