import { describe, expect, it } from "vitest";
import { localDateStr } from "../../src/engine/date-utils.js";

describe("localDateStr", () => {
	it("defaults to UTC", () => {
		const d = new Date("2026-04-02T06:30:00Z");
		expect(localDateStr(d)).toBe("2026-04-02");
	});

	it("returns previous day for Pacific evening (UTC next day)", () => {
		// 2026-04-02T06:30:00Z = 2026-04-01T23:30:00 Pacific (PDT, UTC-7)
		const d = new Date("2026-04-02T06:30:00Z");
		expect(localDateStr(d, "America/Los_Angeles")).toBe("2026-04-01");
	});

	it("handles Pacific midnight boundary — just before", () => {
		// 2026-04-02T06:59:59Z = 2026-04-01T23:59:59 Pacific
		const d = new Date("2026-04-02T06:59:59Z");
		expect(localDateStr(d, "America/Los_Angeles")).toBe("2026-04-01");
	});

	it("handles Pacific midnight boundary — just after", () => {
		// 2026-04-02T07:00:01Z = 2026-04-02T00:00:01 Pacific
		const d = new Date("2026-04-02T07:00:01Z");
		expect(localDateStr(d, "America/Los_Angeles")).toBe("2026-04-02");
	});

	it("handles London BST (UTC+1)", () => {
		// 2026-04-01 is during BST. 2026-04-01T23:30:00Z = 2026-04-02T00:30:00 BST
		const d = new Date("2026-04-01T23:30:00Z");
		expect(localDateStr(d, "Europe/London")).toBe("2026-04-02");
	});

	it("handles London GMT (winter)", () => {
		// 2026-01-15 is during GMT. 2026-01-15T23:30:00Z = 2026-01-15T23:30:00 GMT
		const d = new Date("2026-01-15T23:30:00Z");
		expect(localDateStr(d, "Europe/London")).toBe("2026-01-15");
	});

	it("produces YYYY-MM-DD format consistently", () => {
		const d = new Date("2026-01-05T12:00:00Z");
		const result = localDateStr(d, "UTC");
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(result).toBe("2026-01-05");
	});

	it("is deterministic regardless of system timezone", () => {
		const d = new Date("2026-07-15T03:00:00Z");
		// Same instant, two timezones — should give different dates
		expect(localDateStr(d, "America/Los_Angeles")).toBe("2026-07-14"); // PDT: 20:00
		expect(localDateStr(d, "Europe/London")).toBe("2026-07-15"); // BST: 04:00
		expect(localDateStr(d, "Asia/Tokyo")).toBe("2026-07-15"); // JST: 12:00
	});
});
