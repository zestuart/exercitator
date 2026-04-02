/**
 * Converts a WorkoutSuggestion into intervals.icu workout description text.
 *
 * Format reference: https://forum.intervals.icu/t/workout-builder-syntax-quick-guide/123701
 *
 * Key syntax rules:
 * - Each step is a line starting with `- `
 * - Duration: `m` for minutes, `s` for seconds (e.g. `5m`, `30s`, `5m30s`)
 * - Distance: `mtr` for metres (NOT `m` — that means minutes), `km` for kilometres
 * - Power: percentage of FTP (e.g. `55-75%`) or watts (e.g. `160-219W`)
 * - HR: percentage with `HR` suffix (e.g. `70% HR`)
 * - Pace: `mm:ss/km Pace` for running, `mm:ss/100mtr Pace` for swimming
 * - Repeats: `Nx` on its own line, blank lines before/after, followed by steps
 * - Free text before duration/target becomes the cue text
 */

import type { PowerContext, WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";

function formatDuration(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = Math.round(secs % 60);
	if (m === 0) return `${s}s`;
	if (s === 0) return `${m}m`;
	return `${m}m${s}s`;
}

function formatRunTarget(seg: WorkoutSegment, power: PowerContext): string {
	// Power targets (running with power source)
	if (
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

	// HR zone fallback
	return formatHrTarget(seg);
}

function formatHrTarget(seg: WorkoutSegment): string {
	if (seg.target_hr_zone != null) {
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

/**
 * Extract distance (in metres) from a swim target_description.
 * Matches patterns like "200m Z2", "100m Z4 on :15 rest 1:31/100m", "300m (100 free...)".
 */
function extractSwimDistance(desc: string): number | null {
	const match = desc.match(/^(\d+)m\b/);
	return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Extract pace from a swim target_description.
 * Matches patterns like "1:53/100m" at the end of the string.
 */
function extractSwimPace(desc: string): string | null {
	const match = desc.match(/(\d+:\d{2})\/100m$/);
	return match ? match[1] : null;
}

/**
 * Extract cue text from a swim target_description.
 * Strips the leading distance and trailing pace, returns the middle as cue text.
 * "200m Z2 on :20 rest 1:53/100m" → "Z2"
 * "300m (100 free/100 kick/100 pull)" → "(100 free/100 kick/100 pull)"
 * "50m drill/swim on :15 rest" → "drill/swim"
 */
function extractSwimCue(desc: string): string {
	let cue = desc;
	// Strip leading distance
	cue = cue.replace(/^\d+m\s*/, "");
	// Strip trailing pace
	cue = cue.replace(/\s*\d+:\d{2}\/100m$/, "");
	// Strip "on :XX rest" — rest is handled separately
	cue = cue.replace(/\s*on\s*:\d+\s*rest\s*/g, " ");
	return cue.trim();
}

/**
 * Format a swim step in intervals.icu syntax.
 * Uses `mtr` for metres (NOT `m` which means minutes).
 */
function formatSwimStep(seg: WorkoutSegment): string {
	const dist = extractSwimDistance(seg.target_description);
	const pace = extractSwimPace(seg.target_description);
	const cue = extractSwimCue(seg.target_description);

	const parts: string[] = [];
	if (cue) parts.push(cue);
	if (dist) {
		parts.push(`${dist}mtr`);
	} else {
		// Fallback: use duration if no distance found
		parts.push(formatDuration(seg.duration_secs));
	}
	if (pace) {
		parts.push(`${pace}/100mtr Pace`);
	} else {
		// No pace — use HR target
		const hr = formatHrTarget(seg);
		if (hr) parts.push(hr);
	}

	return parts.join(" ");
}

export function buildIntervalsDescription(suggestion: WorkoutSuggestion): string {
	const lines: string[] = [];
	const isSwim = suggestion.sport === "Swim";

	for (const seg of suggestion.segments) {
		if (isSwim) {
			if (seg.repeats && seg.repeats > 1) {
				// Repeat set — blank line before, Nx, steps, blank line after
				lines.push("");
				lines.push(`${seg.repeats}x`);
				lines.push(`- ${formatSwimStep(seg)}`);
				if (seg.rest_duration_secs) {
					lines.push(`- ${formatDuration(seg.rest_duration_secs)} 50%`);
				}
				lines.push("");
			} else {
				lines.push(`- ${seg.name} ${formatSwimStep(seg)}`);
				if (seg.rest_duration_secs) {
					lines.push(`- ${formatDuration(seg.rest_duration_secs)} 50%`);
				}
			}
		} else {
			// Run: section header + structured power/HR targets
			lines.push(seg.name);

			const target = formatRunTarget(seg, suggestion.power_context);

			if (seg.repeats && seg.repeats > 1 && seg.work_duration_secs) {
				lines.push("");
				lines.push(`${seg.repeats}x`);
				const workTarget = target || "";
				lines.push(`- ${formatDuration(seg.work_duration_secs)} ${workTarget}`.trimEnd());
				if (seg.rest_duration_secs) {
					lines.push(`- ${formatDuration(seg.rest_duration_secs)} 50%`);
				}
				lines.push("");
			} else {
				lines.push(`- ${formatDuration(seg.duration_secs)} ${target}`.trimEnd());
			}
		}
	}

	// Clean up: remove leading/trailing blank lines, collapse multiple blank lines
	return lines
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "")
		.replace(/\n{3,}/g, "\n\n");
}
