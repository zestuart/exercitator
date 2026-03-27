/**
 * Generates dual prescriptions (Run + Swim) using the DSW engine.
 * Caches results per day to avoid redundant API calls on /api/send.
 */

import { fetchTrainingData, suggestWorkoutFromData } from "../engine/suggest.js";
import type { WorkoutSuggestion } from "../engine/types.js";
import type { IntervalsClient } from "../intervals.js";

export interface DualPrescription {
	run: WorkoutSuggestion;
	swim: WorkoutSuggestion;
	/** HR zone ceilings from intervals.icu run sport settings. */
	runHrZones: number[] | null;
	/** HR zone ceilings from intervals.icu swim sport settings. */
	swimHrZones: number[] | null;
	generated_at: string;
}

let cached: { date: string; prescription: DualPrescription } | null = null;

export async function generatePrescriptions(client: IntervalsClient): Promise<DualPrescription> {
	const today = new Date().toISOString().slice(0, 10);
	if (cached && cached.date === today) {
		return cached.prescription;
	}

	const data = await fetchTrainingData(client);
	const now = new Date();

	const [run, swim] = [
		suggestWorkoutFromData(data, "Run", now),
		suggestWorkoutFromData(data, "Swim", now),
	];

	const prescription: DualPrescription = {
		run,
		swim,
		runHrZones: data.runSettings.hr_zones,
		swimHrZones: data.swimSettings.hr_zones,
		generated_at: now.toISOString(),
	};

	cached = { date: today, prescription };
	return prescription;
}

export function invalidateCache(): void {
	cached = null;
}
