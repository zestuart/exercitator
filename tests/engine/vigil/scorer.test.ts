import { describe, expect, it } from "vitest";
import { scoreDeviations } from "../../../src/engine/vigil/scorer.js";
import type { VigilBaseline } from "../../../src/engine/vigil/types.js";

function makeBaseline(overrides: Partial<VigilBaseline> = {}): VigilBaseline {
	return {
		athleteId: "0",
		sport: "Run",
		metric: "avg_gct_ms",
		computedAt: "2026-03-28T12:00:00Z",
		mean30d: 235,
		stddev30d: 8,
		mean7d: 235,
		sampleCount30d: 12,
		sampleCount7d: 3,
		...overrides,
	};
}

describe("scoreDeviations", () => {
	it("returns severity 0 when no deviations", () => {
		const baselines = [
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 235, stddev30d: 8 }),
			makeBaseline({ metric: "avg_lss", mean30d: 10.5, mean7d: 10.5, stddev30d: 0.5 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(0);
		expect(alert.flags.length).toBe(0);
	});

	it("returns severity 0 for single metric at 1.5σ (below multi-metric threshold)", () => {
		const baselines = [
			// GCT at +2.0σ — one metric alone isn't enough for severity 1
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 251, stddev30d: 8 }),
			makeBaseline({ metric: "avg_lss", mean30d: 10.5, mean7d: 10.5, stddev30d: 0.5 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(0);
	});

	it("returns severity 1 (Watch) for 2 metrics at >1.5σ", () => {
		const baselines = [
			// GCT +1.8σ (weight 1.0) → concern 1.8
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 249.4, stddev30d: 8 }),
			// Drift +2.0σ (weight 1.0) → concern 2.0
			makeBaseline({ metric: "gct_drift_pct", mean30d: 3.0, mean7d: 7.0, stddev30d: 2.0 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(1);
		expect(alert.flags.length).toBe(2);
	});

	it("returns severity 2 (Caution) for 2 metrics at >2.0σ", () => {
		const baselines = [
			// GCT +2.5σ → concern 2.5
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 255, stddev30d: 8 }),
			// Drift +2.5σ → concern 2.5
			makeBaseline({ metric: "gct_drift_pct", mean30d: 3.0, mean7d: 8.0, stddev30d: 2.0 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(2);
	});

	it("returns severity 3 (Alert) for 3 metrics at >2.0σ", () => {
		const baselines = [
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 255, stddev30d: 8 }),
			makeBaseline({ metric: "gct_drift_pct", mean30d: 3.0, mean7d: 8.0, stddev30d: 2.0 }),
			// LSS decreasing by 2.5σ (worse when lower) → concern 2.5
			makeBaseline({ metric: "avg_lss", mean30d: 10.5, mean7d: 9.25, stddev30d: 0.5 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(3);
	});

	it("returns severity 3 for any single metric at >3.0σ", () => {
		const baselines = [
			// GCT +3.5σ → concern 3.5 (> 3.0 threshold)
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 263, stddev30d: 8 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(3);
	});

	it("applies ILR weight (0.5) — dampens false positives", () => {
		const baselines = [
			// ILR at raw +3.2σ, weighted = 3.2 × 0.5 = 1.6 → just above 1.5 threshold
			makeBaseline({ metric: "avg_ilr", mean30d: 12.0, mean7d: 15.2, stddev30d: 1.0 }),
			// GCT at +1.8σ → concern 1.8
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 249.4, stddev30d: 8 }),
		];

		const alert = scoreDeviations(baselines);
		// ILR weighted concern = 1.6 — above 1.5 threshold
		// GCT concern = 1.8 — above threshold
		// Two above 1.5 → severity 1
		expect(alert.severity).toBe(1);
	});

	it("ILR alone at high z-score doesn't trigger severity 3 due to weight", () => {
		const baselines = [
			// ILR at raw +7.0σ, weighted = 3.5σ — would be sev 3 at weight 1.0
			// But weighted concern = 7.0 × 0.5 = 3.5 — only 1 metric above 3.0
			// Still severity 3 because above30 >= 1
			makeBaseline({ metric: "avg_ilr", mean30d: 12.0, mean7d: 19.0, stddev30d: 1.0 }),
		];

		const alert = scoreDeviations(baselines);
		// Single metric above 3.0 weighted → severity 3
		expect(alert.severity).toBe(3);
	});

	it("applies bilateral boost: severity 1 → 2 when asymmetry flagged", () => {
		const baselines = [
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 249.4, stddev30d: 8 }),
			// Asymmetry +2.0σ (weight 1.0) → concern 2.0
			makeBaseline({ metric: "gct_asymmetry_pct", mean30d: 3.0, mean7d: 7.0, stddev30d: 2.0 }),
		];

		const alert = scoreDeviations(baselines);
		// Base: 2 metrics > 1.5σ → severity 1. Bilateral boost → severity 2
		expect(alert.severity).toBe(2);
	});

	it("bilateral boost caps at severity 3", () => {
		const baselines = [
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 255, stddev30d: 8 }),
			makeBaseline({ metric: "gct_drift_pct", mean30d: 3.0, mean7d: 8.0, stddev30d: 2.0 }),
			makeBaseline({ metric: "gct_asymmetry_pct", mean30d: 3.0, mean7d: 8.0, stddev30d: 2.0 }),
			makeBaseline({ metric: "avg_lss", mean30d: 10.5, mean7d: 9.25, stddev30d: 0.5 }),
		];

		const alert = scoreDeviations(baselines);
		// Already severity 3 from 3+ metrics > 2σ; bilateral boost doesn't push to 4
		expect(alert.severity).toBe(3);
	});

	it("skips baselines with null mean7d", () => {
		const baselines = [
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: null, stddev30d: 8 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(0);
		expect(alert.flags.length).toBe(0);
	});

	it("skips baselines with zero stddev", () => {
		const baselines = [
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 250, stddev30d: 0 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(0);
	});

	it("LSS direction: decrease = worsening", () => {
		const baselines = [
			// LSS dropped by 2.5σ → concern = -(-2.5) × 1.0 = 2.5 (worsening)
			makeBaseline({ metric: "avg_lss", mean30d: 10.5, mean7d: 9.25, stddev30d: 0.5 }),
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 255, stddev30d: 8 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.severity).toBe(2);

		const lssFlag = alert.flags.find((f) => f.metric === "avg_lss");
		expect(lssFlag?.direction).toBe("worsening");
		expect(lssFlag?.zScore).toBeLessThan(0); // raw z is negative
		expect(lssFlag?.concernScore).toBeGreaterThan(0); // but concern is positive
	});

	it("builds human-readable summary", () => {
		const baselines = [
			makeBaseline({ metric: "avg_gct_ms", mean30d: 235, mean7d: 255, stddev30d: 8 }),
			makeBaseline({ metric: "gct_drift_pct", mean30d: 3.0, mean7d: 8.0, stddev30d: 2.0 }),
		];

		const alert = scoreDeviations(baselines);
		expect(alert.summary).toContain("Caution");
		expect(alert.summary).toContain("avg_gct_ms");
		expect(alert.recommendation).toContain("downshifted");
	});
});
