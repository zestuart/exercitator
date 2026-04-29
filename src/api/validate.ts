/**
 * Shared input validators for the HTTP API surface.
 *
 * intervals.icu activity IDs are decimal integers in practice but are
 * stored as strings on the wire. We accept the broader `[A-Za-z0-9_-]+`
 * shape so future ID schemes don't break us, while still rejecting
 * crafted values that contain path-traversal characters (`/`, `\`, `.`,
 * URL escapes, etc.). The handlers also `encodeURIComponent` before
 * interpolating into the upstream URL — together these defences keep
 * `IntervalsClient.request` from being coaxed into protocol-relative
 * SSRF, even if the URL constructor pattern in `src/intervals.ts` ever
 * changes.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidIntervalsId(id: unknown): id is string {
	return typeof id === "string" && ID_PATTERN.test(id);
}
