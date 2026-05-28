import { describe, expect, it } from "vitest";
import {
	generateInvocations,
	plainQuiesMessage,
	quiesInvocation,
} from "../../src/web/invocations.js";

describe("generateInvocations", () => {
	it("returns static fallback when no API key is set", async () => {
		// ANTHROPIC_API_KEY is not set in test environment
		const result = await generateInvocations("Run", "base", 60, []);

		expect(result.opening).toBeTruthy();
		expect(result.closing).toBeTruthy();
		expect(result.rationale_header).toBeTruthy();
	});

	it("references Diana for running invocations", async () => {
		const result = await generateInvocations("Run", "tempo", 70, []);
		expect(result.opening).toContain("Diana");
	});

	it("references Amphitrite for swimming invocations", async () => {
		const result = await generateInvocations("Swim", "base", 55, []);
		expect(result.opening).toContain("Amphitrite");
	});

	it("references Apollo in closing blessing", async () => {
		const result = await generateInvocations("Run", "intervals", 80, []);
		expect(result.closing).toContain("Apollo");
	});

	it("references Minerva in rationale header", async () => {
		const result = await generateInvocations("Swim", "recovery", 30, []);
		expect(result.rationale_header).toContain("Minerva");
	});

	it("returns non-empty strings for all fields", async () => {
		const result = await generateInvocations("Run", "rest", 15, ["HRV below baseline"]);

		expect(result.opening.length).toBeGreaterThan(10);
		expect(result.closing.length).toBeGreaterThan(10);
		expect(result.rationale_header.length).toBeGreaterThan(5);
	});
});

describe("quiesInvocation", () => {
	it("references Quies and the alternate sport patron in the static fallback", async () => {
		const result = await quiesInvocation("Run", "Swim");
		expect(result.opening).toContain("Quies");
		expect(result.opening).toContain("Diana");
		expect(result.opening).toContain("Amphitrite");
		expect(result.rationale_header).toContain("Quies");
	});

	it("does not beckon an alternate when both sports trained today", async () => {
		const result = await quiesInvocation("Run", null);
		expect(result.opening).toContain("Quies");
		expect(result.opening).toContain("Rest");
		expect(result.opening).not.toMatch(/Seek (Diana|Amphitrite)/);
	});

	it("references Apollo in the closing", async () => {
		const result = await quiesInvocation("Swim", "Run");
		expect(result.closing).toContain("Apollo");
	});
});

describe("plainQuiesMessage", () => {
	it("uses everyday language without any deity name (Pam path)", () => {
		const result = plainQuiesMessage("Run", "Swim");
		expect(result.opening).not.toMatch(/Diana|Amphitrite|Quies|Minerva|Apollo/);
		expect(result.opening).toContain("already");
		expect(result.opening).toMatch(/swim/i);
		expect(result.rationale_header).toBe("Rationale");
	});

	it("phrases the both-done case as rest-only", () => {
		const result = plainQuiesMessage("Run", null);
		expect(result.opening).toMatch(/rest is the prescription/i);
	});
});
