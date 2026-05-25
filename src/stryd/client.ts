/**
 * Stryd PowerCenter API client.
 *
 * Authenticates via email/password and downloads FIT files with full
 * developer fields (Form Power, LSS, ILR, Air Power, etc.) that are
 * stripped when recording via Apple Watch + HealthKit.
 *
 * Zero external dependencies — uses Node.js native fetch.
 */

const LOGIN_URL = "https://www.stryd.com/b/email/signin";
const API_BASE = "https://api.stryd.com/b/api/v1";

const API_TIMEOUT_MS = 30_000;
const FIT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Maximum FIT file size (10 MB — largest real Stryd FIT is ~200 KB). */
const MAX_FIT_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum recommendation-set JSON response size. Observed payloads: ~20 KB
 * (workout bucket, 2 candidates), ~4 KB (easy bucket, 1 candidate). 1 MB
 * gives generous headroom for adaptive-plan accounts while capping the
 * memory footprint of a malformed upstream response.
 */
const MAX_RECOMMENDATIONS_JSON_BYTES = 1024 * 1024;

/**
 * Default upper bound for JSON response bodies on api.stryd.com. Real
 * payloads observed: login response ~400 B, listActivities ~1-50 KB,
 * calendar entries ~1-10 KB, cp/history ~5-30 KB. 1 MB is generous
 * headroom while still bounding the OOM blast radius from a hostile
 * or buggy upstream.
 */
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;

/**
 * Read a fetch Response as text, enforce a size cap, then JSON.parse.
 * Throws with a descriptive error including the method label and the
 * observed vs allowed size, before any parsing is attempted.
 */
async function parseBoundedJson<T>(
	res: Response,
	methodLabel: string,
	maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<T> {
	const text = await res.text();
	if (text.length > maxBytes) {
		throw new Error(
			`Stryd ${methodLabel}: response too large (${text.length} bytes, limit ${maxBytes})`,
		);
	}
	return JSON.parse(text) as T;
}

/** Allowed hostnames for Stryd FIT download URLs. */
const ALLOWED_FIT_HOSTS = ["storage.googleapis.com", "storage.cloud.google.com"];

const BROWSER_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
		"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
	Origin: "https://www.stryd.com",
	Referer: "https://www.stryd.com/",
};

export interface StrydConfig {
	email: string;
	password: string;
}

export interface StrydWorkoutSegment {
	desc: string;
	desc_no_cp: string;
	duration_type: "time" | "distance";
	duration_time: { hour: number; minute: number; second: number };
	intensity_class: "warmup" | "work" | "rest" | "cooldown";
	intensity_type: "percentage";
	intensity_percent: { min: number; max: number; value: number };
	flexible: boolean;
	incline: number;
	grade: number;
	distance_unit_selected: string;
	duration_distance: number;
	pdc_target: number;
	rpe_selected: number;
	zone_selected: number;
	uuid: string;
}

export interface StrydWorkoutBlock {
	repeat: number;
	segments: StrydWorkoutSegment[];
	uuid: string;
}

export interface StrydWorkoutPayload {
	type: string;
	title: string;
	desc: string;
	blocks: StrydWorkoutBlock[];
}

export interface StrydCalendarEntry {
	id: number;
	date: string;
	stress: number;
	duration: number;
	distance: number;
}

export interface StrydCpResult {
	/** Critical Power in watts. */
	criticalPower: number;
	/** Unix timestamp (seconds) when this CP value was created/updated in Stryd. */
	createdAt: number;
}

export interface StrydActivity {
	id: number;
	timestamp: number;
	distance: number;
	elapsed_time: number;
	average_power: number;
	/** 1-10 RPE from Stryd post-run report (if submitted) */
	rpe?: number;
	/** Subjective feel from Stryd post-run report */
	feel?: string;
	/** Surface tag from Stryd post-run report */
	surface_type?: string;
}

// ---------------------------------------------------------------------------
// Workout-recommendations endpoint (GET /users/{userId}/workouts/recommendations)
// Wire contract: see retextor/notes/stryd-api/spec-recommendations.md.
// Field names match the JSON exactly (snake_case, no camel-casing).
// ---------------------------------------------------------------------------

/** Recommendation type bucket — query-parameter discriminator. */
export type StrydRecommendationType = "easy" | "long" | "workout";

/** Per-segment block inside a recommended workout. */
export interface StrydRecommendedSegment {
	desc: string;
	desc_no_cp: string;
	flexible: boolean;
	duration_type: "time" | "distance";
	duration_time: { hour: number; minute: number; second: number };
	duration_distance: number;
	distance_unit_selected: string;
	intensity_class: "warmup" | "work" | "rest" | "cooldown";
	intensity_type: "percentage" | "zone" | "rpe";
	intensity_percent: { value: number; min: number; max: number };
	zone_selected: number;
	rpe_selected: number;
	pdc_target: number;
	grade: number;
	incline: number;
	power_type: string;
}

/** Block in a recommended workout — `repeat` ≥ 1, loop over `segments[]`. */
export interface StrydRecommendedBlock {
	repeat: number;
	segments: StrydRecommendedSegment[];
}

/** The workout body (`estimated_workout.workout`). `id` is a numeric int64. */
export interface StrydWorkout {
	id: number;
	created: number;
	created_time: string;
	updated: number;
	updated_time: string;
	title: string;
	objective: string;
	desc: string;
	surface: string;
	type: string;
	/** `null` is valid (observed on Hill Hustle, Dash & Dine). */
	tags: string[] | null;
	goal_types: string[];
	blocks: StrydRecommendedBlock[];
	notification_text: string;
}

/** Per-segment estimate — NOT repeat-folded (one rep only). */
export interface StrydSegmentEstimate {
	stress: number;
	duration: number;
	distance: number;
	/** Fixed-length 5-element array: seconds in each power zone. */
	intensity_zones: [number, number, number, number, number];
}

/** Per-block estimate — repeat-folded (multiplied by `block.repeat`). */
export interface StrydBlockEstimate {
	stress: number;
	duration: number;
	distance: number;
	intensity_zones: [number, number, number, number, number];
	segment_estimates: StrydSegmentEstimate[];
}

/** Workout + estimator output. `intensity_zones` is total seconds per zone. */
export interface StrydEstimatedWorkout {
	workout: StrydWorkout;
	average: { power: number; intensity: number };
	intensity_zones: [number, number, number, number, number];
	estimates: StrydBlockEstimate[];
}

/** One entry in `workouts[]`. Labels rotate day-to-day — do NOT pick by label. */
export interface StrydRecommendedWorkout {
	estimated_workout: StrydEstimatedWorkout;
	/** Opaque base64-protobuf — identifies the source library/collection. */
	collection_id: string;
	/** Ranking label(s): "Best match", "Harder", "Easier". Non-deterministic. */
	labels: string[];
}

/** Root response envelope. */
export interface StrydRecommendationSet {
	user_id: string;
	/** Recommendation-set id — string despite being int64; used by PATCH write op. */
	id: string;
	created: number;
	created_time: string;
	updated: number;
	updated_time: string;
	workouts: StrydRecommendedWorkout[];
	/** Always `null` in captures — unmodelled extension point. */
	non_workouts: unknown;
	/** 0 = nothing picked; non-zero after a successful PATCH. */
	selected_id: number;
	type: StrydRecommendationType;
	reason: string;
	reason_key: string;
	/** RFC3339 with user-local TZ offset, not UTC. */
	target_date: string;
	source: string;
}

export class StrydClient {
	private token: string | null = null;
	private userId: string | null = null;
	private readonly email: string;
	private readonly password: string;

	constructor(config: StrydConfig) {
		this.email = config.email;
		this.password = config.password;
	}

	private authHeaders(): Record<string, string> {
		if (!this.token) throw new Error("StrydClient: not authenticated — call login() first");
		return {
			...BROWSER_HEADERS,
			// Non-standard "Bearer:" format (with colon) — required by Stryd's API
			Authorization: `Bearer: ${this.token}`,
		};
	}

	async login(): Promise<void> {
		const res = await fetch(LOGIN_URL, {
			method: "POST",
			headers: { ...BROWSER_HEADERS, "Content-Type": "application/json" },
			body: JSON.stringify({ email: this.email, password: this.password }),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Stryd login failed (HTTP ${res.status}): ${text}`);
		}

		const data = await parseBoundedJson<{ token: string; id: string }>(res, "login");
		this.token = data.token;
		this.userId = data.id;
	}

	async listActivities(days = 14): Promise<StrydActivity[]> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		const now = Math.floor(Date.now() / 1000);
		const from = now - days * 86_400;
		const to = now + 86_400; // tomorrow

		const params = new URLSearchParams({
			from: String(from),
			to: String(to),
			include_deleted: "false",
		});

		// User-scoped calendar endpoint on api.stryd.com
		const url = `${API_BASE}/users/${this.userId}/calendar?${params}`;
		const res = await fetch(url, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			throw new Error(`Stryd listActivities failed (HTTP ${res.status})`);
		}

		const data = await parseBoundedJson<{ activities: StrydActivity[] }>(res, "listActivities");
		return data.activities ?? [];
	}

	async downloadFit(activityId: number): Promise<Buffer> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		// Step 1: Get signed GCS URL
		const metaUrl = `${API_BASE}/users/${this.userId}/activities/${activityId}/fit`;
		const metaRes = await fetch(metaUrl, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!metaRes.ok) {
			throw new Error(`Stryd FIT URL fetch failed (HTTP ${metaRes.status})`);
		}

		const { url: signedUrl } = await parseBoundedJson<{ url: string }>(
			metaRes,
			"downloadFit metadata",
		);

		// Validate signed URL against allowed hosts (SSRF prevention)
		const parsedUrl = new URL(signedUrl);
		if (!ALLOWED_FIT_HOSTS.includes(parsedUrl.hostname)) {
			throw new Error(`Stryd FIT download URL on unexpected host: ${parsedUrl.hostname}`);
		}

		// Step 2: Download binary FIT (no auth needed — signed URL)
		const fitRes = await fetch(signedUrl, {
			signal: AbortSignal.timeout(FIT_DOWNLOAD_TIMEOUT_MS),
		});

		if (!fitRes.ok) {
			throw new Error(`Stryd FIT download failed (HTTP ${fitRes.status})`);
		}

		const arrayBuffer = await fitRes.arrayBuffer();
		if (arrayBuffer.byteLength > MAX_FIT_SIZE_BYTES) {
			throw new Error(
				`Stryd FIT file too large (${arrayBuffer.byteLength} bytes, limit ${MAX_FIT_SIZE_BYTES})`,
			);
		}
		return Buffer.from(arrayBuffer);
	}

	/** Fetch the most recent critical power entry from CP history along with the
	 *  timestamp it was created. Returns null if no CP data is available.
	 *  The createdAt lets callers detect stale CP after a layoff. */
	async getLatestCriticalPower(): Promise<StrydCpResult | null> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		const end = new Date();
		const start = new Date(end.getTime() - 90 * 86_400_000); // 90 days lookback
		const fmt = (d: Date) => d.toISOString().slice(0, 10);

		const url = `${API_BASE}/users/${this.userId}/cp/history?startDate=${fmt(start)}&endDate=${fmt(end)}`;
		const res = await fetch(url, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			throw new Error(`Stryd CP history failed (HTTP ${res.status})`);
		}

		const entries = await parseBoundedJson<{ critical_power: number; created: number }[]>(
			res,
			"getLatestCriticalPower",
		);
		if (!Array.isArray(entries) || entries.length === 0) return null;

		// Find the most recent entry with a non-zero created timestamp
		const valid = entries.filter((e) => e.created > 0);
		if (valid.length === 0) return null;

		const latest = valid.reduce((a, b) => (b.created > a.created ? b : a));
		return { criticalPower: latest.critical_power, createdAt: latest.created };
	}

	/** Create a structured workout in the user's Stryd library.
	 *  Returns the workout ID for subsequent scheduling. */
	async createWorkout(workout: StrydWorkoutPayload): Promise<number> {
		const res = await fetch(`${API_BASE}/workouts`, {
			method: "POST",
			headers: { ...this.authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify(workout),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Stryd createWorkout failed (HTTP ${res.status}): ${text}`);
		}

		const data = await parseBoundedJson<{ id: number }>(res, "createWorkout");
		return data.id;
	}

	/** Schedule a workout on the user's Stryd calendar for a given date.
	 *  The workout then appears in the Stryd app for fetching to the watch.
	 *
	 *  Stryd renders the schedule date by interpreting the timestamp in the
	 *  user's profile timezone. We send the timestamp as-is (the actual moment
	 *  the caller passed in) — previously this floored to `setHours(0,0,0,0)`,
	 *  which sets MIDNIGHT IN THE JS RUNTIME'S LOCAL TZ. In a UTC container
	 *  (production) that turned `new Date()` for a 21:00 UTC moment into the
	 *  preceding day in any user TZ west of UTC, so pushes landed on the
	 *  wrong date in Stryd's UI. Verified empirically against ze's account
	 *  on 2026-05-25 (push at 14:00 PDT landed under "May 24" in the UI).
	 *  Letting the actual moment through means Stryd renders today's date
	 *  in any user TZ for any push happening during their local daytime. */
	async scheduleWorkout(workoutId: number, date: Date): Promise<StrydCalendarEntry> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		const timestamp = Math.floor(date.getTime() / 1000);

		const res = await fetch(
			`${API_BASE}/users/${this.userId}/workouts?id=${workoutId}&timestamp=${timestamp}`,
			{
				method: "POST",
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(API_TIMEOUT_MS),
			},
		);

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Stryd scheduleWorkout failed (HTTP ${res.status}): ${text}`);
		}

		return await parseBoundedJson<StrydCalendarEntry>(res, "scheduleWorkout");
	}

	/** Delete a workout from the user's Stryd calendar. */
	async deleteCalendarEntry(calendarId: number): Promise<void> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		const res = await fetch(`${API_BASE}/users/${this.userId}/workouts/${calendarId}`, {
			method: "DELETE",
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Stryd deleteCalendarEntry failed (HTTP ${res.status}): ${text}`);
		}
	}

	/**
	 * Fetch the current recommendation set for a given workout-type bucket.
	 *
	 * - 200 → returns the parsed `StrydRecommendationSet`.
	 * - 204 → returns `null` (empty bucket, e.g. `long` without an active
	 *   guided/adaptive plan — this is the normal empty state, not an error).
	 * - 401 → re-runs `login()` once and retries the request.
	 * - 5xx / other → throws with the status code and a body excerpt.
	 *
	 * `extended` is plumbed in but empirically a no-op on Pioneer accounts
	 * without an active adaptive plan (see spec-recommendations.md §2 and
	 * phase0-verification-2026-05-25.md). Defaults to `false`.
	 *
	 * Note: the type discriminator MUST be a query parameter — the path form
	 * `/recommendations/{type}` returns 404 (verified Phase 0).
	 */
	async getRecommendedWorkouts(
		type: StrydRecommendationType,
		extended = false,
	): Promise<StrydRecommendationSet | null> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		const params = new URLSearchParams({
			type,
			extended: extended ? "true" : "false",
		});
		const url = `${API_BASE}/users/${this.userId}/workouts/recommendations?${params}`;

		const doFetch = () =>
			fetch(url, {
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(API_TIMEOUT_MS),
			});

		let res = await doFetch();

		if (res.status === 401) {
			// Token expired — refresh and retry once.
			await this.login();
			res = await doFetch();
		}

		if (res.status === 204) return null;

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
			throw new Error(`Stryd getRecommendedWorkouts failed (HTTP ${res.status}): ${excerpt}`);
		}

		// Defensive cap: real recommendation payloads observed at ~20 KB
		// (workout bucket) and 4 KB (easy bucket). 1 MB is generous headroom
		// for adaptive plans without exposing the process to memory exhaustion
		// from a compromised or malformed upstream response.
		const text = await res.text();
		if (text.length > MAX_RECOMMENDATIONS_JSON_BYTES) {
			throw new Error(
				`Stryd getRecommendedWorkouts: response too large (${text.length} bytes, limit ${MAX_RECOMMENDATIONS_JSON_BYTES})`,
			);
		}
		return JSON.parse(text) as StrydRecommendationSet;
	}

	/**
	 * Mark a workout in a recommendation set as the user's selection.
	 *
	 * Verified empirically 2026-05-25: Stryd accepts the PATCH, returns 200
	 * with the full updated set, and the server-side `selected_id` flips
	 * from 0 to the chosen workout id. The side effect is **state-only**:
	 * does NOT create a calendar entry, does NOT schedule. Treat as a
	 * preference signal for Stryd's recommendation engine — fire-and-forget
	 * after any "user picked this workout" action (send-to-stryd,
	 * send-to-intervals, future channels).
	 *
	 * See `notes/stryd-api/spec-recommendations.md` (in the retextor repo)
	 * for the full wire contract.
	 *
	 * - 200 → returns void; the response body is the updated set but
	 *   callers rarely need it.
	 * - 401 → re-runs `login()` once and retries.
	 * - 5xx / other → throws.
	 */
	async markRecommendationSelected(recommendationSetId: string, workoutId: number): Promise<void> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");
		// The recommendation-set id arrives from the upstream Stryd response
		// and is interpolated into the URL path. Validate it's a bare int64
		// string ([0-9]+) before use so a compromised or buggy upstream
		// can't inject path traversal or other URL-shape mischief.
		if (!/^\d+$/.test(recommendationSetId)) {
			throw new Error(
				`StrydClient.markRecommendationSelected: invalid recommendationSetId (must be digits only)`,
			);
		}

		const url = `${API_BASE}/users/${this.userId}/workouts/recommendations/${recommendationSetId}`;
		const doFetch = () =>
			fetch(url, {
				method: "PATCH",
				headers: { ...this.authHeaders(), "Content-Type": "application/json" },
				body: JSON.stringify({ selected_id: workoutId }),
				signal: AbortSignal.timeout(API_TIMEOUT_MS),
			});

		let res = await doFetch();
		if (res.status === 401) {
			await this.login();
			res = await doFetch();
		}

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
			throw new Error(`Stryd markRecommendationSelected failed (HTTP ${res.status}): ${excerpt}`);
		}
		// Drain the body to free the socket. Don't parse — callers don't use it.
		await res.text();
	}

	get isAuthenticated(): boolean {
		return this.token !== null;
	}
}
