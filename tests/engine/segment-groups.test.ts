import { describe, expect, it } from "vitest";
import { groupPairSegments } from "../../src/engine/segment-groups.js";
import type { WorkoutSegment } from "../../src/engine/types.js";

function seg(
	name: string,
	durationSecs: number,
	powerLow?: number,
	powerHigh?: number,
	target = `${powerLow}-${powerHigh}W`,
): WorkoutSegment {
	return {
		name,
		duration_secs: durationSecs,
		target_description: target,
		target_power_low: powerLow,
		target_power_high: powerHigh,
	};
}

describe("groupPairSegments", () => {
	it("returns all singles when no repeats are present", () => {
		const out = groupPairSegments([
			seg("Warm-up", 300, 200, 229),
			seg("Work", 240, 252, 266),
			seg("Cool-down", 300, 200, 229),
		]);
		expect(out).toHaveLength(3);
		expect(out.every((g) => g.kind === "single")).toBe(true);
	});

	it("collapses a 5x work+recovery fartlek into a single pair group", () => {
		const work = seg("Work", 30, 286, 314);
		const rest = seg("Recovery", 30, 172, 200);
		const segs: WorkoutSegment[] = [
			seg("Warm-up", 300, 200, 229),
			seg("Work", 240, 252, 266),
			seg("Recovery", 90, 200, 229),
			// 5x pair
			work,
			rest,
			work,
			rest,
			work,
			rest,
			work,
			rest,
			work,
			rest,
			seg("Work", 240, 252, 266),
			seg("Recovery", 90, 200, 229),
			seg("Cool-down", 300, 200, 229),
		];

		const out = groupPairSegments(segs);
		// 3 singles (warmup, work, recovery) + 1 pair + 3 singles (work, recovery, cooldown)
		expect(out).toHaveLength(7);
		const pair = out.find((g) => g.kind === "pair");
		expect(pair).toBeDefined();
		if (pair?.kind !== "pair") throw new Error("expected pair");
		expect(pair.repeats).toBe(5);
		expect(pair.work.name).toBe("Work");
		expect(pair.rest.name).toBe("Recovery");
		expect(pair.work.duration_secs).toBe(30);
		expect(pair.rest.duration_secs).toBe(30);
		expect(pair.firstIndex).toBe(3);
	});

	it("does NOT collapse a 3-segment block (Hill Hustle work+rest+sprint)", () => {
		// Hill Hustle-shape: 3 repetitions of [work, rest, sprint].
		const w = seg("Work", 60, 252, 266);
		const r = seg("Recovery", 30, 172, 200);
		const s = seg("Work", 15, 300, 329); // sprint — same NAME "Work" but different power
		const out = groupPairSegments([w, r, s, w, r, s, w, r, s]);
		// Pair detector sees (w,r) followed by (s,w) — segmentsMatch on s vs w
		// fails because power bands differ. No pair collapses; all singles.
		expect(out).toHaveLength(9);
		expect(out.every((g) => g.kind === "single")).toBe(true);
	});

	it("does NOT collapse a single non-repeated pair (n must be >= 2)", () => {
		const out = groupPairSegments([
			seg("Work", 240, 252, 266),
			seg("Recovery", 90, 200, 229),
			seg("Cool-down", 300, 200, 229),
		]);
		expect(out).toHaveLength(3);
		expect(out.every((g) => g.kind === "single")).toBe(true);
	});

	it("does NOT collapse when a segment has zero duration", () => {
		const out = groupPairSegments([
			seg("Work", 0, 286, 314),
			seg("Recovery", 30, 172, 200),
			seg("Work", 0, 286, 314),
			seg("Recovery", 30, 172, 200),
		]);
		expect(out).toHaveLength(4);
		expect(out.every((g) => g.kind === "single")).toBe(true);
	});

	it("preserves the first-index for compliance traffic-light aggregation", () => {
		const work = seg("Work", 30, 286, 314);
		const rest = seg("Recovery", 30, 172, 200);
		const out = groupPairSegments([
			seg("Warm-up", 300, 200, 229),
			work,
			rest,
			work,
			rest,
			work,
			rest,
		]);
		const pair = out.find((g) => g.kind === "pair");
		expect(pair?.kind).toBe("pair");
		if (pair?.kind !== "pair") throw new Error("expected pair");
		expect(pair.firstIndex).toBe(1); // first work segment is at flat index 1
		expect(pair.repeats).toBe(3);
	});
});
