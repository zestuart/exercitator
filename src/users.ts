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
