/**
 * Vigil baseline computation.
 *
 * Computes 30-day rolling mean + stddev and 7-day acute window mean
 * for each scoreable metric, per sport. Stores results in SQLite.
 *
 * Minimum thresholds:
 * - 30-day baseline: requires ≥ 5 activities with non-null metric
 * - 7-day acute window: requires ≥ 2 activities with non-null metric
 */

import { getVigilMetrics, saveVigilBaseline } from "../../db.js";
import { SCOREABLE_METRICS, getMetricValue } from "./metrics.js";
import type { VigilBaseline, VigilMetrics } from "./types.js";

/** Minimum activities for a valid 30-day baseline. */
const MIN_BASELINE_ACTIVITIES = 5;

/** Minimum activities for a valid 7-day acute window. */
const MIN_ACUTE_ACTIVITIES = 2;

function isoDate(daysAgo: number, from?: Date): string {
	const d = from ?? new Date();
	d.setDate(d.getDate() - daysAgo);
	return d.toISOString().slice(0, 10);
}

function mean(values: number[]): number {
	return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
	if (values.length < 2) return 0;
	const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance);
}

/** Compute a single metric's baseline from activity rows. */
function computeMetricBaseline(
	metric: string,
	activities30d: VigilMetrics[],
	activities7d: VigilMetrics[],
	athleteId: string,
	sport: string,
): VigilBaseline | null {
	// Extract non-null values for this metric
	const values30d: number[] = [];
	for (const a of activities30d) {
		const v = getMetricValue(a, metric);
		if (v != null) values30d.push(v);
	}

	if (values30d.length < MIN_BASELINE_ACTIVITIES) return null;

	const mean30d = mean(values30d);
	const stddev30d = stddev(values30d, mean30d);

	// 7-day acute window
	const values7d: number[] = [];
	for (const a of activities7d) {
		const v = getMetricValue(a, metric);
		if (v != null) values7d.push(v);
	}

	const mean7d = values7d.length >= MIN_ACUTE_ACTIVITIES ? mean(values7d) : null;

	return {
		athleteId,
		sport,
		metric,
		computedAt: new Date().toISOString(),
		mean30d,
		stddev30d,
		mean7d,
		sampleCount30d: values30d.length,
		sampleCount7d: values7d.length >= MIN_ACUTE_ACTIVITIES ? values7d.length : null,
	};
}

/**
 * Recompute all baselines for a sport.
 *
 * Reads vigil_metrics from the DB, computes 30-day + 7-day windows,
 * and saves each metric's baseline. Returns the computed baselines.
 *
 * @param sport - Sport type (e.g. "Run", "TrailRun")
 * @param referenceDate - Date to compute baselines relative to (default: today)
 */
export function computeBaselines(
	athleteId: string,
	sport: string,
	referenceDate?: Date,
): VigilBaseline[] {
	const ref = referenceDate ?? new Date();
	const oldest30d = isoDate(30, new Date(ref.getTime()));
	const oldest7d = isoDate(7, new Date(ref.getTime()));
	const newest = ref.toISOString().slice(0, 10);

	const activities30d = getVigilMetrics(athleteId, sport, oldest30d, newest);
	const activities7d = activities30d.filter((a) => a.activityDate >= oldest7d);

	const baselines: VigilBaseline[] = [];

	for (const metric of SCOREABLE_METRICS) {
		const baseline = computeMetricBaseline(metric, activities30d, activities7d, athleteId, sport);
		if (baseline) {
			saveVigilBaseline(baseline);
			baselines.push(baseline);
		}
	}

	return baselines;
}

/**
 * Compute baselines from provided activity data (no DB read).
 *
 * Used for testing and scenarios where activities are already loaded.
 */
export function computeBaselinesFromData(
	athleteId: string,
	sport: string,
	activities30d: VigilMetrics[],
	activities7d: VigilMetrics[],
): VigilBaseline[] {
	const baselines: VigilBaseline[] = [];

	for (const metric of SCOREABLE_METRICS) {
		const baseline = computeMetricBaseline(metric, activities30d, activities7d, athleteId, sport);
		if (baseline) {
			baselines.push(baseline);
		}
	}

	return baselines;
}
