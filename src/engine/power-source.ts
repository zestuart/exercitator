/**
 * Detects which running power ecosystem the athlete uses and ensures all
 * zone derivations, load calculations, and workout targets are expressed
 * in that ecosystem's scale.
 */

import type { ActivitySummary, PowerContext, PowerSource } from "./types.js";

const STRYD_STREAM_MARKERS = ["StrydLSS", "StrydFormPower", "StrydILR"] as const;
const STRYD_POWER_FIELD = "Power";
const GARMIN_POWER_FIELD = "power";
const DEFAULT_GARMIN_TO_STRYD_FACTOR = 0.87;
const APPLE_WATCH_PATTERN = /^Watch\d/;
// "SUUNTO Suunto Vertical 2", "SUUNTO Ambit3", etc. Suunto watches pair with
// the Stryd pod over BLE and pass through Stryd power, but the FIT export
// carries an opaque UUID `external_id` (no "stryd" substring) and only a
// subset of Stryd developer fields (`StrydStepLength` rather than the CIQ
// triplet StrydLSS/FormPower/ILR). Treated as non-Garmin so the engine
// classifies the activity as Stryd-native rather than falling through to
// the "Garmin active + athlete has Stryd" correction-factor branch.
const SUUNTO_PATTERN = /^SUUNTO\b/i;

const RUN_TYPES = ["Run", "VirtualRun", "TrailRun", "Treadmill"];

function isRun(type: string): boolean {
	return RUN_TYPES.includes(type);
}

/** Stryd CIQ developer fields present (Garmin Connect IQ plugin). */
export function hasStrydStreams(activity: ActivitySummary): boolean {
	if (!activity.stream_types) return false;
	return STRYD_STREAM_MARKERS.some((marker) => activity.stream_types?.includes(marker));
}

/** Stryd-native recording: Apple Watch + Stryd app, Suunto + Stryd pod, or
 *  enriched Stryd FIT upload. Power field is lowercase "power" but the power
 *  comes from Stryd — no correction needed.
 *
 *  Per-device heuristic:
 *    - STRYD device upload: trust the "stryd" external_id substring.
 *    - Apple Watch: rely on the Stryd-app filename convention
 *      (`*-Stryd.fit`). Stream-only heuristics would mis-classify
 *      Apple-Health-relayed activities that carry Stryd developer fields
 *      but came in via the native HealthFit pipeline (the Stryd FIT
 *      enricher pipeline relies on this distinction).
 *    - Suunto: `external_id` is an opaque UUID, so the filename heuristic
 *      can't fire — fall back to "any Stryd developer field in the stream".
 */
export function isStrydNativeRecording(activity: ActivitySummary): boolean {
	if (isStrydDevice(activity)) {
		return activity.external_id?.toLowerCase().includes("stryd") ?? false;
	}
	if (!activity.device_name) return false;
	if (APPLE_WATCH_PATTERN.test(activity.device_name)) {
		return activity.external_id?.toLowerCase().includes("stryd") ?? false;
	}
	if (SUUNTO_PATTERN.test(activity.device_name)) {
		if (activity.external_id?.toLowerCase().includes("stryd")) return true;
		return hasAnyStrydStream(activity);
	}
	return false;
}

function isNonGarminDevice(activity: ActivitySummary): boolean {
	if (!activity.device_name) return false;
	return (
		APPLE_WATCH_PATTERN.test(activity.device_name) || SUUNTO_PATTERN.test(activity.device_name)
	);
}

function isStrydDevice(activity: ActivitySummary): boolean {
	return activity.device_name === "STRYD";
}

/** Any Stryd developer field present in stream_types. Broader than
 *  `hasStrydStreams` (which requires CIQ-specific markers); used to detect
 *  Stryd-pod-paired non-Garmin recordings where only `StrydStepLength` shows up. */
function hasAnyStrydStream(activity: ActivitySummary): boolean {
	if (!activity.stream_types) return false;
	return activity.stream_types.some((s) => s.startsWith("Stryd"));
}

/**
 * Detect the athlete's primary power source from recent run activities.
 *
 * Fallback chain: Stryd → Garmin → HR-only.
 */
export function detectPowerSource(activities: ActivitySummary[]): PowerContext {
	const warnings: string[] = [];

	// Get the most recent 5 run activities
	const recentRuns = activities
		.filter((a) => isRun(a.type))
		.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local))
		.slice(0, 5);

	if (recentRuns.length === 0) {
		return {
			source: "none",
			ftp: 0,
			rolling_ftp: null,
			correction_factor: 1.0,
			confidence: "low",
			warnings: ["No recent run activities — HR-only prescription"],
		};
	}

	// Check if any recent runs have Stryd streams
	const athleteHasStryd = recentRuns.some(hasStrydStreams);

	// Check the most recent run's active power field
	const mostRecentRun = recentRuns[0];
	const activePowerField = mostRecentRun.power_field;

	// Determine FTP reference
	const rawFtp = mostRecentRun.icu_rolling_ftp ?? mostRecentRun.icu_ftp;

	// No power data at all
	if (!activePowerField && !athleteHasStryd) {
		return {
			source: "none",
			ftp: 0,
			rolling_ftp: null,
			correction_factor: 1.0,
			confidence: "low",
			warnings: ["No power data available — HR-only prescription"],
		};
	}

	// Stryd is active power source (capital P — CIQ developer field on Garmin)
	if (activePowerField === STRYD_POWER_FIELD && athleteHasStryd) {
		return {
			source: "stryd",
			ftp: rawFtp ?? 0,
			rolling_ftp: mostRecentRun.icu_rolling_ftp,
			correction_factor: 1.0,
			confidence: "high",
			warnings,
		};
	}

	// Stryd app on non-Garmin device (e.g. Apple Watch via HealthFit).
	// power_field is lowercase "power" but IS Stryd power — no correction needed.
	if (activePowerField === GARMIN_POWER_FIELD && isStrydNativeRecording(mostRecentRun)) {
		return {
			source: "stryd",
			ftp: rawFtp ?? 0,
			rolling_ftp: mostRecentRun.icu_rolling_ftp,
			correction_factor: 1.0,
			confidence: "high",
			warnings,
		};
	}

	// Non-Garmin device recording native power without a Stryd pod (Apple Watch
	// wrist accelerometer or Suunto's built-in power estimate). power_field is
	// lowercase "power" just like Garmin, but the value isn't Stryd-derived.
	// Look back to find the athlete's actual Stryd power context.
	if (
		activePowerField === GARMIN_POWER_FIELD &&
		isNonGarminDevice(mostRecentRun) &&
		!isStrydNativeRecording(mostRecentRun)
	) {
		const strydRun = recentRuns.find((r) => hasStrydStreams(r) || isStrydNativeRecording(r));
		if (strydRun) {
			const strydFtp = strydRun.icu_rolling_ftp ?? strydRun.icu_ftp;
			warnings.push(
				`Most recent run on ${mostRecentRun.device_name} without Stryd pod \u2014 power context from previous Stryd run`,
			);
			return {
				source: "stryd",
				ftp: strydFtp ?? 0,
				rolling_ftp: strydRun.icu_rolling_ftp,
				correction_factor: 1.0,
				confidence: "low",
				warnings,
			};
		}
		// No Stryd history — wrist/watch-native power is unreliable for zone targets
		warnings.push(
			`Non-Garmin native power on ${mostRecentRun.device_name} \u2014 no Stryd baseline available, using HR-only prescription`,
		);
		return {
			source: "none",
			ftp: 0,
			rolling_ftp: null,
			correction_factor: 1.0,
			confidence: "low",
			warnings,
		};
	}

	// Garmin is active but athlete has Stryd (forgot to switch)
	if (activePowerField === GARMIN_POWER_FIELD && athleteHasStryd) {
		const garminFtp = rawFtp ?? 0;
		const strydFtp = Math.round(garminFtp * DEFAULT_GARMIN_TO_STRYD_FACTOR);
		warnings.push(
			"Power field is set to Garmin native but Stryd is connected. " +
				"Zone targets converted using estimated 0.87 correction factor. " +
				"Consider switching to Stryd as primary power field in intervals.icu.",
		);
		return {
			source: "stryd",
			ftp: strydFtp,
			rolling_ftp: mostRecentRun.icu_rolling_ftp
				? Math.round(mostRecentRun.icu_rolling_ftp * DEFAULT_GARMIN_TO_STRYD_FACTOR)
				: null,
			correction_factor: DEFAULT_GARMIN_TO_STRYD_FACTOR,
			confidence: "low",
			warnings,
		};
	}

	// Garmin only, no Stryd
	if (activePowerField === GARMIN_POWER_FIELD) {
		return {
			source: "garmin",
			ftp: rawFtp ?? 0,
			rolling_ftp: mostRecentRun.icu_rolling_ftp,
			correction_factor: 1.0,
			confidence: "high",
			warnings,
		};
	}

	// Edge case: has Stryd streams but no power_field set
	if (athleteHasStryd) {
		return {
			source: "stryd",
			ftp: rawFtp ?? 0,
			rolling_ftp: mostRecentRun.icu_rolling_ftp,
			correction_factor: 1.0,
			confidence: "low",
			warnings: ["Power field not explicitly set but Stryd streams detected"],
		};
	}

	return {
		source: "none",
		ftp: 0,
		rolling_ftp: null,
		correction_factor: 1.0,
		confidence: "low",
		warnings: ["Unable to determine power source — HR-only prescription"],
	};
}

/**
 * The athlete's intervals.icu run FTP — the most recent run's rolling FTP
 * (falling back to the set FTP). intervals.icu derives this from whatever power
 * the run recorded, so for a Garmin-powered run it is a genuine Garmin-scale
 * FTP — used directly as the reference in Garmin power mode (no scaling).
 */
export function intervalsRunFtp(activities: ActivitySummary[]): {
	ftp: number;
	rolling_ftp: number | null;
} {
	const recentRun = activities
		.filter((a) => isRun(a.type))
		.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local))[0];
	if (!recentRun) return { ftp: 0, rolling_ftp: null };
	return {
		ftp: recentRun.icu_rolling_ftp ?? recentRun.icu_ftp ?? 0,
		rolling_ftp: recentRun.icu_rolling_ftp ?? null,
	};
}

/**
 * Resolve the run FTP reference from the *effective* power source (a manual
 * Praescriptor override wins over the rolling-window auto-detection, which flips
 * as runs age out of the 5-run window). Each source draws FTP from where that
 * ecosystem's value actually lives — no cross-scale approximation:
 *   - "garmin" → intervals.icu FTP (intervals derives it from Garmin power).
 *   - "stryd"  → the Stryd critical-power API (foot-pod authoritative).
 *   - "none"   → HR-only (unchanged detection result).
 *
 * `strydCp` is the Stryd critical power in watts (or null when unavailable).
 * `override` is the manual pin ("stryd"/"garmin"), or null for auto.
 */
export function resolveRunFtp(
	detected: PowerContext,
	override: "stryd" | "garmin" | null,
	strydCp: number | null,
	activities: ActivitySummary[],
): PowerContext {
	const effective = override ?? detected.source;
	const manual = override != null;

	if (effective === "garmin") {
		const { ftp, rolling_ftp } = intervalsRunFtp(activities);
		const warnings =
			ftp > 0
				? manual
					? [
							"Power source manually set to Garmin — FTP from intervals.icu (derived from Garmin power).",
						]
					: detected.warnings
				: manual
					? [
							"Power source manually set to Garmin, but no intervals.icu FTP available — HR-only run targets.",
						]
					: [...detected.warnings, "No intervals.icu FTP for Garmin — HR-only run targets."];
		return {
			source: "garmin",
			ftp,
			rolling_ftp,
			correction_factor: 1.0,
			confidence: ftp > 0 ? (manual ? "high" : detected.confidence) : "low",
			warnings,
		};
	}

	// Stryd (explicit, auto-detected non-Garmin, or an undetected source for an
	// athlete who nonetheless has a Stryd CP): anchor to the Stryd critical power.
	if (strydCp != null && strydCp > 0) {
		const cp = Math.round(strydCp);
		const wasNone = detected.source === "none";
		return {
			source: "stryd",
			ftp: cp,
			rolling_ftp: cp,
			correction_factor: 1.0,
			confidence: manual ? "high" : wasNone ? "low" : detected.confidence,
			warnings: manual
				? ["Power source manually set to Stryd — FTP from Stryd critical power."]
				: wasNone
					? [
							...detected.warnings,
							"FTP set from Stryd critical power API — no recent Stryd run data.",
						]
					: detected.warnings,
		};
	}

	// Forced Stryd but the CP API returned nothing — relabel, keep detected FTP.
	if (override === "stryd") {
		return {
			...detected,
			source: "stryd",
			correction_factor: 1.0,
			warnings: [
				"Power source manually set to Stryd, but no Stryd critical power available — using detected FTP.",
			],
		};
	}

	return detected;
}

/**
 * Get the appropriate load value for an activity given the power context.
 * Falls back to hr_load when the activity lacks the athlete's preferred power source.
 */
export function getActivityLoad(activity: ActivitySummary, powerContext: PowerContext): number {
	if (powerContext.source === "none") {
		return activity.hr_load ?? activity.icu_training_load;
	}

	// If the activity has Stryd data and we're in Stryd mode, use power_load.
	// Covers both CIQ (Garmin) and native (Apple Watch) Stryd recordings.
	if (
		powerContext.source === "stryd" &&
		(hasStrydStreams(activity) || isStrydNativeRecording(activity)) &&
		activity.power_load != null
	) {
		return activity.power_load;
	}

	// If source is garmin and activity has power_load, use it
	if (powerContext.source === "garmin" && activity.power_load != null) {
		return activity.power_load;
	}

	// Fallback: use hr_load for activities without the preferred power source
	return activity.hr_load ?? activity.icu_training_load;
}
