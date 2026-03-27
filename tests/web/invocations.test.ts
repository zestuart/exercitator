import { describe, expect, it } from "vitest";
import { generateInvocations } from "../../src/web/invocations.js";

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
