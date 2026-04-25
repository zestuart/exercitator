/**
 * HTTP API error envelope — matches promus conventions.
 *
 * See phase2/exercitator-http-api-spec.md §4.
 */

import type { ServerResponse } from "node:http";

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

export function apiError(
	res: ServerResponse,
	status: number,
	message: string,
	details?: Record<string, unknown>,
): void {
	jsonResponse(res, status, details ? { error: message, details } : { error: message });
}
