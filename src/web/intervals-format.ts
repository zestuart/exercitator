/**
 * Converts a WorkoutSuggestion into intervals.icu workout description text.
 *
 * Format reference: https://forum.intervals.icu/t/workout-builder-syntax-quick-guide/123701
 *
 * Rules:
 * - Each step is a line starting with `- `
 * - Duration: `m` for minutes, `s` for seconds (e.g. `5m`, `30s`, `5m30s`)
 * - Power: percentage of FTP (e.g. `55-75%`) or watts (e.g. `160-219W`)
 * - HR: percentage with `HR` suffix (e.g. `70% HR`)
 * - Pace: `mm:ss/km Pace` for running, `mm:ss/100m Pace` for swimming
 * - Repeats: `Nx` on its own line, followed by indented steps
 * - Free text before targets becomes the step name/cue
 * - Section headers are plain text lines (no `- ` prefix)
 */

import type { PowerContext, WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";

function formatDuration(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = Math.round(secs % 60);
	if (m === 0) return `${s}s`;
	if (s === 0) return `${m}m`;
	return `${m}m${s}s`;
}

function formatTarget(seg: WorkoutSegment, sport: "Run" | "Swim", power: PowerContext): string {
	// Power targets (running with power source)
	if (
		sport === "Run" &&
		power.source !== "none" &&
		power.ftp > 0 &&
		seg.target_power_low != null &&
		seg.target_power_high != null
	) {
		const lowPct = Math.round((seg.target_power_low / power.ftp) * 100);
		const highPct = Math.round((seg.target_power_high / power.ftp) * 100);
		if (lowPct === 0) return `${highPct}%`;
		return `${lowPct}-${highPct}%`;
	}

	// Pace targets (swimming or running without power)
	if (seg.target_pace_secs_low != null && seg.target_pace_secs_high != null) {
		const unit = sport === "Swim" ? "100m" : "km";
		const lo = formatPace(seg.target_pace_secs_low);
		const hi = formatPace(seg.target_pace_secs_high);
		return `${lo}-${hi}/${unit} Pace`;
	}

	// HR zone fallback
	if (seg.target_hr_zone != null) {
		// Map zone number to approximate % — intervals.icu uses % of LTHR
		const zoneToLthrPct: Record<number, [number, number]> = {
			1: [50, 72],
			2: [72, 82],
			3: [82, 89],
			4: [89, 96],
			5: [96, 110],
		};
		const range = zoneToLthrPct[seg.target_hr_zone];
		if (range) return `${range[0]}-${range[1]}% HR`;
		return `Z${seg.target_hr_zone} HR`;
	}

	return "";
}

function formatPace(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = Math.round(secs % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export function buildIntervalsDescription(suggestion: WorkoutSuggestion): string {
	const lines: string[] = [];
	const isSwim = suggestion.sport === "Swim";

	for (const seg of suggestion.segments) {
		// Section header
		lines.push(seg.name);

		if (isSwim) {
			// Swim: use target_description directly — it contains distance + pace info
			// that is more meaningful for swimmers than time-based durations.
			if (seg.repeats && seg.repeats > 1) {
				lines.push(`${seg.repeats}x`);
				lines.push(`- ${seg.target_description}`);
				if (seg.rest_duration_secs) {
					lines.push(`- ${formatDuration(seg.rest_duration_secs)} rest`);
				}
			} else {
				lines.push(`- ${seg.target_description}`);
			}
		} else {
			// Run: use structured power/HR targets
			const target = formatTarget(seg, suggestion.sport, suggestion.power_context);

			if (seg.repeats && seg.repeats > 1 && seg.work_duration_secs) {
				lines.push(`${seg.repeats}x`);
				const workTarget = target || "";
				lines.push(`- ${formatDuration(seg.work_duration_secs)} ${workTarget}`.trimEnd());
				if (seg.rest_duration_secs) {
					lines.push(`- ${formatDuration(seg.rest_duration_secs)} rest`);
				}
			} else {
				lines.push(`- ${formatDuration(seg.duration_secs)} ${target}`.trimEnd());
			}
		}
	}

	return lines.join("\n");
}
