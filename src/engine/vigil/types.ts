/**
 * Vigil — biomechanical injury warning system types.
 *
 * Personal baseline deviation detection using Stryd running metrics.
 * All scoring uses intra-individual z-scores, not population thresholds.
 */

/** Per-activity metric summary computed from Stryd FIT developer fields. */
export interface VigilMetrics {
	/** intervals.icu athlete ID — isolates metrics per user in multi-user setups. */
	athleteId: string;
	activityId: string;
	icuActivityId: string | null;
	activityDate: string;
	sport: string;
	surfaceType: string | null;

	// Unilateral averages (whole activity)
	avgGctMs: number | null;
	avgLss: number | null;
	avgFormPower: number | null;
	avgIlr: number | null;
	avgVoCm: number | null;
	avgCadence: number | null;
	formPowerRatio: number | null;

	// Within-run drift (first quartile vs last quartile)
	gctDriftPct: number | null;
	powerHrDrift: number | null;

	// Stryd post-run subjective data
	strydRpe: number | null;
	strydFeel: string | null;

	// Bilateral (Duo only — null for single pod)
	lAvgGctMs: number | null;
	rAvgGctMs: number | null;
	lAvgLss: number | null;
	rAvgLss: number | null;
	lAvgVoCm: number | null;
	rAvgVoCm: number | null;
	lAvgIlr: number | null;
	rAvgIlr: number | null;
	gctAsymmetryPct: number | null;
	lssAsymmetryPct: number | null;
	voAsymmetryPct: number | null;
	ilrAsymmetryPct: number | null;
}

/** A single flagged metric in a Vigil alert. */
export interface VigilFlag {
	metric: string;
	zScore: number;
	weight: number;
	weightedZ: number;
	concernScore: number;
	direction: "worsening" | "improving";
	value7d: number;
	value30d: number;
}

/** Composite alert from deviation scoring. */
export interface VigilAlert {
	severity: 0 | 1 | 2 | 3;
	flags: VigilFlag[];
	summary: string;
	recommendation: string;
}

/** Stored baseline for a single metric. */
export interface VigilBaseline {
	/** intervals.icu athlete ID — isolates baselines per user. */
	athleteId: string;
	sport: string;
	metric: string;
	computedAt: string;
	mean30d: number;
	stddev30d: number;
	mean7d: number | null;
	sampleCount30d: number;
	sampleCount7d: number | null;
}

/**
 * Metric weight configuration.
 *
 * Weights reflect measurement validity from a shoe-mounted IMU:
 * - GCT/LSS: highest reliability (ICC ~0.90–0.93)
 * - Form Power Ratio / Power:HR drift: good but less independent evidence
 * - ILR: noisier from foot mount, terrain-sensitive (ICC ~0.75)
 * - Asymmetry: change detection is the primary value
 */
export const METRIC_WEIGHTS: Record<string, number> = {
	avg_gct_ms: 1.0,
	avg_lss: 1.0,
	form_power_ratio: 0.8,
	avg_ilr: 0.5,
	gct_drift_pct: 1.0,
	power_hr_drift: 0.8,
	// Bilateral (Duo)
	gct_asymmetry_pct: 1.0,
	lss_asymmetry_pct: 1.0,
	vo_asymmetry_pct: 1.0,
	ilr_asymmetry_pct: 0.5,
};

/** Metrics where a higher value indicates worsening biomechanics. */
export const WORSE_WHEN_HIGHER = [
	"avg_gct_ms",
	"form_power_ratio",
	"avg_ilr",
	"gct_drift_pct",
	"power_hr_drift",
	"gct_asymmetry_pct",
	"lss_asymmetry_pct",
	"vo_asymmetry_pct",
	"ilr_asymmetry_pct",
];

/** Metrics where a lower value indicates worsening biomechanics. */
export const WORSE_WHEN_LOWER = ["avg_lss"];

/** Stryd FIT field names as they appear in parsed FIT files.
 *  Developer fields are capitalised with spaces; standard fields are snake_case. */
export const STRYD_FIT_FIELDS = {
	// Developer fields (CIQ)
	legSpringStiffness: "Leg Spring Stiffness",
	formPower: "Form Power",
	impact: "Impact",
	power: "Power",
	// Standard FIT fields
	stanceTime: "stance_time",
	verticalOscillation: "vertical_oscillation",
	cadence: "cadence",
	heartRate: "heart_rate",
	// Duo bilateral balance fields (developer) — percentage left foot
	// 50% = symmetric, >50% = left-dominant, <50% = right-dominant
	lssBalance: "Leg Spring Stiffness Balance",
	voBalance: "Vertical Oscillation Balance",
	ilrBalance: "Impact Loading Rate Balance",
	gctBalance: "stance_time_balance",
} as const;
