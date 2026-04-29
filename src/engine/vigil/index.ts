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
import { localDateStr } from "../date-utils.js";
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
 * Lookback window (days) used only for the activity-count gate.
 *
 * The metric baseline still computes statistics over the most recent
 * 30 days (`computeBaselines`) — that's the rolling window relevant to
 * detecting deviation from current form. But the `building` gate counts
 * over a wider 60 days so an athlete who runs 4 times a month doesn't
 * get stuck at "4/5 activities" indefinitely while their baseline is
 * actually statistically usable.
 */
const COUNT_WINDOW_DAYS = 60;

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
export function runVigilPipeline(
	athleteId: string,
	sport: string,
	referenceDate?: Date,
	tz?: string,
): VigilResult {
	const ref = referenceDate ?? new Date();
	const newest = localDateStr(ref, tz);
	const oldestCount = localDateStr(new Date(ref.getTime() - COUNT_WINDOW_DAYS * 86_400_000), tz);
	const oldest30d = localDateStr(new Date(ref.getTime() - 30 * 86_400_000), tz);
	const oldest7d = localDateStr(new Date(ref.getTime() - 7 * 86_400_000), tz);

	const countWindow = countVigilMetrics(athleteId, sport, oldestCount, newest);

	if (countWindow === 0) {
		return {
			alert: { severity: 0, flags: [], summary: "Vigil: no Stryd data", recommendation: "" },
			baselineWindow: `${COUNT_WINDOW_DAYS}d (0 activities)`,
			acuteWindow: "7d (0 activities)",
			status: "inactive",
		};
	}

	if (countWindow < MIN_BASELINE_ACTIVITIES) {
		return {
			alert: {
				severity: 0,
				flags: [],
				summary: `Vigil: baseline building (${countWindow}/${MIN_BASELINE_ACTIVITIES} activities in ${COUNT_WINDOW_DAYS}d)`,
				recommendation: "",
			},
			baselineWindow: `${COUNT_WINDOW_DAYS}d (${countWindow} activities)`,
			acuteWindow: "7d (pending)",
			status: "building",
		};
	}

	// Metric baseline still uses the 30-day window — that's the statistically
	// relevant horizon for deviation detection. The 60-day count above just
	// confirms the athlete is consistent enough for the alert system to be
	// useful.
	const count30d = countVigilMetrics(athleteId, sport, oldest30d, newest);
	const count7d = countVigilMetrics(athleteId, sport, oldest7d, newest);
	const baselines = computeBaselines(athleteId, sport, ref, tz);
	const alert = scoreDeviations(baselines);

	return {
		alert,
		baselineWindow: `30d (${count30d} activities)`,
		acuteWindow: `7d (${count7d} activities)`,
		status: "active",
	};
}
