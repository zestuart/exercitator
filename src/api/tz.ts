/**
 * Shared timezone resolver for the HTTP API.
 *
 * Resolves an IANA timezone from (in order):
 *   1. The `?tz=...` query param, if it validates as IANA.
 *   2. The athlete's intervals.icu profile timezone, if it validates.
 *   3. Falls back to "UTC".
 *
 * Strict validation matters because `tz` flows into both response cache keys
 * and `localDateStr` (which calls `Intl.DateTimeFormat` and raises RangeError
 * on bad input). A crafted `?tz=a/a` without validation would either explode
 * the cache or DoS the listener — see SECURITY.md finding #16. Centralising
 * this resolver prevents per-handler drift.
 */

import { isValidTimezone } from "../engine/date-utils.js";
import type { UserContext } from "./router.js";

export async function resolveTz(user: UserContext, url: URL): Promise<string> {
	const q = url.searchParams.get("tz");
	if (isValidTimezone(q)) return q;
	try {
		const profile = await user.intervals.get<{ timezone?: string }>(
			`/athlete/${user.intervals.athleteId}`,
		);
		const profileTz = profile.timezone;
		return isValidTimezone(profileTz) ? profileTz : "UTC";
	} catch {
		return "UTC";
	}
}
