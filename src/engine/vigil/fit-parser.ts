/**
 * Vigil FIT file parser.
 *
 * Extracts per-activity biomechanical metrics from Stryd FIT files.
 * Uses fit-file-parser to decode FIT binary → per-second records,
 * then computes summary statistics (averages, drift, ratios).
 *
 * Developer fields are flattened onto each record by fit-file-parser
 * using the field_name from the FIT field_description message.
 */

import FitParser from "fit-file-parser";
import { STRYD_FIT_FIELDS, type VigilMetrics } from "./types.js";

/** Minimum records required for meaningful metrics (≈ 3 minutes at 1 Hz). */
const MIN_RECORDS = 180;

/** Minimum records per quartile for drift calculation. */
const MIN_QUARTILE_SIZE = 30;

/** Window size in seconds for power:HR drift calculation. */
const POWER_HR_WINDOW_SECS = 300;

// biome-ignore lint/suspicious/noExplicitAny: FIT parser records are untyped
type FitRecord = Record<string, any>;

/** Parse a FIT file buffer and return its per-second records. */
export async function parseFitBuffer(buffer: Buffer | ArrayBuffer): Promise<FitRecord[]> {
	const parser = new FitParser({
		force: true,
		mode: "list",
		speedUnit: "m/s",
		lengthUnit: "m",
		elapsedRecordField: true,
	});

	return new Promise((resolve, reject) => {
		const buf = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;
		parser.parse(buf as Buffer<ArrayBuffer>, (error, data) => {
			if (error) reject(error);
			else resolve((data?.records as FitRecord[] | undefined) ?? []);
		});
	});
}

/** Check whether parsed FIT data contains Stryd developer fields. */
export function hasStrydDeveloperFields(records: FitRecord[]): boolean {
	if (records.length === 0) return false;
	const sample = records.slice(0, 10);
	return sample.some(
		(r) =>
			r[STRYD_FIT_FIELDS.legSpringStiffness] != null ||
			r[STRYD_FIT_FIELDS.formPower] != null ||
			r[STRYD_FIT_FIELDS.stanceTime] != null,
	);
}

/** Check whether parsed FIT data contains Duo bilateral balance fields. */
export function hasBilateralFields(records: FitRecord[]): boolean {
	if (records.length === 0) return false;
	const sample = records.slice(0, 10);
	return sample.some(
		(r) =>
			r[STRYD_FIT_FIELDS.lssBalance] != null ||
			r[STRYD_FIT_FIELDS.gctBalance] != null ||
			r[STRYD_FIT_FIELDS.ilrBalance] != null,
	);
}

/**
 * Convert a balance percentage to asymmetry percentage.
 * Balance is the left foot's share: 50% = symmetric.
 * Asymmetry = |balance - 50| × 2 (so 55% balance = 10% asymmetry).
 */
function balanceToAsymmetry(balanceValues: (number | null | undefined)[]): number | null {
	const valid = balanceValues.filter(
		(v): v is number => v != null && !Number.isNaN(v) && v > 0 && v < 100,
	);
	if (valid.length === 0) return null;
	const avgBalance = valid.reduce((s, v) => s + v, 0) / valid.length;
	return Math.abs(avgBalance - 50) * 2;
}

/**
 * Derive L/R values from a total metric and a balance percentage.
 * Balance is left foot's share: L = total × (balance/100), R = total × (1 - balance/100).
 */
function splitByBalance(
	totalValues: (number | null | undefined)[],
	balanceValues: (number | null | undefined)[],
): { left: number | null; right: number | null } {
	let lSum = 0;
	let rSum = 0;
	let count = 0;

	for (let i = 0; i < totalValues.length; i++) {
		const total = totalValues[i];
		const balance = balanceValues[i];
		if (total != null && total > 0 && balance != null && balance > 0 && balance < 100) {
			lSum += total * (balance / 100);
			rSum += total * (1 - balance / 100);
			count++;
		}
	}

	if (count === 0) return { left: null, right: null };
	return { left: lSum / count, right: rSum / count };
}

/** Compute the mean of a numeric array, ignoring nulls/NaN/zero. */
function validMean(values: (number | null | undefined)[]): number | null {
	const valid = values.filter((v): v is number => v != null && !Number.isNaN(v) && v > 0);
	if (valid.length === 0) return null;
	return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

/** Compute GCT drift: % change from first quartile mean to last quartile mean. */
function computeGctDrift(gctValues: (number | null | undefined)[]): number | null {
	const valid = gctValues.filter((v): v is number => v != null && !Number.isNaN(v) && v > 0);
	if (valid.length < MIN_QUARTILE_SIZE * 4) return null;

	const q = Math.floor(valid.length / 4);
	const q1Mean = validMean(valid.slice(0, q));
	const q4Mean = validMean(valid.slice(-q));

	if (q1Mean == null || q4Mean == null || q1Mean === 0) return null;
	return ((q4Mean - q1Mean) / q1Mean) * 100;
}

/** Compute power:HR drift using windowed ratio comparison. */
function computePowerHrDrift(records: FitRecord[]): number | null {
	// Build 5-minute windows of power:HR ratio
	const windowSize = POWER_HR_WINDOW_SECS;
	const powerField = STRYD_FIT_FIELDS.power;

	const ratios: { elapsed: number; ratio: number }[] = [];
	for (const r of records) {
		const power = r[powerField] ?? r.Power ?? r.power;
		const hr = r.heart_rate;
		if (power != null && power > 0 && hr != null && hr > 60) {
			ratios.push({
				elapsed: r.elapsed_time ?? 0,
				ratio: power / hr,
			});
		}
	}

	if (ratios.length < MIN_RECORDS) return null;

	// Compute windowed averages
	const maxElapsed = ratios[ratios.length - 1].elapsed;
	if (maxElapsed < windowSize * 2) return null;

	const firstWindow = ratios.filter((r) => r.elapsed < windowSize);
	const lastWindow = ratios.filter((r) => r.elapsed > maxElapsed - windowSize);

	if (firstWindow.length < 30 || lastWindow.length < 30) return null;

	const firstMean = firstWindow.reduce((s, r) => s + r.ratio, 0) / firstWindow.length;
	const lastMean = lastWindow.reduce((s, r) => s + r.ratio, 0) / lastWindow.length;

	if (firstMean === 0) return null;

	// Negative drift = HR rising relative to power (worse)
	// We invert so positive = worse (consistent with other drift metrics)
	return ((firstMean - lastMean) / firstMean) * 100;
}

/**
 * Extract VigilMetrics from a parsed Stryd FIT file.
 *
 * @param activityId - Stryd activity ID (string form)
 * @param activityDate - ISO 8601 date (YYYY-MM-DD)
 * @param records - Per-second FIT records with developer fields
 * @param sport - Activity sport type
 * @param strydRpe - RPE from Stryd post-run report (if available)
 * @param strydFeel - Feel from Stryd post-run report (if available)
 * @param surfaceType - Surface from Stryd post-run report (if available)
 * @param icuActivityId - intervals.icu activity ID (if known)
 */
export function extractMetrics(
	activityId: string,
	activityDate: string,
	records: FitRecord[],
	sport: string,
	strydRpe: number | null = null,
	strydFeel: string | null = null,
	surfaceType: string | null = null,
	icuActivityId: string | null = null,
): VigilMetrics | null {
	if (!hasStrydDeveloperFields(records)) return null;
	if (records.length < MIN_RECORDS) return null;

	// Standard and developer field extraction
	const gctValues = records.map((r) => r[STRYD_FIT_FIELDS.stanceTime] as number | null);
	const lssValues = records.map((r) => r[STRYD_FIT_FIELDS.legSpringStiffness] as number | null);
	const fpValues = records.map((r) => r[STRYD_FIT_FIELDS.formPower] as number | null);
	const impactValues = records.map((r) => r[STRYD_FIT_FIELDS.impact] as number | null);
	// vertical_oscillation from FIT is in mm; convert to cm
	const voValues = records.map((r) => {
		const v = r[STRYD_FIT_FIELDS.verticalOscillation] as number | null;
		return v != null ? v / 10 : null;
	});
	const cadValues = records.map((r) => r[STRYD_FIT_FIELDS.cadence] as number | null);
	const powerValues = records.map((r) => (r[STRYD_FIT_FIELDS.power] ?? r.power) as number | null);

	const avgFormPower = validMean(fpValues);
	const avgPower = validMean(powerValues);
	const formPowerRatio =
		avgFormPower != null && avgPower != null && avgPower > 0 ? avgFormPower / avgPower : null;

	// Bilateral: Duo provides balance percentages (left foot share, 50% = symmetric)
	const isDuo = hasBilateralFields(records);
	let lAvgGctMs: number | null = null;
	let rAvgGctMs: number | null = null;
	let lAvgLss: number | null = null;
	let rAvgLss: number | null = null;
	let lAvgVoCm: number | null = null;
	let rAvgVoCm: number | null = null;
	let lAvgIlr: number | null = null;
	let rAvgIlr: number | null = null;
	let gctAsymmetryPct: number | null = null;
	let lssAsymmetryPct: number | null = null;
	let voAsymmetryPct: number | null = null;
	let ilrAsymmetryPct: number | null = null;

	if (isDuo) {
		const gctBalances = records.map((r) => r[STRYD_FIT_FIELDS.gctBalance] as number | null);
		const lssBalances = records.map((r) => r[STRYD_FIT_FIELDS.lssBalance] as number | null);
		const voBalances = records.map((r) => r[STRYD_FIT_FIELDS.voBalance] as number | null);
		const ilrBalances = records.map((r) => r[STRYD_FIT_FIELDS.ilrBalance] as number | null);

		// Derive L/R from total × balance
		const gctSplit = splitByBalance(gctValues, gctBalances);
		lAvgGctMs = gctSplit.left;
		rAvgGctMs = gctSplit.right;

		const lssSplit = splitByBalance(lssValues, lssBalances);
		lAvgLss = lssSplit.left;
		rAvgLss = lssSplit.right;

		const voSplit = splitByBalance(voValues, voBalances);
		lAvgVoCm = voSplit.left;
		rAvgVoCm = voSplit.right;

		const ilrSplit = splitByBalance(impactValues, ilrBalances);
		lAvgIlr = ilrSplit.left;
		rAvgIlr = ilrSplit.right;

		// Asymmetry from balance: |balance - 50| × 2
		gctAsymmetryPct = balanceToAsymmetry(gctBalances);
		lssAsymmetryPct = balanceToAsymmetry(lssBalances);
		voAsymmetryPct = balanceToAsymmetry(voBalances);
		ilrAsymmetryPct = balanceToAsymmetry(ilrBalances);
	}

	return {
		activityId,
		icuActivityId,
		activityDate,
		sport,
		surfaceType,
		avgGctMs: validMean(gctValues),
		avgLss: validMean(lssValues),
		avgFormPower,
		avgIlr: validMean(impactValues),
		avgVoCm: validMean(voValues),
		avgCadence: validMean(cadValues),
		formPowerRatio,
		gctDriftPct: computeGctDrift(gctValues),
		powerHrDrift: computePowerHrDrift(records),
		strydRpe,
		strydFeel,
		lAvgGctMs,
		rAvgGctMs,
		lAvgLss,
		rAvgLss,
		lAvgVoCm,
		rAvgVoCm,
		lAvgIlr,
		rAvgIlr,
		gctAsymmetryPct,
		lssAsymmetryPct,
		voAsymmetryPct,
		ilrAsymmetryPct,
	};
}
