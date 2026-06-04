/**
 * User profile registry for multi-user Praescriptor.
 *
 * Each user is identified by a URL slug (e.g. /ze/, /pam/) and has
 * independent intervals.icu credentials, sport preferences, and
 * feature flags.
 */

export interface UserProfile {
	/** URL slug — used as path prefix. */
	id: string;
	/** Display name shown in the UI. */
	displayName: string;
	/** Which sports to generate prescriptions for. */
	sports: ("Run" | "Swim")[];
	/** Whether to generate deity invocations (Roman liturgical style). */
	deities: boolean;
	/** Whether Stryd FIT enrichment and Vigil biomechanical alerts apply. */
	stryd: boolean;
	/** Environment variable name holding this user's intervals.icu API key. */
	apiKeyEnv: string;
	/** Environment variable name for Stryd email (null if stryd: false). */
	strydEmailEnv: string | null;
	/** Environment variable name for Stryd password (null if stryd: false). */
	strydPasswordEnv: string | null;
	/**
	 * Optional override for the run-prescription source. When `"stryd"`, the
	 * engine still decides the category (readiness, Vigil, sleep debt,
	 * cross-training, staleness all gate as normal), but the segments are
	 * replaced by a Stryd-served workout chosen via intensity_zones overlap.
	 * On any failure (5xx / 401 / 204 / picker rejection) we fall back to the
	 * engine's own segments and surface the fallback reason on the card.
	 * Undefined keeps the engine's builder (default behaviour for Pam).
	 * Swim prescriptions are never affected.
	 */
	runRecommendationSource?: "stryd";
	/**
	 * Optional override for the swim-prescription source. When `"form"`, the
	 * engine still picks the category (readiness, sleep debt, cross-training,
	 * staleness), but the segments are replaced by a FORM-served personalised
	 * workout selected via content scoring (effort-level Z-buckets). On any
	 * failure (5xx / 401 / picker rejection) we fall back to the engine's
	 * own segments. Vigil does NOT apply to swim. Run prescriptions are
	 * unaffected.
	 */
	swimRecommendationSource?: "form";
	/** Environment variable name for FORM email (null if no FORM access). */
	formEmailEnv: string | null;
	/** Environment variable name for FORM password (null if no FORM access). */
	formPasswordEnv: string | null;
	/**
	 * Optional override for the Sleep + HRV readiness telemetry source. When
	 * `"promus-whoop"`, those two components are read from the in-house Promus
	 * WHOOP strap feed instead of intervals.icu wellness (whose Oura-sync sleep
	 * field proved unreliable — see lessons.md 2026-06-03). TSB, Recency, and
	 * Subjective components still come from intervals/activities. If today's
	 * WHOOP night is missing or Promus is unreachable, the suggestion hard-fails
	 * with status `"health_unavailable"` rather than silently degrading.
	 * Undefined keeps the intervals.icu wellness sleep/HRV (default for Pam).
	 */
	healthSource?: "promus-whoop";
	/** Environment variable name for the Promus bearer token (null if unused). */
	promusApiKeyEnv: string | null;
	/** Environment variable name for this user's WHOOP strap serial (null if unused). */
	whoopSerialEnv: string | null;
}

const PROFILES: UserProfile[] = [
	{
		id: "ze",
		displayName: "Ze",
		sports: ["Run", "Swim"],
		deities: true,
		stryd: true,
		apiKeyEnv: "INTERVALS_ICU_API_KEY",
		strydEmailEnv: "STRYD_EMAIL",
		strydPasswordEnv: "STRYD_PASSWORD",
		formEmailEnv: "FORM_EMAIL",
		formPasswordEnv: "FORM_PASSWORD",
		runRecommendationSource: "stryd",
		swimRecommendationSource: "form",
		healthSource: "promus-whoop",
		promusApiKeyEnv: "PROMUS_API",
		whoopSerialEnv: "WHOOP_SERIAL",
	},
	{
		id: "pam",
		displayName: "Pam",
		sports: ["Run"],
		deities: false,
		stryd: true,
		apiKeyEnv: "INTERVALS_ICU_API_KEY_PAM",
		strydEmailEnv: "STRYD_EMAIL_PAM",
		strydPasswordEnv: "STRYD_PASSWORD_PAM",
		formEmailEnv: null,
		formPasswordEnv: null,
		promusApiKeyEnv: null,
		whoopSerialEnv: null,
	},
];

const profileMap = new Map(PROFILES.map((p) => [p.id, p]));

/** Look up a user profile by URL slug. Returns undefined if unknown. */
export function getUserProfile(id: string): UserProfile | undefined {
	return profileMap.get(id);
}

/** All registered user IDs (for root redirect / index). */
export function getUserIds(): string[] {
	return PROFILES.map((p) => p.id);
}

/** The default user to redirect to from /. */
export const DEFAULT_USER = "ze";
