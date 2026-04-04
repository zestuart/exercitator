/**
 * Converts a WorkoutSuggestion into FORM swim goggles Script text.
 *
 * FORM's Script parser is NLP-based and works best with simple, clean notation:
 *   [reps] x [distance] [stroke] [effort] [rest]
 *
 * No zone numbers, pace targets, or HR percentages — these confuse the parser.
 * Set headers (Warm-Up, Main, Warm-Down) on their own lines.
 */

import type { WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";

/** Map HR zone (1–5) to FORM effort level. */
function zoneToEffort(zone: number | undefined): string {
	switch (zone) {
		case 1:
			return "Easy";
		case 2:
			return "Mod";
		case 3:
			return "Strong";
		case 4:
			return "Fast";
		case 5:
			return "Max";
		default:
			return "Mod";
	}
}

/** Extract distance in metres from target_description (e.g. "200m easy free" → 200). */
function extractDistance(desc: string): number | null {
	const match = desc.match(/^(\d+)m\b/);
	return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Infer FORM stroke abbreviation from target_description and segment name.
 * Maps common swim terms to FORM's two-letter codes.
 */
function inferStroke(desc: string, name: string): string {
	const lower = `${desc} ${name}`.toLowerCase();
	if (lower.includes("kick")) return "K";
	if (lower.includes("pull")) return "P";
	if (lower.includes("drill")) return "DCH";
	if (lower.includes("im") || lower.includes("medley")) return "IM";
	if (lower.includes("back")) return "BK";
	if (lower.includes("breast")) return "BR";
	if (lower.includes("fly") || lower.includes("butterfly")) return "FL";
	if (lower.includes("choice")) return "CH";
	// Default to freestyle
	return "FR";
}

/** Format rest duration as "N sec rest". */
function formatRest(secs: number): string {
	return `${secs} sec rest`;
}

/** Map a segment name to a FORM set type. */
function toSetType(name: string): "Warm-Up" | "Main" | "Warm-Down" {
	const lower = name.toLowerCase();
	if (lower.includes("warm-up") || lower.includes("warmup") || lower.includes("warm up")) {
		return "Warm-Up";
	}
	if (
		lower.includes("cool-down") ||
		lower.includes("cooldown") ||
		lower.includes("cool down") ||
		lower.includes("warm-down") ||
		lower.includes("warmdown")
	) {
		return "Warm-Down";
	}
	return "Main";
}

function formatSegment(seg: WorkoutSegment): string {
	const dist = extractDistance(seg.target_description);
	const stroke = inferStroke(seg.target_description, seg.name);
	const effort = zoneToEffort(seg.target_hr_zone);
	const rest = seg.rest_duration_secs ? ` ${formatRest(seg.rest_duration_secs)}` : "";

	if (seg.repeats && seg.repeats > 1) {
		// For repeats, extract per-rep distance from target_description
		const repDist = dist ?? 50;
		return `${seg.repeats} x ${repDist} ${stroke} ${effort}${rest}`;
	}

	const setDist = dist ?? 100;
	return `${setDist} ${stroke} ${effort}${rest}`;
}

export function buildFormDescription(suggestion: WorkoutSuggestion): string {
	// Group segments by FORM set type, preserving order
	const groups: { type: "Warm-Up" | "Main" | "Warm-Down"; lines: string[] }[] = [];
	let currentType: string | null = null;

	for (const seg of suggestion.segments) {
		const setType = toSetType(seg.name);
		if (setType !== currentType) {
			groups.push({ type: setType, lines: [] });
			currentType = setType;
		}
		groups[groups.length - 1].lines.push(formatSegment(seg));
	}

	// Ensure we have at least Warm-Up, Main, Warm-Down
	// If no warm-up, the first group becomes warm-up
	// If no warm-down, the last group becomes warm-down
	if (groups.length > 0 && groups[0].type !== "Warm-Up") {
		groups[0].type = "Warm-Up";
	}
	if (groups.length > 1 && groups[groups.length - 1].type !== "Warm-Down") {
		groups[groups.length - 1].type = "Warm-Down";
	}

	const sections: string[] = [];
	for (const group of groups) {
		sections.push(group.type);
		sections.push(...group.lines);
		sections.push("");
	}

	// Remove trailing blank line
	while (sections.length > 0 && sections[sections.length - 1] === "") {
		sections.pop();
	}

	return sections.join("\n");
}
