/**
 * FORM Athletica API client (smart-coach personalised swim recommendations).
 *
 * Wire contract verified 2026-05-26 — see
 * ~/Documents/claude/retextor/notes/form-api/spec-recommendations.md
 * for the field-by-field annotation. Auth flow ported from the Python
 * reference client at retextor/notes/form-client/personalized.py.
 *
 * Authentication is a three-tier cascade:
 *   1. Read ~/.cache/form-client/oauth.json. If the access token has
 *      > 5 min until expiry, use it as Bearer.
 *   2. Else if the refresh token is alive, POST /oauth/token/refresh
 *      (Basic client-creds + JSON {refreshToken}). Update cache.
 *   3. Else POST /oauth/token (Basic client-creds + JSON {email, password}).
 *      Update cache.
 * On a 401 from a downstream call: invalidate cache + retry once.
 *
 * Zero external deps — Node.js native fetch + fs.
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const API_BASE = "https://app.formathletica.com/api/v1";
const APP_VERSION = "3.19.1";

const API_TIMEOUT_MS = 30_000;

/** Production OAuth client credentials, recovered from a live POST
 *  /oauth/token Authorization: Basic header on 2026-05-26. These ship
 *  in every APK install — not a secret. Per-environment; these are the
 *  production-build pair. See notes/form-app-discovery-2026-05-26.md. */
const CLIENT_ID = "b3333116-ba16-463b-aa1f-6211a7084a6d";
const CLIENT_SECRET =
	"yLhhGl5REJVYaEiIkdiy5q6mOCwq4kAtb6ibc6zSp0eGbNHxCPQPzbSIyXyoA6pwGM6E2IjAf0pEid65oGGFhAff";

/** Treat tokens within 5 min of expiry as dead — give downstream calls
 *  time to land before the server starts rejecting. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** 1 MB cap on JSON responses. Real payloads observed: personalised
 *  list ~7 KB (3 workouts, metadata only), workout body ~5 KB (4
 *  setGroups, sub-minute drill intervals). 1 MB gives generous
 *  headroom while bounding OOM blast radius from a hostile or
 *  malformed upstream response. */
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;

async function parseBoundedJson<T>(
	res: Response,
	methodLabel: string,
	maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<T> {
	const text = await res.text();
	if (text.length > maxBytes) {
		throw new Error(
			`FORM ${methodLabel}: response too large (${text.length} bytes, limit ${maxBytes})`,
		);
	}
	return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// OAuth response shape (cache + login + refresh share the same envelope)
// ---------------------------------------------------------------------------

export interface FormOAuthToken {
	token: string;
	/** ISO-8601 with `Z` suffix, e.g. "2026-06-25T20:59:24.729Z". */
	expires: string;
	type: string;
}

export interface FormOAuthResponse {
	accessToken: FormOAuthToken;
	refreshToken: FormOAuthToken;
	scope: string;
	clientId: string;
	userId: string;
}

// ---------------------------------------------------------------------------
// Personalised endpoint — list of 3 recommendation summaries (no segments)
// ---------------------------------------------------------------------------

export interface FormRecommendationParameters {
	avgPace: number;
	avgDuration: number;
	maxIntervalDistance: number;
	includeShortCourse: boolean;
	recommendedFocus: string;
	prioritySkill: string;
	templateOverride: string;
	workoutTypes: string[];
	templateConfigs: Array<{
		workoutType: string;
		energySystem: string | null;
		templateOverride: string;
	}>;
	preferredStrokeType: string;
	includeDrills: boolean;
	equipmentExclusions: string[];
	strokeTypesPriority: {
		preferredStrokeType: string;
		secondaryStrokeType: string;
		tertiaryStrokeType: string;
	};
	maxIntervalDistancesByStrokeType: Record<string, number>;
}

/** Summary returned by /personalized. NO setGroups — call getWorkoutById. */
export interface FormWorkoutSummary {
	id: string;
	categories: string[];
	name: string;
	description: string;
	distance: number;
	duration: { min: number; max: number };
	intensityLevel: "low" | "moderate" | "high";
	equipment: Array<{ type: string }>;
	lengthDistances: Array<{ distance: number; measurement: "m" | "yd" }>;
	workoutUrl: string;
	origin: string;
	[k: string]: unknown;
}

export interface FormRecommendation {
	type: string;
	description: string;
	isRecommended: boolean;
	parameters: FormRecommendationParameters;
	workout: FormWorkoutSummary;
}

export interface FormRecommendationSet {
	createdAt: string;
	workouts: FormRecommendation[];
}

// ---------------------------------------------------------------------------
// Workout-detail endpoint — adds setGroups[] to the summary
// ---------------------------------------------------------------------------

export interface FormDrill {
	id: number;
	name: string;
	abbreviation: string;
	type: string;
	progressionLevel: string;
	isCustomDrill: boolean;
	published: boolean;
	thumbnail: string;
	url: string;
}

export interface FormEffort {
	/** Qualitative band — easy | moderate | build | strong | fast observed.
	 *  Mapper widens this on encountering new values. */
	level: string;
	/** Always null in /personalized; structurally allowed but unused on recs. */
	pace: unknown;
	percentage: unknown;
	rpeLevel: unknown;
	splitRange: unknown;
	zone: unknown;
}

export interface FormRest {
	defined: number | null;
	takeoff: number | null;
}

export interface FormSet {
	intervalDistance: number;
	intervalsCount: number;
	strokeType: string;
	effort: FormEffort;
	rest: FormRest | null;
	equipment: Array<{ type: string }>;
	drill: FormDrill | null;
	endDrill: FormDrill | null;
	endStrokeType: string | null;
	headCoachFocusMode: string | null;
	description: string;
}

export interface FormSetGroup {
	groupType: "warmup" | "preSet" | "main" | "cooldown" | string;
	roundDistance: number;
	roundsCount: number;
	sets: FormSet[];
}

export interface FormWorkoutBody extends FormWorkoutSummary {
	setGroups: FormSetGroup[];
	similarWorkouts: FormWorkoutSummary[];
	scheduledAt: string | null;
	importedWorkoutReviewState: unknown;
}

export interface FormPersonalizedWithBodies {
	set: FormRecommendationSet;
	bodies: Map<string, FormWorkoutBody>;
}

// ---------------------------------------------------------------------------
// Cache layer — file-backed, shared with the Python reference client
// ---------------------------------------------------------------------------

function defaultCachePath(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
	return join(base, "form-client", "oauth.json");
}

function parseIsoExpiry(iso: string | undefined): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? null : t;
}

function isTokenAlive(tok: FormOAuthToken | undefined): boolean {
	if (!tok) return false;
	const exp = parseIsoExpiry(tok.expires);
	if (exp === null) return false;
	return Date.now() + EXPIRY_SKEW_MS < exp;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface FormConfig {
	email: string;
	password: string;
	/** Override the on-disk cache location (default ~/.cache/form-client/oauth.json).
	 *  Pass `null` to disable file caching entirely (useful in tests). */
	cachePath?: string | null;
}

function authHeaders(accessToken: string): Record<string, string> {
	return {
		"X-form-app-version": APP_VERSION,
		Authorization: `Bearer ${accessToken}`,
	};
}

function basicAuthHeader(): string {
	const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
	return `Basic ${creds}`;
}

export class FormClient {
	private oauth: FormOAuthResponse | null = null;
	private readonly email: string;
	private readonly password: string;
	private readonly cachePath: string | null;

	constructor(config: FormConfig) {
		this.email = config.email;
		this.password = config.password;
		this.cachePath = config.cachePath === undefined ? defaultCachePath() : config.cachePath;
	}

	// --- cache helpers ------------------------------------------------------

	private loadCache(): FormOAuthResponse | null {
		if (!this.cachePath) return null;
		try {
			const raw = readFileSync(this.cachePath, "utf-8");
			return JSON.parse(raw) as FormOAuthResponse;
		} catch {
			return null;
		}
	}

	private saveCache(oauth: FormOAuthResponse): void {
		if (!this.cachePath) return;
		try {
			mkdirSync(dirname(this.cachePath), { recursive: true });
			writeFileSync(this.cachePath, JSON.stringify(oauth, null, 2), "utf-8");
			chmodSync(this.cachePath, 0o600);
		} catch {
			// Best-effort: cache failures don't break the in-memory flow.
		}
	}

	private invalidateCache(): void {
		if (!this.cachePath) return;
		try {
			unlinkSync(this.cachePath);
		} catch {
			// File may not exist — fine.
		}
	}

	// --- auth flows ---------------------------------------------------------

	private async login(): Promise<FormOAuthResponse> {
		const res = await fetch(`${API_BASE}/oauth/token`, {
			method: "POST",
			headers: {
				Authorization: basicAuthHeader(),
				"Content-Type": "application/json",
				"X-form-app-version": APP_VERSION,
			},
			body: JSON.stringify({ email: this.email, password: this.password }),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			const excerpt = body.length > 200 ? `${body.slice(0, 200)}…` : body;
			throw new Error(`FORM login failed (HTTP ${res.status}): ${excerpt}`);
		}

		const oauth = await parseBoundedJson<FormOAuthResponse>(res, "login");
		this.saveCache(oauth);
		return oauth;
	}

	private async refresh(refreshToken: string): Promise<FormOAuthResponse | null> {
		const res = await fetch(`${API_BASE}/oauth/token/refresh`, {
			method: "POST",
			headers: {
				Authorization: basicAuthHeader(),
				"Content-Type": "application/json",
				"X-form-app-version": APP_VERSION,
			},
			body: JSON.stringify({ refreshToken }),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) return null;

		const oauth = await parseBoundedJson<FormOAuthResponse>(res, "refresh");
		this.saveCache(oauth);
		return oauth;
	}

	/** Acquire a live OAuth via cache → refresh → login cascade. Idempotent;
	 *  callers may invoke before any data fetch or rely on lazy-acquire in
	 *  the per-call helper. */
	async acquireToken(forceLogin = false): Promise<FormOAuthResponse> {
		if (this.oauth && isTokenAlive(this.oauth.accessToken)) return this.oauth;

		if (!forceLogin) {
			const cached = this.loadCache();
			if (cached) {
				if (isTokenAlive(cached.accessToken)) {
					this.oauth = cached;
					return cached;
				}
				if (isTokenAlive(cached.refreshToken)) {
					const refreshed = await this.refresh(cached.refreshToken.token);
					if (refreshed) {
						this.oauth = refreshed;
						return refreshed;
					}
					// Refresh failed → fall through to full login.
				}
			}
		}

		const fresh = await this.login();
		this.oauth = fresh;
		return fresh;
	}

	private accessToken(): string {
		if (!this.oauth) throw new Error("FormClient: not authenticated — call acquireToken() first");
		return this.oauth.accessToken.token;
	}

	// --- data fetches -------------------------------------------------------

	/** Generic GET with 401 → invalidate-cache + relogin + retry-once. */
	private async getWithRetry(path: string, methodLabel: string): Promise<Response> {
		await this.acquireToken();
		const url = `${API_BASE}${path}`;

		const doFetch = () =>
			fetch(url, {
				headers: authHeaders(this.accessToken()),
				signal: AbortSignal.timeout(API_TIMEOUT_MS),
			});

		let res = await doFetch();
		if (res.status === 401) {
			this.invalidateCache();
			this.oauth = null;
			await this.acquireToken(true);
			res = await doFetch();
		}

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			const excerpt = body.length > 200 ? `${body.slice(0, 200)}…` : body;
			throw new Error(`FORM ${methodLabel} failed (HTTP ${res.status}): ${excerpt}`);
		}
		return res;
	}

	/** Fetch the personalised recommendation list (3 metadata summaries).
	 *  Does NOT include setGroups — pair with getWorkoutById or
	 *  getPersonalizedWithBodies. */
	async getPersonalizedWorkouts(): Promise<FormRecommendationSet> {
		const res = await this.getWithRetry(
			"/users/me/workouts/smart_coach/personalized",
			"getPersonalizedWorkouts",
		);
		return parseBoundedJson<FormRecommendationSet>(res, "getPersonalizedWorkouts");
	}

	/** Fetch the full structured workout body (with setGroups[]) by id. */
	async getWorkoutById(id: string): Promise<FormWorkoutBody> {
		// FORM workout ids are UUID-v7. Guard against path-traversal / unexpected
		// shapes by enforcing the canonical hex-with-dashes format.
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
			throw new Error("FormClient.getWorkoutById: invalid id (must be UUID format)");
		}
		const res = await this.getWithRetry(`/workouts/${id}`, "getWorkoutById");
		return parseBoundedJson<FormWorkoutBody>(res, "getWorkoutById");
	}

	/** Fetch the personalised list + all referenced workout bodies in
	 *  parallel. Returns the set alongside a map from workout id → body.
	 *  Useful for the swap layer which needs both the metadata (for
	 *  picking) and the segments (for converting). */
	async getPersonalizedWithBodies(): Promise<FormPersonalizedWithBodies> {
		const set = await this.getPersonalizedWorkouts();
		const ids = set.workouts.map((w) => w.workout.id);
		const bodies = await Promise.all(ids.map((id) => this.getWorkoutById(id)));
		const map = new Map<string, FormWorkoutBody>();
		for (const body of bodies) map.set(body.id, body);
		return { set, bodies: map };
	}

	get isAuthenticated(): boolean {
		return this.oauth !== null && isTokenAlive(this.oauth.accessToken);
	}

	/** Exposed for tests / advanced callers. */
	getUserId(): string | null {
		return this.oauth?.userId ?? null;
	}
}
