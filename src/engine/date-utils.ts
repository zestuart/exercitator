/**
 * Timezone-aware date string utility.
 *
 * Replaces all `new Date().toISOString().slice(0, 10)` patterns with a
 * function that respects the athlete's local timezone, so "today" is
 * correct regardless of the server's system clock or UTC offset.
 */

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone.
 *
 * Uses the `en-CA` locale which natively produces ISO 8601 date format.
 * Deterministic for the same (date, tz) pair — safe for testing regardless
 * of the host system's timezone.
 *
 * @param d   The instant to format.
 * @param tz  IANA timezone string (e.g. "America/Los_Angeles"). Defaults to "UTC".
 */
export function localDateStr(d: Date, tz = "UTC"): string {
	return d.toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * Strictly validate an IANA timezone string by attempting to construct an
 * `Intl.DateTimeFormat` with it. Used at the request boundary (cookies,
 * query params) so a crafted value can't reach `localDateStr` (which would
 * throw a RangeError) or pollute caches keyed by `tz`.
 */
export function isValidTimezone(tz: unknown): tz is string {
	if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}
