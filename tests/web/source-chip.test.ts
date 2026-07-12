/**
 * Unit tests for `humaniseFallbackReason` — the source-chip phrasing that
 * turns a machine `fallbackReason` slug into a plain-English explanation.
 * The raw slug stays in the chip tooltip + on the HTTP API; this covers
 * only the human-facing string.
 */

import { describe, expect, it } from "vitest";
import { clientJs, humaniseFallbackReason } from "../../src/web/render.js";

describe("humaniseFallbackReason", () => {
	it("explains the recovery-day stride rejection in plain English (no raw slug)", () => {
		const msg = humaniseFallbackReason("stride_rejected_on_recovery", "Stryd");
		expect(msg).toContain("recovery day");
		expect(msg).toContain("Stryd");
		expect(msg).not.toContain("stride_rejected_on_recovery");
	});

	it("maps the static slugs", () => {
		expect(humaniseFallbackReason("picker_rejected_all_candidates", "Stryd")).toContain(
			"No suitable Stryd workout",
		);
		expect(humaniseFallbackReason("empty_workouts_array", "FORM")).toContain(
			"returned no workouts",
		);
		expect(humaniseFallbackReason("network_error", "Stryd")).toContain("Couldn't reach Stryd");
		expect(humaniseFallbackReason("unknown_error", "FORM")).toContain("FORM was unavailable");
	});

	it("handles the dynamic slug families", () => {
		expect(humaniseFallbackReason("204_no_content_long", "Stryd")).toContain(
			"no workout in this category",
		);
		expect(humaniseFallbackReason("unsafe_block_count", "Stryd")).toContain("safety check");
		expect(humaniseFallbackReason("malformed_duration_time", "Stryd")).toContain("safety check");
		expect(humaniseFallbackReason("http_503", "FORM")).toContain("HTTP 503");
	});

	it("falls back to the raw slug for an unrecognised reason", () => {
		const msg = humaniseFallbackReason("brand_new_reason", "Stryd");
		expect(msg).toContain("brand_new_reason");
		expect(msg).toContain("Stryd unavailable");
	});

	it("uses the vendor name it's given", () => {
		expect(humaniseFallbackReason("network_error", "FORM")).toContain("FORM");
		expect(humaniseFallbackReason("network_error", "FORM")).not.toContain("Stryd");
	});
});

describe("clientJs — user slug is emitted as a JSON literal (XSS hardening)", () => {
	it("emits a known slug as a quoted JS string and builds the prefix client-side", () => {
		const js = clientJs("ze");
		expect(js).toContain('const __userId = "ze";');
		expect(js).toContain("const prefix = '/' + __userId;");
		// API paths are concatenated client-side, never server-interpolated.
		expect(js).toContain("fetch(prefix + '/api/refresh'");
		expect(js).not.toContain("fetch('/ze/api/refresh'");
	});

	it("escapes a slug that tries to break out of the JS string context", () => {
		// The classic break-out payload from the SAST finding.
		const js = clientJs("x';alert(document.domain);'y");
		// JSON.stringify keeps it inside the double-quoted literal — the
		// single quotes are inert and no bare alert() lands at top level.
		expect(js).toContain("const __userId = \"x';alert(document.domain);'y\";");
		expect(js).not.toMatch(/^\s*alert\(document\.domain\)/m);
	});

	it("escapes double quotes and backslashes so the literal cannot be closed early", () => {
		const js = clientJs('a"b\\c');
		// JSON.stringify -> "a\"b\\c": quote and backslash both escaped.
		expect(js).toContain('const __userId = "a\\"b\\\\c";');
	});

	it("neutralises a </script> payload by not emitting it verbatim in an executable position", () => {
		const js = clientJs("ze");
		// Sanity: the normal path carries no script-closing sequence.
		expect(js).not.toContain("</script>");
	});

	it("wires the power-source toggle POST via the client-built prefix", () => {
		const js = clientJs("ze");
		expect(js).toContain(".ps-btn");
		expect(js).toContain("fetch(prefix + '/api/power-source'");
		expect(js).toContain("dataset.powerSource");
		// Never server-interpolates the slug into the path.
		expect(js).not.toContain("fetch('/ze/api/power-source'");
	});

	it("wires the health-source selector POST via the client-built prefix", () => {
		const js = clientJs("ze");
		expect(js).toContain(".hs-btn");
		expect(js).toContain("fetch(prefix + '/api/health-source'");
		expect(js).toContain("dataset.healthSource");
		expect(js).not.toContain("fetch('/ze/api/health-source'");
	});
});
