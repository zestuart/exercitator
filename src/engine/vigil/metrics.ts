/**
 * Vigil metric extraction from stored VigilMetrics rows.
 *
 * Maps VigilMetrics object fields to the flat metric names used in
 * baseline computation and deviation scoring. Only returns non-null
 * values — missing metrics are excluded from baseline/scoring.
 */

import type { VigilMetrics } from "./types.js";
import { METRIC_WEIGHTS } from "./types.js";

/** A single metric value extracted from a VigilMetrics row. */
export interface MetricValue {
	metric: string;
	value: number;
}

/**
 * Mapping from baseline metric name → VigilMetrics field.
 * Only metrics that have a defined weight are scoreable.
 */
const METRIC_FIELD_MAP: Record<string, keyof VigilMetrics> = {
	avg_gct_ms: "avgGctMs",
	avg_lss: "avgLss",
	form_power_ratio: "formPowerRatio",
	avg_ilr: "avgIlr",
	gct_drift_pct: "gctDriftPct",
	power_hr_drift: "powerHrDrift",
	// Bilateral (Duo)
	gct_asymmetry_pct: "gctAsymmetryPct",
	lss_asymmetry_pct: "lssAsymmetryPct",
	vo_asymmetry_pct: "voAsymmetryPct",
	ilr_asymmetry_pct: "ilrAsymmetryPct",
};

/** List of all scoreable metric names (those with defined weights). */
export const SCOREABLE_METRICS = Object.keys(METRIC_FIELD_MAP).filter(
	(m) => METRIC_WEIGHTS[m] != null,
);

/** List of bilateral-only metric names. */
export const BILATERAL_METRICS = [
	"gct_asymmetry_pct",
	"lss_asymmetry_pct",
	"vo_asymmetry_pct",
	"ilr_asymmetry_pct",
];

/**
 * Extract all scoreable metric values from a VigilMetrics row.
 * Returns only non-null metrics — missing values are excluded.
 */
export function extractScoreableMetrics(m: VigilMetrics): MetricValue[] {
	const result: MetricValue[] = [];

	for (const [metric, field] of Object.entries(METRIC_FIELD_MAP)) {
		if (METRIC_WEIGHTS[metric] == null) continue;
		const value = m[field];
		if (typeof value === "number" && !Number.isNaN(value)) {
			result.push({ metric, value });
		}
	}

	return result;
}

/**
 * Extract a single metric value from a VigilMetrics row.
 * Returns null if the metric is missing or not a number.
 */
export function getMetricValue(m: VigilMetrics, metric: string): number | null {
	const field = METRIC_FIELD_MAP[metric];
	if (!field) return null;
	const value = m[field];
	if (typeof value === "number" && !Number.isNaN(value)) return value;
	return null;
}
