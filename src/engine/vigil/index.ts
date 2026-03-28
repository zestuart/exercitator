/**
 * Vigil pipeline orchestrator.
 *
 * Top-level entry point for the injury warning system. Computes baselines
 * from stored metrics and scores deviations. Called from suggestWorkoutFromData()
 * and Praescriptor prescription generation.
 *
 * Does NOT fetch or process FIT files — that's handled by backfill.ts
 * during enrichment. This module only reads from vigil_metrics in SQLite.
 */

import { countVigilMetrics } from "../../db.js";
import { computeBaselines } from "./baseline.js";
import { scoreDeviations } from "./scorer.js";
import type { VigilAlert } from "./types.js";

/** Result of a Vigil pipeline run. */
export interface VigilResult {
	alert: VigilAlert;
	baselineWindow: string;
	acuteWindow: string;
	status: "active" | "building" | "inactive";
}

/** Minimum activities for a usable baseline. */
const MIN_BASELINE_ACTIVITIES = 5;

/**
 * Run the Vigil pipeline for a sport.
 *
 * 1. Check we have enough stored metrics for a baseline
 * 2. Compute 30d + 7d baselines from vigil_metrics
 * 3. Score deviations → composite alert
 *
 * Returns a VigilResult with status indicating whether the system is
 * active, building baseline, or inactive (no data).
 *
 * @param sport - Sport type (e.g. "Run")
 * @param referenceDate - Date to compute baselines relative to (default: today)
 */
export function runVigilPipeline(sport: string, referenceDate?: Date): VigilResult {
	const ref = referenceDate ?? new Date();
	const newest = ref.toISOString().slice(0, 10);
	const oldest30d = new Date(ref.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
	const oldest7d = new Date(ref.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);

	const count30d = countVigilMetrics(sport, oldest30d, newest);

	if (count30d === 0) {
		return {
			alert: { severity: 0, flags: [], summary: "Vigil: no Stryd data", recommendation: "" },
			baselineWindow: "30d (0 activities)",
			acuteWindow: "7d (0 activities)",
			status: "inactive",
		};
	}

	if (count30d < MIN_BASELINE_ACTIVITIES) {
		return {
			alert: {
				severity: 0,
				flags: [],
				summary: `Vigil: baseline building (${count30d}/${MIN_BASELINE_ACTIVITIES} activities)`,
				recommendation: "",
			},
			baselineWindow: `30d (${count30d} activities)`,
			acuteWindow: "7d (pending)",
			status: "building",
		};
	}

	const count7d = countVigilMetrics(sport, oldest7d, newest);
	const baselines = computeBaselines(sport, ref);
	const alert = scoreDeviations(baselines);

	return {
		alert,
		baselineWindow: `30d (${count30d} activities)`,
		acuteWindow: `7d (${count7d} activities)`,
		status: "active",
	};
}
