/**
 * Vigil deviation scoring and composite alert generation.
 *
 * Compares 7-day acute metrics against 30-day baseline using z-scores,
 * applies metric weights, and produces severity 0–3 composite alerts.
 *
 * Severity thresholds (using weighted concern scores):
 *   0: < 2 metrics with weighted concern > 1.5σ
 *   1: 2+ metrics with weighted concern > 1.5σ (Watch)
 *   2: 2+ metrics with weighted concern > 2.0σ (Caution — protective downshift)
 *   3: 3+ metrics with weighted concern > 2.0σ, OR any metric > 3.0σ (Alert — force base)
 *
 * Bilateral boost: if asymmetry metrics are among the flagged metrics,
 * severity is boosted by 1 (capped at 3).
 */

import { BILATERAL_METRICS } from "./metrics.js";
import type { VigilAlert, VigilBaseline, VigilFlag } from "./types.js";
import { METRIC_WEIGHTS, WORSE_WHEN_HIGHER, WORSE_WHEN_LOWER } from "./types.js";

/**
 * Compute the directional concern score for a metric.
 * Positive return = worsening, regardless of raw direction.
 */
function concernScore(metric: string, zScore: number, weight: number): number {
	let directional: number;
	if (WORSE_WHEN_HIGHER.includes(metric)) directional = zScore;
	else if (WORSE_WHEN_LOWER.includes(metric)) directional = -zScore;
	else directional = Math.abs(zScore);

	return directional * weight;
}

/**
 * Score deviations and generate a composite alert.
 *
 * @param baselines - Current baselines (must have both mean_30d and mean_7d)
 */
export function scoreDeviations(baselines: VigilBaseline[]): VigilAlert {
	const flags: VigilFlag[] = [];

	for (const b of baselines) {
		// Skip if no acute window or baseline has no variance
		if (b.mean7d == null || b.stddev30d <= 0) continue;

		const weight = METRIC_WEIGHTS[b.metric] ?? 1.0;
		const zScore = (b.mean7d - b.mean30d) / b.stddev30d;
		const weighted = concernScore(b.metric, zScore, weight);

		// Only flag metrics where weighted concern exceeds 1.5σ
		if (weighted > 1.5) {
			flags.push({
				metric: b.metric,
				zScore,
				weight,
				weightedZ: zScore * weight,
				concernScore: weighted,
				direction: "worsening",
				value7d: b.mean7d,
				value30d: b.mean30d,
			});
		} else if (weighted < -1.5) {
			// Improving — track but don't alert
			flags.push({
				metric: b.metric,
				zScore,
				weight,
				weightedZ: zScore * weight,
				concernScore: weighted,
				direction: "improving",
				value7d: b.mean7d,
				value30d: b.mean30d,
			});
		}
	}

	// Only worsening flags contribute to severity
	const worseningFlags = flags.filter((f) => f.direction === "worsening");

	// Count flags by threshold
	const above15 = worseningFlags.filter((f) => f.concernScore > 1.5).length;
	const above20 = worseningFlags.filter((f) => f.concernScore > 2.0).length;
	const above30 = worseningFlags.filter((f) => f.concernScore > 3.0).length;

	// Determine base severity
	let severity: 0 | 1 | 2 | 3;
	if (above30 >= 1 || above20 >= 3) {
		severity = 3;
	} else if (above20 >= 2) {
		severity = 2;
	} else if (above15 >= 2) {
		severity = 1;
	} else {
		severity = 0;
	}

	// Bilateral boost: +1 if any asymmetry metric is flagged as worsening
	const hasBilateralFlag = worseningFlags.some((f) => BILATERAL_METRICS.includes(f.metric));
	if (hasBilateralFlag && severity > 0 && severity < 3) {
		severity = (severity + 1) as 1 | 2 | 3;
	}

	return {
		severity,
		flags: worseningFlags,
		summary: buildSummary(severity, worseningFlags),
		recommendation: buildRecommendation(severity),
	};
}

function buildSummary(severity: 0 | 1 | 2 | 3, flags: VigilFlag[]): string {
	if (severity === 0 || flags.length === 0) return "No biomechanical concerns detected.";

	const label = severity === 1 ? "Watch" : severity === 2 ? "Caution" : "Alert";
	const metricDescs = flags
		.slice(0, 4)
		.map((f) => {
			const sign = f.zScore > 0 ? "+" : "";
			return `${f.metric} ${sign}${f.zScore.toFixed(1)}σ`;
		})
		.join(", ");

	return `${label}: ${metricDescs} above 30-day baseline`;
}

function buildRecommendation(severity: 0 | 1 | 2 | 3): string {
	switch (severity) {
		case 0:
			return "Normal prescription.";
		case 1:
			return "Prescription unchanged — monitor next 2–3 sessions.";
		case 2:
			return "Intensity downshifted. Monitor form — if discomfort persists, consider professional assessment.";
		case 3:
			return "Prescription forced to base — consider rest day. Multiple metrics outside normal range.";
	}
}
