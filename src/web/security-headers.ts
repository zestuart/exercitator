/**
 * Defence-in-depth security headers for the Praescriptor surface.
 *
 * The web UI is tailnet-only via Tailscale serve, so an attacker can't
 * reach it from the open internet. These headers harden the remaining
 * surface — a compromised tailnet device, a stale cached HTML response
 * sourced from another origin, a clickjacked iframe — without changing
 * how the page renders for legitimate users.
 *
 * Two header sets:
 *   - `applyBaseSecurityHeaders` — safe to apply to every response.
 *   - `applyHtmlSecurityHeaders`  — adds CSP for HTML responses. The
 *     renderer ships inline `<style>` and `<script>` blocks plus Google
 *     Fonts, so CSP allows `'unsafe-inline'` and the two fonts hosts.
 */

import type { ServerResponse } from "node:http";

/** Apply HSTS / nosniff / frame-ancestors / referrer policy. */
export function applyBaseSecurityHeaders(res: ServerResponse): void {
	if (res.headersSent) return;
	// 2 years, includeSubDomains. Tailscale serve already terminates HTTPS.
	res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Referrer-Policy", "same-origin");
}

/**
 * Apply the headers above plus a CSP tuned for the Praescriptor renderer.
 *
 * - inline styles + scripts (the renderer concatenates CSS/JS into the page)
 * - Google Fonts (style + font hosts)
 * - same-origin fetches for /api/*
 * - frame-ancestors 'none' (matches X-Frame-Options DENY)
 */
export function applyHtmlSecurityHeaders(res: ServerResponse): void {
	if (res.headersSent) return;
	applyBaseSecurityHeaders(res);
	res.setHeader(
		"Content-Security-Policy",
		[
			"default-src 'self'",
			"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
			"font-src 'self' https://fonts.gstatic.com",
			"script-src 'self' 'unsafe-inline'",
			"img-src 'self' data:",
			"connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
			"base-uri 'self'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		].join("; "),
	);
}
