/**
 * Promus DSW (Daily Suggested Workout) emitter.
 *
 * Fires a fire-and-forget `POST /api/ingest/dsw` to Promus after each
 * Stryd-attempted run prescription, so the longitudinal
 * fitness:readiness:workout corpus can correlate engine inputs against
 * Stryd's served candidates. The emitter NEVER blocks the prescription —
 * any error is logged via console.warn and dropped.
 *
 * Endpoint contract: see Promus repo issue #164 / PR #165 (merged
 * 2026-05-25). Idempotency is enforced server-side via the natural key
 * `(user_id, date, sport, source)` — re-renders within a day upsert in
 * place, so this emitter does no client-side dedup.
 */

import type { WorkoutSuggestion } from "../engine/types.js";
import type { StrydRecommendationSet } from "../stryd/client.js";

/**
 * Base URL of the Promus instance. Defaults to the tailnet-internal
 * service; override with `PROMUS_URL` for staging / alternate hosts.
 */
const PROMUS_URL_DEFAULT = "https://promus.tail7ab379.ts.net";

/**
 * Promus bearer token. The env var is hyphenated to match the existing
 * `.env` convention (`promus-api=…`). Bracket-access is required because
 * `process.env.promus-api` is not a valid identifier.
 */
function promusToken(): string | null {
	// `||` (not `??`) so that an empty-string env var (the common
	// docker-compose default `${PROMUS_API:-}`) falls through to null
	// rather than being treated as a valid token.
	const t = process.env["promus-api"] || process.env.PROMUS_API;
	return t || null;
}

function promusUrl(): string {
	// `||` for the same reason — an unset/empty env var must fall
	// through to the tailnet default, not pass an empty string to fetch().
	return process.env.PROMUS_URL || PROMUS_URL_DEFAULT;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Caller-facing input. The emitter never inspects the engine's intermediate
 * state directly — it consumes the finalised suggestion + the raw Stryd
 * response side-by-side.
 */
export interface DswEmitInput {
	userId: string;
	/** User-local date the prescription is for (YYYY-MM-DD). */
	date: string;
	sport: "Run" | "Swim";
	/** The suggestion AFTER the Stryd swap has run (or the engine's output if no swap). */
	suggestion: WorkoutSuggestion;
	/** Raw Stryd response body, when available. Null on 204 / 5xx / network. */
	strydRecommendationSet: StrydRecommendationSet | null;
}

/** Wire shape — matches Promus's `DswIngest` request body. */
export interface DswPayload {
	user_id: string;
	date: string;
	sport: string;
	source: string;
	category: string;
	picked_workout_id?: string;
	picked_workout_title?: string;
	picked_workout_type?: string;
	picked_strategy_rationale?: string;
	fallback_used: boolean;
	fallback_reason?: string;
	stryd_recommendation_set: unknown;
	exercitator_context: unknown;
}

/**
 * Build the Promus payload from a finalised suggestion + the raw Stryd
 * response. Returns `null` when the input is not a DSW-loggable case:
 *   - prescriptionSource is undefined (engine-only; Pam, or a sport other
 *     than the one we wrap)
 *   - prescriptionSource is "exercitator" (rest day; no Stryd call made,
 *     not interesting for the Stryd-vs-engine corpus)
 *
 * "stryd" and "exercitator-fallback" both emit — fallbacks are first-class
 * data (we want to know how often Stryd is unreachable / unhelpful).
 */
export function buildDswPayload(input: DswEmitInput): DswPayload | null {
	const { userId, date, sport, suggestion, strydRecommendationSet } = input;

	const src = suggestion.prescriptionSource;
	if (src !== "stryd" && src !== "exercitator-fallback") {
		return null;
	}

	// Both branches log `source = "stryd"` because Stryd WAS attempted —
	// the distinction "did we use Stryd's workout or fall back?" lives on
	// `fallback_used`, not on `source`. (`source = "exercitator"` is
	// reserved for prescriptions where Stryd was never consulted, which
	// today only happens on rest days.)
	const source = "stryd";
	const fallbackUsed = src === "exercitator-fallback";

	const payload: DswPayload = {
		user_id: userId,
		date,
		sport,
		source,
		category: suggestion.category,
		fallback_used: fallbackUsed,
		// Promus accepts `null` here; we send `{}` to match the
		// NOT NULL DEFAULT '{}'::jsonb on the column.
		stryd_recommendation_set: strydRecommendationSet ?? {},
		exercitator_context: buildExercitatorContext(suggestion),
	};

	if (!fallbackUsed && suggestion.strydWorkoutId !== undefined) {
		// Promus wants this as a string to dodge int64-precision issues
		// across JS clients (consistent with how Stryd serialises its own
		// recommendation-set id as a string).
		payload.picked_workout_id = String(suggestion.strydWorkoutId);
	}
	if (suggestion.strydWorkoutTitle) {
		payload.picked_workout_title = suggestion.strydWorkoutTitle;
	}
	if (strydRecommendationSet && !fallbackUsed) {
		// Find the picked workout in the set to extract its type. Picker
		// uses scoring + tiebreak; we cross-reference by id.
		const picked = strydRecommendationSet.workouts.find(
			(w) => w.estimated_workout.workout.id === suggestion.strydWorkoutId,
		);
		if (picked) {
			payload.picked_workout_type = picked.estimated_workout.workout.type;
		}
	}
	if (suggestion.strydPickRationale) {
		payload.picked_strategy_rationale = suggestion.strydPickRationale;
	}
	if (fallbackUsed && suggestion.fallbackReason) {
		payload.fallback_reason = suggestion.fallbackReason;
	}

	return payload;
}

/**
 * MVP context object. Captures what is cleanly available on the
 * finalised suggestion. Deeper readiness components (days_since_hard,
 * fitness_ctl/atl/tsb, hrv_recent, sleep_debt_nights,
 * cross_training_strain, staleness_tier) live inside the engine's
 * intermediate state — plumbing them through `WorkoutSuggestion` is a
 * separate refactor and out of scope for this emitter's first cut.
 *
 * The Promus column is JSONB with no schema enforcement, so adding
 * fields later does not require a Promus migration.
 */
function buildExercitatorContext(suggestion: WorkoutSuggestion): unknown {
	return {
		readiness_score: suggestion.readiness_score,
		cp_or_ftp: suggestion.power_context.ftp,
		power_source: suggestion.power_context.source,
		vigil_severity: suggestion.vigil?.severity ?? 0,
		vigil_status: suggestion.vigil?.status ?? null,
		warnings_count: suggestion.warnings.length,
		// TODO(phase4-deeper): plumb days_since_hard, fitness_ctl,
		//  fatigue_atl, form_tsb, hrv_recent, sleep_debt_nights,
		//  cross_training_strain, staleness_tier from the engine's
		//  intermediate state. Open follow-up issue once the corpus has
		//  enough records to motivate the schema.
	};
}

/**
 * Fire-and-forget Promus emission. Always returns synchronously to the
 * caller — the network request runs in the background. Use the returned
 * Promise only for testing; production callers should ignore it.
 */
export function emitDsw(input: DswEmitInput): Promise<void> {
	const payload = buildDswPayload(input);
	if (!payload) {
		return Promise.resolve();
	}

	const token = promusToken();
	if (!token) {
		console.warn("emitDsw: promus-api token not configured; skipping DSW emission");
		return Promise.resolve();
	}

	const url = `${promusUrl()}/api/ingest/dsw`;

	return fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
		.then(async (res) => {
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
				console.warn(
					`emitDsw: Promus returned HTTP ${res.status} for ${input.userId}/${input.date}/${input.sport}: ${excerpt}`,
				);
			}
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`emitDsw: fetch failed for ${input.userId}/${input.date}/${input.sport}: ${msg}`,
			);
		});
}
