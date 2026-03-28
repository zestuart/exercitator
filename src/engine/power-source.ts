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

const RUN_TYPES = ["Run", "VirtualRun", "TrailRun", "Treadmill"];

function isRun(type: string): boolean {
	return RUN_TYPES.includes(type);
}

/** Stryd CIQ developer fields present (Garmin Connect IQ plugin). */
export function hasStrydStreams(activity: ActivitySummary): boolean {
	if (!activity.stream_types) return false;
	return STRYD_STREAM_MARKERS.some((marker) => activity.stream_types?.includes(marker));
}

/** Stryd app recording on a non-Garmin device (e.g. Apple Watch via HealthFit).
 *  The power field is lowercase "power" but the power IS from Stryd — no correction needed. */
export function isStrydNativeRecording(activity: ActivitySummary): boolean {
	return (activity.external_id?.includes("Stryd") ?? false) && isNonGarminDevice(activity);
}

function isNonGarminDevice(activity: ActivitySummary): boolean {
	if (!activity.device_name) return false;
	return APPLE_WATCH_PATTERN.test(activity.device_name);
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
