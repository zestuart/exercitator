/**
 * Vigil Garmin FIT extractor.
 *
 * Garmin-recorded runs (source: "GARMIN_CONNECT" in intervals) expose running
 * dynamics as *standard* snake_case FIT fields — not the Stryd CIQ developer
 * fields the Stryd extractor (`fit-parser.ts`) gates on. A Garmin native FIT
 * therefore yields a strict SUBSET of Vigil metrics:
 *
 *   available  → avg GCT (stance_time), GCT drift, power:HR drift (native power),
 *                GCT asymmetry (native stance_time_balance — a bonus the
 *                single-pod Stryd never provided), plus informational avg VO
 *                and avg cadence.
 *   absent     → Leg Spring Stiffness, Form Power, Impact Loading Rate, and the
 *                LSS/VO/ILR balance channels (all Stryd-only) → left null.
 *
 * Four SCOREABLE metrics survive (avg_gct_ms, gct_drift_pct, power_hr_drift,
 * gct_asymmetry_pct) — comfortably above the scorer's ≥2-metric alert gate.
 *
 * Field names verified against a real ze Garmin trail-run FIT (activity
 * 23572046674) — see tests/fixtures/garmin/garmin-run-records.json.gz.
 */

import {
	MAX_RECORDS,
	MIN_RECORDS,
	balanceToAsymmetry,
	computeGctDrift,
	computePowerHrDrift,
	validMean,
} from "./fit-parser.js";
import type { VigilMetrics } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: FIT parser records are untyped
type FitRecord = Record<string, any>;

/** Garmin native running-dynamics FIT fields (all standard, snake_case). */
export const GARMIN_FIT_FIELDS = {
	stanceTime: "stance_time", // ms — ground contact time
	stanceTimeBalance: "stance_time_balance", // % left-foot share (50 = symmetric)
	verticalOscillation: "vertical_oscillation", // mm (÷10 → cm)
	verticalRatio: "vertical_ratio", // % (VO / step_length) — not yet scored
	stepLength: "step_length", // mm
	cadence: "cadence", // RPM per leg
	fractionalCadence: "fractional_cadence", // per-leg fraction; spm = (cad + frac) × 2
	power: "power", // W — native Garmin running power
	heartRate: "heart_rate",
} as const;

/**
 * Whether parsed FIT records carry Garmin native running-dynamics fields.
 * Keyed on `stance_time` — present on every Garmin run-dynamics record and
 * absent from a Stryd developer-field FIT's standard channels only when the
 * watch never wrote it. Combined with the source label this reliably gates
 * Garmin-sourced extraction.
 */
export function hasGarminRunningDynamics(records: FitRecord[]): boolean {
	if (records.length === 0) return false;
	const sample = records.slice(0, 10);
	return sample.some(
		(r) =>
			r[GARMIN_FIT_FIELDS.stanceTime] != null || r[GARMIN_FIT_FIELDS.verticalOscillation] != null,
	);
}

/**
 * Extract the Garmin metric subset from a parsed Garmin FIT.
 *
 * Returns null if the FIT lacks running dynamics or has too few records — the
 * caller treats that as "nothing to record" (non-fatal), mirroring
 * `extractMetrics`.
 *
 * @param activityId   - Garmin activity ID (string form)
 * @param activityDate - ISO 8601 date (YYYY-MM-DD)
 * @param records      - Per-second FIT records
 * @param sport        - Normalised sport (always "Run" for the Garmin path)
 * @param icuActivityId- intervals.icu activity ID, if matched (else null)
 * @param athleteId    - intervals.icu athlete ID
 */
export function extractGarminMetrics(
	activityId: string,
	activityDate: string,
	records: FitRecord[],
	sport = "Run",
	icuActivityId: string | null = null,
	athleteId = "0",
): VigilMetrics | null {
	if (!hasGarminRunningDynamics(records)) return null;
	if (records.length < MIN_RECORDS || records.length > MAX_RECORDS) return null;

	const gctValues = records.map((r) => r[GARMIN_FIT_FIELDS.stanceTime] as number | null);
	// vertical_oscillation is mm in the FIT; convert to cm (matches Stryd path).
	const voValues = records.map((r) => {
		const v = r[GARMIN_FIT_FIELDS.verticalOscillation] as number | null;
		return v != null ? v / 10 : null;
	});
	// Garmin `cadence` is RPM per leg; real step cadence = (cadence + fractional) × 2.
	// NB: informational only (avg_cadence is not a scored metric), so any Stryd-vs-Garmin
	// cadence-semantic mismatch never reaches the deviation scorer.
	const cadValues = records.map((r) => {
		const c = r[GARMIN_FIT_FIELDS.cadence] as number | null;
		if (c == null) return null;
		const frac = (r[GARMIN_FIT_FIELDS.fractionalCadence] as number | null) ?? 0;
		return (c + frac) * 2;
	});
	// GCT asymmetry from Garmin's native left-foot balance share.
	const gctBalances = records.map((r) => r[GARMIN_FIT_FIELDS.stanceTimeBalance] as number | null);

	return {
		athleteId,
		source: "garmin",
		activityId,
		icuActivityId,
		activityDate,
		sport,
		surfaceType: null,
		avgGctMs: validMean(gctValues),
		avgVoCm: validMean(voValues),
		avgCadence: validMean(cadValues),
		gctDriftPct: computeGctDrift(gctValues),
		powerHrDrift: computePowerHrDrift(records),
		gctAsymmetryPct: balanceToAsymmetry(gctBalances),
		// Stryd-only channels — absent from a Garmin native FIT.
		avgLss: null,
		avgFormPower: null,
		avgIlr: null,
		formPowerRatio: null,
		// No per-run subjective data from Garmin.
		strydRpe: null,
		strydFeel: null,
		// Bilateral L/R splits + LSS/VO/ILR asymmetry are Stryd/Duo-only.
		lAvgGctMs: null,
		rAvgGctMs: null,
		lAvgLss: null,
		rAvgLss: null,
		lAvgVoCm: null,
		rAvgVoCm: null,
		lAvgIlr: null,
		rAvgIlr: null,
		lssAsymmetryPct: null,
		voAsymmetryPct: null,
		ilrAsymmetryPct: null,
	};
}
