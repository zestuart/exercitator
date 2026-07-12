/**
 * Health-telemetry wiring.
 *
 * Resolves a `HealthFetchOptions` for a user profile so the `fetchTrainingData`
 * call sites (Praescriptor, the three HTTP API handlers, the MCP entry) all
 * construct their telemetry inputs the same way. The effective source is the
 * runtime override (the Praescriptor WHOOP/Garmin/Auto selector, stored in
 * `user_preferences`) falling back to the profile's static `healthSource`:
 *
 *   - "promus-whoop" → WHOOP strap via Promus (stateless `PromusClient`).
 *   - "garmin"       → Garmin Connect via the garmin-bridge (`GarminClient`).
 *   - "auto"         → WHOOP primary, Garmin fallback (both clients built).
 *   - anything else / unset → intervals.icu wellness (no-op options).
 *
 * Both clients are stateless (bearer key + base URL), so they are cheap to
 * construct per request — no server-held client pool.
 */

import { getHealthSourceOverride } from "./db.js";
import type { HealthFetchOptions } from "./engine/suggest.js";
import { GarminClient } from "./garmin/client.js";
import { PromusClient } from "./promus/client.js";
import type { UserProfile } from "./users.js";

/** Read the runtime health-source override, tolerating an unavailable DB (tests). */
function overrideFor(userId: string): ReturnType<typeof getHealthSourceOverride> {
	try {
		return getHealthSourceOverride(userId);
	} catch {
		return null;
	}
}

export function healthFetchOptionsFor(profile: UserProfile): HealthFetchOptions {
	// Runtime selector wins over the profile default; undefined/none = intervals.
	const effective = overrideFor(profile.id) ?? profile.healthSource;
	if (effective !== "promus-whoop" && effective !== "garmin" && effective !== "auto") {
		return { promusClient: null, whoopSerial: null };
	}

	// Promus/WHOOP client — used by "promus-whoop" and as the primary for "auto".
	const promusApiKey = profile.promusApiKeyEnv ? process.env[profile.promusApiKeyEnv] : undefined;
	const whoopSerial = profile.whoopSerialEnv ? (process.env[profile.whoopSerialEnv] ?? null) : null;
	const promusBaseUrl = process.env.PROMUS_URL || undefined;
	const promusClient = promusApiKey
		? new PromusClient({
				apiKey: promusApiKey,
				...(promusBaseUrl ? { baseUrl: promusBaseUrl } : {}),
			})
		: null;

	// Garmin bridge client — used by "garmin" and as the "auto" fallback.
	const garminApiKey = profile.garminApiKeyEnv ? process.env[profile.garminApiKeyEnv] : undefined;
	const garminBaseUrl = profile.garminUrlEnv ? process.env[profile.garminUrlEnv] : undefined;
	const garminClient = garminApiKey
		? new GarminClient({
				apiKey: garminApiKey,
				...(garminBaseUrl ? { baseUrl: garminBaseUrl } : {}),
			})
		: null;

	return { promusClient, whoopSerial, garminClient, healthSource: effective };
}
