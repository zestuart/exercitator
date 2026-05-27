/**
 * Promus DSW (Daily Suggested Workout) emitter.
 *
 * Fires a fire-and-forget `POST /api/ingest/dsw` to Promus after each
 * vendor-attempted prescription (Stryd for Run, FORM for Swim), so the
 * longitudinal fitness:readiness:workout corpus can correlate engine
 * inputs against the served candidates. The emitter NEVER blocks the
 * prescription — any error is logged via console.warn and dropped.
 *
 * Endpoint contract:
 *   - issue #164 / PR #165 (merged 2026-05-25) — original Stryd path.
 *   - issue #168 (open 2026-05-26) — `stryd_recommendation_set` →
 *     `vendor_recommendation_set` rename; required for FORM emission.
 *     FORM emission stays gated behind `PROMUS_FORM_DSW_ENABLED=1`
 *     until #168 ships, so Exercitator can land the FORM-side code
 *     dark.
 *
 * Idempotency is enforced server-side via the natural key
 * `(user_id, date, sport, source)` — re-renders within a day upsert
 * in place, so this emitter does no client-side dedup. The same key
 * separates Stryd Run rows from FORM Swim rows even for the same
 * user/date.
 */

import type { WorkoutSuggestion } from "../engine/types.js";
import type { FormRecommendationSet, FormWorkoutBody } from "../form/client.js";
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
 * Read a Response body as text, aborting once `maxBytes` has been
 * accumulated. Defence against memory exhaustion from a compromised
 * upstream returning an arbitrarily large body. Same posture as the
 * `parseBoundedJson` cap on the Stryd/FORM clients but adapted for the
 * error-body path here, where we only need the first few KB for the
 * log excerpt.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (text.length < maxBytes) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		if (text.length >= maxBytes) {
			await reader.cancel().catch(() => {});
		}
	} catch {
		// Stream errors — return whatever we managed to accumulate.
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Already-released reader after cancel() — harmless.
		}
	}
	return text.slice(0, maxBytes);
}

/**
 * Caller-facing input. The emitter never inspects the engine's intermediate
 * state directly — it consumes the finalised suggestion + the raw vendor
 * response side-by-side.
 *
 * The `kind` discriminator selects the wire-field name and the picked
 * workout id type (Stryd: numeric int64; FORM: UUID-v7 string).
 */
export type DswEmitInput =
	| {
			kind: "stryd";
			userId: string;
			/** User-local date the prescription is for (YYYY-MM-DD). */
			date: string;
			sport: "Run" | "Swim";
			/** The suggestion AFTER the Stryd swap has run (or the engine's output if no swap). */
			suggestion: WorkoutSuggestion;
			/** Raw Stryd response body, when available. Null on 204 / 5xx / network. */
			strydRecommendationSet: StrydRecommendationSet | null;
	  }
	| {
			kind: "form";
			userId: string;
			/** User-local date the prescription is for (YYYY-MM-DD). */
			date: string;
			sport: "Run" | "Swim";
			/** The suggestion AFTER the FORM swap has run. */
			suggestion: WorkoutSuggestion;
			/** Raw FORM personalised list, when available. Null on errors / picker rejection. */
			formRecommendationSet: FormRecommendationSet | null;
			/** Per-workout body map (FORM's two-call pattern). Null on errors. */
			formBodies: Map<string, FormWorkoutBody> | null;
	  };

/** Wire shape — matches Promus's `DswIngest` request body.
 *
 * Field-name dual-write transition: Promus issue #168 renames
 * `stryd_recommendation_set` → `vendor_recommendation_set`. During the
 * transition, the Stryd path keeps sending the legacy name; the FORM
 * path uses the new name (and only fires after Promus #168 deploys —
 * gated by PROMUS_FORM_DSW_ENABLED). Both fields are optional on the
 * wire so future-Promus can ignore whichever it doesn't recognise. */
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
	/** Legacy column name; populated only on the Stryd path during transition. */
	stryd_recommendation_set?: unknown;
	/** Renamed column (Promus #168); populated on the FORM path. */
	vendor_recommendation_set?: unknown;
	exercitator_context: unknown;
}

/**
 * Build the Promus payload from a finalised suggestion + the raw vendor
 * response. Returns `null` when the input is not a DSW-loggable case:
 *   - prescriptionSource is undefined (engine-only; Pam, or a sport
 *     other than the one we wrap)
 *   - prescriptionSource is "exercitator" (rest day; no vendor call
 *     made, not interesting for the vendor-vs-engine corpus)
 *
 * Vendor-success ("stryd" / "form") and "exercitator-fallback" both
 * emit — fallbacks are first-class data (we want to know how often the
 * vendor is unreachable / unhelpful). The `kind` discriminator on the
 * input selects Stryd-shape vs FORM-shape fields.
 */
export function buildDswPayload(input: DswEmitInput): DswPayload | null {
	const src = input.suggestion.prescriptionSource;
	if (src !== "stryd" && src !== "form" && src !== "exercitator-fallback") {
		return null;
	}

	if (input.kind === "stryd") {
		return buildStrydDswPayload(input);
	}
	return buildFormDswPayload(input);
}

function buildStrydDswPayload(input: Extract<DswEmitInput, { kind: "stryd" }>): DswPayload | null {
	const { userId, date, sport, suggestion, strydRecommendationSet } = input;
	const src = suggestion.prescriptionSource;

	// On the Stryd surface we only emit when Stryd was attempted (success
	// or fallback). A FORM-sourced suggestion that reached this branch
	// must be a routing bug — bail.
	if (src !== "stryd" && src !== "exercitator-fallback") return null;
	if (src === "exercitator-fallback" && suggestion.fallbackVendor === "form") return null;

	// Both branches log `source = "stryd"` because Stryd WAS attempted —
	// the distinction "did we use Stryd's workout or fall back?" lives on
	// `fallback_used`, not on `source`.
	const source = "stryd";
	const fallbackUsed = src === "exercitator-fallback";

	const payload: DswPayload = {
		user_id: userId,
		date,
		sport,
		source,
		category: suggestion.category,
		fallback_used: fallbackUsed,
		// Legacy column name during the Promus #168 transition.
		stryd_recommendation_set: strydRecommendationSet ?? {},
		exercitator_context: buildExercitatorContext(suggestion),
	};

	if (!fallbackUsed && suggestion.strydWorkoutId !== undefined) {
		// Promus wants this as a string to dodge int64-precision issues
		// across JS clients.
		payload.picked_workout_id = String(suggestion.strydWorkoutId);
	}
	if (suggestion.strydWorkoutTitle) {
		payload.picked_workout_title = suggestion.strydWorkoutTitle;
	}
	if (strydRecommendationSet && !fallbackUsed) {
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

function buildFormDswPayload(input: Extract<DswEmitInput, { kind: "form" }>): DswPayload | null {
	const { userId, date, sport, suggestion, formRecommendationSet } = input;
	const src = suggestion.prescriptionSource;

	if (src !== "form" && src !== "exercitator-fallback") return null;
	// Cross-routing guard mirroring the Stryd branch.
	if (src === "exercitator-fallback" && suggestion.fallbackVendor !== "form") return null;

	const source = "form";
	const fallbackUsed = src === "exercitator-fallback";

	const payload: DswPayload = {
		user_id: userId,
		date,
		sport,
		source,
		category: suggestion.category,
		fallback_used: fallbackUsed,
		// Renamed column name (Promus #168) — FORM emission requires
		// the rename to have shipped on the Promus side. Contains only
		// the personalised list metadata (no setGroups). The picked
		// workout's full setGroups[] body is bundled into
		// `exercitator_context.picked_workout_body` below so future
		// replay-from-Promus (Promus #167) is byte-equal-deterministic
		// regardless of whether FORM later mutates the workout for the
		// same UUID (revisionNumber on the wire indicates this is
		// possible, even if not observed).
		vendor_recommendation_set: formRecommendationSet ?? {},
		exercitator_context: buildExercitatorContext(
			suggestion,
			// On the success path the swap layer preserves the FORM
			// body verbatim via `formOriginalWorkout`. On fallback this
			// is undefined; the context omits the field cleanly.
			fallbackUsed ? undefined : suggestion.formOriginalWorkout,
		),
	};

	if (!fallbackUsed && suggestion.formWorkoutId !== undefined) {
		payload.picked_workout_id = suggestion.formWorkoutId;
	}
	if (suggestion.formWorkoutTitle) {
		payload.picked_workout_title = suggestion.formWorkoutTitle;
	}
	if (formRecommendationSet && !fallbackUsed) {
		const picked = formRecommendationSet.workouts.find(
			(w) => w.workout.id === suggestion.formWorkoutId,
		);
		if (picked) {
			payload.picked_workout_type = picked.type;
		}
	}
	if (suggestion.formPickRationale) {
		payload.picked_strategy_rationale = suggestion.formPickRationale;
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
 *
 * Optional `pickedWorkoutBody` carries the vendor's full picked-workout
 * payload (Stryd: already in `stryd_recommendation_set.workouts[i]
 * .estimated_workout.workout`; FORM: not in `vendor_recommendation_set`
 * because the /personalized list omits setGroups, so we bundle the
 * picked body here). This guarantees byte-equal replay-from-Promus
 * (Promus #167) even if the vendor later mutates the workout body for
 * the same id.
 */
function buildExercitatorContext(
	suggestion: WorkoutSuggestion,
	pickedWorkoutBody?: unknown,
): unknown {
	return {
		readiness_score: suggestion.readiness_score,
		cp_or_ftp: suggestion.power_context.ftp,
		power_source: suggestion.power_context.source,
		vigil_severity: suggestion.vigil?.severity ?? 0,
		vigil_status: suggestion.vigil?.status ?? null,
		warnings_count: suggestion.warnings.length,
		...(pickedWorkoutBody !== undefined && { picked_workout_body: pickedWorkoutBody }),
		// TODO(phase4-deeper): plumb days_since_hard, fitness_ctl,
		//  fatigue_atl, form_tsb, hrv_recent, sleep_debt_nights,
		//  cross_training_strain, staleness_tier from the engine's
		//  intermediate state. Open follow-up issue once the corpus has
		//  enough records to motivate the schema.
	};
}

/**
 * Returns true when FORM-side DSW emission is enabled. Stays false
 * until the Promus #168 rename (`stryd_recommendation_set` →
 * `vendor_recommendation_set`) has shipped, otherwise Promus would
 * reject the new field name. Operator flips PROMUS_FORM_DSW_ENABLED=1
 * to turn it on; reverting to 0 (or unset) disables again.
 */
function formDswEnabled(): boolean {
	const v = process.env.PROMUS_FORM_DSW_ENABLED;
	return v === "1" || v === "true";
}

/**
 * Fire-and-forget Promus emission. Always returns synchronously to the
 * caller — the network request runs in the background. Use the returned
 * Promise only for testing; production callers should ignore it.
 *
 * FORM-kind inputs no-op when `PROMUS_FORM_DSW_ENABLED` is not set —
 * the gate exists so the FORM emitter code can ship before Promus #168
 * deploys without sending a field name Promus doesn't yet accept.
 */
export function emitDsw(input: DswEmitInput): Promise<void> {
	if (input.kind === "form" && !formDswEnabled()) {
		return Promise.resolve();
	}

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
				// Bounded read of the error body — defends against a
				// compromised Promus returning a huge response that
				// would exhaust container memory (praescriptor is
				// 256 MB-limited). 4 KB headroom for any real JSON
				// error envelope; logged excerpt is the first 200
				// chars only. Same posture as the parseBoundedJson
				// 1 MB cap on Stryd/FORM clients.
				const text = await readBoundedText(res, 4096).catch(() => "");
				const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
				// Sanitise control chars before logging — defends against log
				// injection if a compromised/MitM'd Promus response embeds
				// CR/LF/etc. in the error body. Same pattern as the Stryd
				// and FORM swap fallback paths (SECURITY.md #25, #33).
				const sanitised = excerpt.replace(/[\r\n\t\v\f]/g, " ");
				console.warn(
					`emitDsw: Promus returned HTTP ${res.status} for ${input.userId}/${input.date}/${input.sport}: ${sanitised}`,
				);
			}
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			const sanitised = msg.replace(/[\r\n\t\v\f]/g, " ");
			console.warn(
				`emitDsw: fetch failed for ${input.userId}/${input.date}/${input.sport}: ${sanitised}`,
			);
		});
}
