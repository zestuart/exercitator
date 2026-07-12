/**
 * Garmin bridge client — reads Garmin Connect recovery telemetry + activity FITs
 * from the in-house `garmin-bridge` sidecar (see `garmin-bridge/`), for users
 * flagged `healthSource: "garmin"` (or `"auto"` falling back from WHOOP).
 *
 * The bridge normalises Garmin's unstable API into the SAME small DTOs the WHOOP
 * feed exposes, so these methods are drop-in analogues of `PromusClient`'s WHOOP
 * methods and the readiness engine treats both sources identically:
 *   - getSleepNightly  ↔ getWhoopSleep       ({ wake_date, duration_s })
 *   - getHrvNightly    ↔ getWhoopHrvNightly  ({ wake_day_utc, rmssd_median_ms })
 *   - getBodyBatteryCurrent ↔ getVigorVitaeCurrent ({ value, level })
 *
 * Bearer-authenticated against `GARMIN_BRIDGE_API_KEY`. Zero external deps —
 * native fetch, bounded JSON parse, request timeout, no secret logged. On an
 * expired/absent Garmin token the bridge returns 503 `garmin_reauth_required`,
 * which surfaces here as a thrown error the caller treats as "unavailable".
 */

/** Bridge base URL. Default = the compose-network service; override via `GARMIN_URL`
 *  (resolved by the caller in health-source.ts) or the `baseUrl` config for tests. */
const DEFAULT_BASE_URL = "http://garmin-bridge:8655";

const API_TIMEOUT_MS = 20_000;

/** Bound on bridge JSON bodies. HRV/sleep windows are ~1 KB/day × ≤30 days. */
const MAX_JSON_RESPONSE_BYTES = 512 * 1024;

/** Bound on a single Garmin FIT (raw bytes). Long runs are well under this. */
const MAX_FIT_RESPONSE_BYTES = 16 * 1024 * 1024;

/** One Garmin sleep night. Structurally compatible with `WhoopSleepRow` for the
 *  fields `mergeWhoopHealth` consumes. */
export interface GarminSleepRow {
	wake_date: string;
	duration_s: number | null;
}

/** One Garmin overnight-HRV row. Compatible with `WhoopHrvNightly`. */
export interface GarminHrvNightly {
	wake_day_utc: string;
	rmssd_median_ms: number | null;
}

/** Latest Garmin Body Battery. Compatible with `VigorVitaeCurrent`'s consumed fields. */
export interface GarminBodyBatteryCurrent {
	value: number | null;
	level: string;
}

/** A Garmin activity summary (Phase 2 FIT pull). */
export interface GarminActivity {
	id: number;
	name: string | null;
	sport: string;
	start_local: string | null;
	start_gmt: string | null;
	duration_s: number | null;
}

export interface GarminConfig {
	apiKey: string;
	baseUrl?: string;
}

async function parseBoundedJson<T>(
	res: Response,
	methodLabel: string,
	maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<T> {
	const text = await res.text();
	if (text.length > maxBytes) {
		throw new Error(
			`Garmin ${methodLabel}: response too large (${text.length} bytes, limit ${maxBytes})`,
		);
	}
	return JSON.parse(text) as T;
}

export class GarminClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;

	constructor(config: GarminConfig) {
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
			throw new Error(`Garmin ${methodLabel} failed (HTTP ${res.status}): ${excerpt}`);
		}
		return parseBoundedJson<T>(res, methodLabel);
	}

	/** Garmin sleep nights over an inclusive YYYY-MM-DD range (mirrors getWhoopSleep). */
	async getSleepNightly(startDate: string, endDate: string): Promise<GarminSleepRow[]> {
		const params = new URLSearchParams({ start: startDate, end: endDate });
		return this.getJson<GarminSleepRow[]>(`/sleep_nightly?${params}`, "getSleepNightly");
	}

	/** Garmin overnight HRV over the last `days` nights (mirrors getWhoopHrvNightly). */
	async getHrvNightly(days: number): Promise<GarminHrvNightly[]> {
		const params = new URLSearchParams({ days: String(days) });
		return this.getJson<GarminHrvNightly[]>(`/hrv_nightly?${params}`, "getHrvNightly");
	}

	/** Latest Garmin Body Battery (0–100) as the acute recovery signal
	 *  (mirrors getVigorVitaeCurrent). */
	async getBodyBatteryCurrent(): Promise<GarminBodyBatteryCurrent> {
		return this.getJson<GarminBodyBatteryCurrent>("/body_battery/current", "getBodyBatteryCurrent");
	}

	/** Garmin activities over an inclusive YYYY-MM-DD range (Phase 2). */
	async getActivities(startDate: string, endDate: string): Promise<GarminActivity[]> {
		const params = new URLSearchParams({ start: startDate, end: endDate });
		return this.getJson<GarminActivity[]>(`/activities?${params}`, "getActivities");
	}

	/** Download an original activity FIT as a Buffer (Phase 2). */
	async getActivityFit(activityId: number): Promise<Buffer> {
		const res = await fetch(
			`${this.baseUrl}/activity/${encodeURIComponent(String(activityId))}/fit`,
			{ headers: this.authHeaders(), signal: AbortSignal.timeout(API_TIMEOUT_MS) },
		);
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
			throw new Error(`Garmin getActivityFit failed (HTTP ${res.status}): ${excerpt}`);
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_FIT_RESPONSE_BYTES) {
			throw new Error(
				`Garmin getActivityFit: FIT too large (${buf.length} bytes, limit ${MAX_FIT_RESPONSE_BYTES})`,
			);
		}
		return buf;
	}
}
