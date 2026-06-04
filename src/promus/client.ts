/**
 * Promus health-telemetry API client.
 *
 * Reads in-house overnight health metrics (WHOOP strap sleep + nightly HRV)
 * from Promus, the home-lab biometric store on Cogitator. This replaces
 * intervals.icu as the source of the Sleep and HRV readiness components for
 * users flagged `healthSource: "promus-whoop"` — intervals.icu's wellness
 * sleep field proved unreliable (an Oura-sync artefact once logged an 18-min
 * "night" that suppressed a real prescription; see lessons.md 2026-06-03).
 *
 * Bearer-authenticated against `PROMUS_API` (per-client token issued from
 * Promus' `PROMUS_API_KEYS`). Zero external dependencies — Node.js native
 * fetch, bounded JSON parse, request timeout.
 */

/** Promus base URL on the tailnet. Override via `PROMUS_URL` (resolved by the
 *  caller in health-source.ts) or the `baseUrl` config field for tests. */
const DEFAULT_BASE_URL = "https://promus.tail7ab379.ts.net";

const API_TIMEOUT_MS = 15_000;

/**
 * Upper bound for Promus JSON response bodies. Observed payloads: ~1 KB per
 * night × a 7-night window. 512 KB is generous headroom while bounding the
 * OOM blast radius from a malformed or hostile upstream response.
 */
const MAX_JSON_RESPONSE_BYTES = 512 * 1024;

/** One WHOOP sleep night. Mirrors Promus `WhoopSleepRow`. */
export interface WhoopSleepRow {
	/** Local-ish wake date YYYY-MM-DD — the key we join health to a day on. */
	wake_date: string;
	bedtime_start: string;
	bedtime_end: string;
	bedtime_start_ts: number;
	bedtime_end_ts: number;
	/** Total sleep duration in seconds. */
	duration_s: number;
	latency_s: number | null;
	brief_wake_events: number;
	n_seconds_predicted_sleep: number;
	method: string;
}

/** One WHOOP nightly-HRV row. Mirrors Promus `WhoopHrvNightly`. */
export interface WhoopHrvNightly {
	/** UTC wake day YYYY-MM-DD. */
	wake_day_utc: string;
	/** Motion-clean median RMSSD in ms; null when no clean burst was captured. */
	rmssd_median_ms: number | null;
	clean_burst_count: number;
	method: string;
}

export interface PromusConfig {
	apiKey: string;
	baseUrl?: string;
}

/**
 * Read a fetch Response as text, enforce a size cap, then JSON.parse. Throws
 * with the method label and observed vs allowed size before parsing.
 */
async function parseBoundedJson<T>(
	res: Response,
	methodLabel: string,
	maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<T> {
	const text = await res.text();
	if (text.length > maxBytes) {
		throw new Error(
			`Promus ${methodLabel}: response too large (${text.length} bytes, limit ${maxBytes})`,
		);
	}
	return JSON.parse(text) as T;
}

export class PromusClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;

	constructor(config: PromusConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			Accept: "application/json",
		};
	}

	private async getJson<T>(path: string, methodLabel: string): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
			throw new Error(`Promus ${methodLabel} failed (HTTP ${res.status}): ${excerpt}`);
		}
		return parseBoundedJson<T>(res, methodLabel);
	}

	/**
	 * Fetch WHOOP sleep nights for a serial over an inclusive date range.
	 * `startDate` / `endDate` are YYYY-MM-DD.
	 */
	async getWhoopSleep(
		serial: string,
		startDate: string,
		endDate: string,
	): Promise<WhoopSleepRow[]> {
		const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
		const path = `/api/whoop/${encodeURIComponent(serial)}/sleep?${params}`;
		return this.getJson<WhoopSleepRow[]>(path, "getWhoopSleep");
	}

	/**
	 * Fetch WHOOP nightly HRV for a serial over the last `days` nights.
	 */
	async getWhoopHrvNightly(serial: string, days: number): Promise<WhoopHrvNightly[]> {
		const params = new URLSearchParams({ days: String(days) });
		const path = `/api/whoop/${encodeURIComponent(serial)}/hrv_nightly?${params}`;
		return this.getJson<WhoopHrvNightly[]>(path, "getWhoopHrvNightly");
	}
}
