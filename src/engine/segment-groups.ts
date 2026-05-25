/**
 * Detect consecutive (A, B, A, B, …) pair-loops in a flattened segment list
 * and group them so consumers can show "5× repeats / Work … / Recovery …"
 * instead of 10 individual rows. Pure — no I/O.
 *
 * A pair is detected when:
 *   - two consecutive segments (A, B) both have non-zero duration
 *   - they appear at least twice in a row (so n ≥ 2)
 *   - each repetition is byte-equal on name + duration + power bands +
 *     target_description (HR zone too if set)
 *
 * The detector is conservative: any field mismatch breaks the pair. This
 * means Hill Hustle's `[work, rest, sprint]` 3-segment blocks never
 * collapse (sprint differs from work in power), but Dash & Dine's fartlek
 * `[work, rest]` × 5 collapses cleanly.
 *
 * Lives under `engine/` (not `web/` or `api/`) so both presentation layers
 * can consume it without crossing layer boundaries.
 */

import type { WorkoutSegment } from "./types.js";

export type SegmentGroup =
	| { kind: "single"; seg: WorkoutSegment; index: number }
	| {
			kind: "pair";
			work: WorkoutSegment;
			rest: WorkoutSegment;
			repeats: number;
			firstIndex: number;
	  };

function segmentsMatch(a: WorkoutSegment, b: WorkoutSegment): boolean {
	return (
		a.name === b.name &&
		a.duration_secs === b.duration_secs &&
		a.target_description === b.target_description &&
		a.target_power_low === b.target_power_low &&
		a.target_power_high === b.target_power_high &&
		a.target_hr_zone === b.target_hr_zone
	);
}

export function groupPairSegments(segments: WorkoutSegment[]): SegmentGroup[] {
	const groups: SegmentGroup[] = [];
	let i = 0;
	while (i < segments.length) {
		const a = segments[i];
		const b = segments[i + 1];
		// A pair requires two non-zero-duration consecutive segments, and at
		// least one further pair following.
		if (
			b !== undefined &&
			a.duration_secs > 0 &&
			b.duration_secs > 0 &&
			i + 3 < segments.length &&
			segmentsMatch(a, segments[i + 2]) &&
			segmentsMatch(b, segments[i + 3])
		) {
			let n = 2;
			while (
				i + 2 * n + 1 < segments.length &&
				segmentsMatch(a, segments[i + 2 * n]) &&
				segmentsMatch(b, segments[i + 2 * n + 1])
			) {
				n++;
			}
			groups.push({ kind: "pair", work: a, rest: b, repeats: n, firstIndex: i });
			i += 2 * n;
			continue;
		}
		groups.push({ kind: "single", seg: a, index: i });
		i++;
	}
	return groups;
}
