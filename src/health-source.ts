/**
 * Promus health-telemetry wiring.
 *
 * Resolves a `HealthFetchOptions` for a user profile so the `fetchTrainingData`
 * call sites (Praescriptor, the three HTTP API handlers, the MCP entry) all
 * construct their Promus inputs the same way. Users without
 * `healthSource: "promus-whoop"` get a no-op options object and keep the
 * intervals.icu wellness source.
 *
 * Unlike the Stryd/FORM clients (which hold login tokens and are pooled in the
 * servers), `PromusClient` is stateless — just a bearer key + base URL — so it
 * is cheap to construct per request and needs no server-held client map.
 */

import type { HealthFetchOptions } from "./engine/suggest.js";
import { PromusClient } from "./promus/client.js";
import type { UserProfile } from "./users.js";

/**
 * Resolve the `HealthFetchOptions` for a user from their profile + environment.
 * The Promus bearer key and WHOOP strap serial are read from the env vars the
 * profile names (`promusApiKeyEnv` / `whoopSerialEnv`). Returns a no-op
 * (intervals-source) options object for users not flagged `promus-whoop`.
 */
export function healthFetchOptionsFor(profile: UserProfile): HealthFetchOptions {
	if (profile.healthSource !== "promus-whoop") {
		return { promusClient: null, whoopSerial: null };
	}
	const apiKey = profile.promusApiKeyEnv ? process.env[profile.promusApiKeyEnv] : undefined;
	const whoopSerial = profile.whoopSerialEnv ? (process.env[profile.whoopSerialEnv] ?? null) : null;
	const baseUrl = process.env.PROMUS_URL || undefined;
	const promusClient = apiKey
		? new PromusClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) })
		: null;
	return { promusClient, whoopSerial, healthSource: "promus-whoop" };
}
