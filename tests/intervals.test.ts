import { describe, expect, it } from "vitest";
import { IntervalsClient } from "../src/intervals.js";

describe("IntervalsClient", () => {
	it("constructs with default athlete ID", () => {
		const client = new IntervalsClient({ apiKey: "test-key" });
		expect(client.athleteId).toBe("0");
	});

	it("constructs with custom athlete ID", () => {
		const client = new IntervalsClient({ apiKey: "test-key", athleteId: "i12345" });
		expect(client.athleteId).toBe("i12345");
	});

	it("throws on non-ok response", async () => {
		const client = new IntervalsClient({ apiKey: "invalid" });
		await expect(client.get("/athlete/0")).rejects.toThrow("intervals.icu");
	});
});
