import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
	applyBaseSecurityHeaders,
	applyHtmlSecurityHeaders,
} from "../../src/web/security-headers.js";

function fakeRes(): ServerResponse & { _headers: Record<string, string> } {
	const headers: Record<string, string> = {};
	return {
		headersSent: false,
		_headers: headers,
		setHeader(name: string, value: string) {
			headers[name] = value;
			return this;
		},
	} as unknown as ServerResponse & { _headers: Record<string, string> };
}

describe("base security headers", () => {
	it("sets HSTS, nosniff, frame-ancestors, referrer-policy", () => {
		const res = fakeRes();
		applyBaseSecurityHeaders(res);
		expect(res._headers["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
		expect(res._headers["X-Content-Type-Options"]).toBe("nosniff");
		expect(res._headers["X-Frame-Options"]).toBe("DENY");
		expect(res._headers["Referrer-Policy"]).toBe("same-origin");
	});

	it("does nothing if headers already sent", () => {
		const res = fakeRes();
		(res as unknown as { headersSent: boolean }).headersSent = true;
		applyBaseSecurityHeaders(res);
		expect(Object.keys(res._headers).length).toBe(0);
	});
});

describe("html security headers", () => {
	it("includes a CSP that allows inline + Google Fonts", () => {
		const res = fakeRes();
		applyHtmlSecurityHeaders(res);
		const csp = res._headers["Content-Security-Policy"];
		expect(csp).toBeDefined();
		// Must allow inline styles + Google Fonts (renderer requires both).
		expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
		expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
		// Must allow inline scripts (renderer ships clientJs inline).
		expect(csp).toContain("script-src 'self' 'unsafe-inline'");
		// Must lock down framing.
		expect(csp).toContain("frame-ancestors 'none'");
	});

	it("also applies the base headers", () => {
		const res = fakeRes();
		applyHtmlSecurityHeaders(res);
		expect(res._headers["X-Content-Type-Options"]).toBe("nosniff");
		expect(res._headers["X-Frame-Options"]).toBe("DENY");
	});
});
