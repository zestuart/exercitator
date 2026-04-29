import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetRateLimits, checkRate } from "../src/rate-limit.js";

describe("rate-limit", () => {
	beforeEach(() => {
		_resetRateLimits();
		process.env.EXERCITATOR_RATE_LIMIT_READ = undefined;
		process.env.EXERCITATOR_RATE_LIMIT_WRITE = undefined;
	});

	afterEach(() => {
		_resetRateLimits();
	});

	it("returns allowed: true for the first call", () => {
		const r = checkRate("read", "ze");
		expect(r.allowed).toBe(true);
		expect(r.limit).toBe(60);
	});

	it("blocks the (limit+1)th request in the same window", () => {
		process.env.EXERCITATOR_RATE_LIMIT_WRITE = "3";
		expect(checkRate("write", "ze").allowed).toBe(true);
		expect(checkRate("write", "ze").allowed).toBe(true);
		expect(checkRate("write", "ze").allowed).toBe(true);
		const r = checkRate("write", "ze");
		expect(r.allowed).toBe(false);
		expect(r.retryAfterS).toBeGreaterThanOrEqual(1);
		expect(r.limit).toBe(3);
	});

	it("isolates buckets per user", () => {
		process.env.EXERCITATOR_RATE_LIMIT_WRITE = "1";
		expect(checkRate("write", "ze").allowed).toBe(true);
		expect(checkRate("write", "ze").allowed).toBe(false);
		// pam still has a full bucket
		expect(checkRate("write", "pam").allowed).toBe(true);
	});

	it("isolates read and write buckets per user", () => {
		process.env.EXERCITATOR_RATE_LIMIT_WRITE = "1";
		process.env.EXERCITATOR_RATE_LIMIT_READ = "1";
		expect(checkRate("write", "ze").allowed).toBe(true);
		expect(checkRate("write", "ze").allowed).toBe(false);
		// reads share their own bucket — still full
		expect(checkRate("read", "ze").allowed).toBe(true);
	});

	it("disables the limiter when set to 0", () => {
		process.env.EXERCITATOR_RATE_LIMIT_READ = "0";
		for (let i = 0; i < 1000; i++) {
			expect(checkRate("read", "ze").allowed).toBe(true);
		}
	});

	it("falls back to defaults on invalid input", () => {
		process.env.EXERCITATOR_RATE_LIMIT_READ = "not-a-number";
		const r = checkRate("read", "ze");
		expect(r.allowed).toBe(true);
		expect(r.limit).toBe(60);
	});
});
