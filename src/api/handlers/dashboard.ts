/**
 * GET /api/users/:userId/dashboard — aggregate status + today + suggested.
 *
 * If the suggestion engine returns awaiting_input, `suggested` is null and
 * a top-level `awaiting_input` block is populated instead.
 *
 * See phase2/exercitator-http-api-spec.md §5.8.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { localDateStr } from "../../engine/date-utils.js";
import { detectPowerSource } from "../../engine/power-source.js";
import { computeReadiness } from "../../engine/readiness.js";
import {
	fetchStrydCpInput,
	fetchTrainingData,
	suggestWorkoutFromData,
} from "../../engine/suggest.js";
import type { ActivitySummary, WorkoutSuggestion } from "../../engine/types.js";
import { runVigilBackfillIfNeeded } from "../../engine/vigil/backfill.js";
import { runVigilPipeline } from "../../engine/vigil/index.js";
import { applyFormSwapIfEnabled } from "../../web/form-swap.js";
import {
	generateInvocations,
	plainInvocations,
	plainQuiesMessage,
	quiesInvocation,
} from "../../web/invocations.js";
import { emitDsw } from "../../web/promus-dsw.js";
import { applyStrydSwapIfEnabled } from "../../web/stryd-swap.js";
import { apiError, jsonResponse } from "../errors.js";
import {
	criticalPowerFromContext,
	injuryWarningFromVigil,
	lastWorkoutFromActivities,
	readinessFromEngine,
	suggestionToApi,
	trainingLoadFromActivities,
} from "../payload.js";
import type { UserContext } from "../router.js";
import type {
	DashboardResponse,
	StatusResponse,
	SuggestedResponse,
	TodayCompletedWorkout,
	TodayResponse,
	TodayScheduledWorkout,
} from "../types.js";
import { resolveTz } from "../tz.js";

export async function handleDashboard(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
	url: URL,
): Promise<void> {
	const tz = await resolveTz(user, url);
	const today = localDateStr(new Date(), tz);
	const now = new Date();

	try {
		const data = await fetchTrainingData(user.intervals, tz);

		// Status block
		const powerContext = detectPowerSource(data.activities);
		const readiness = computeReadiness(data.wellness, data.activities, now);
		const strydCpInput = await fetchStrydCpInput(user.stryd ?? null, now);
		const strydCp = strydCpInput?.cp ?? null;
		const strydCpUpdatedAt =
			strydCpInput?.ageDays != null
				? new Date(now.getTime() - strydCpInput.ageDays * 86_400_000).toISOString()
				: null;
		const isRunSport = user.profile.sports.includes("Run");
		const vigil = isRunSport ? runVigilPipeline(user.profile.id, "Run", now, tz) : null;
		if (user.profile.stryd) {
			void runVigilBackfillIfNeeded(user.stryd, user.profile.id);
		}

		const status: StatusResponse = {
			generated_at: now.toISOString(),
			user_id: user.profile.id,
			athlete_id: user.intervals.athleteId,
			readiness: readinessFromEngine(readiness.score, data.wellness, data.wellness.length >= 3),
			injury_warning: injuryWarningFromVigil(vigil),
			critical_power: criticalPowerFromContext(powerContext, strydCp, strydCpUpdatedAt),
			training_load: trainingLoadFromActivities(data.wellness, data.activities, now),
			last_workout: lastWorkoutFromActivities(data.activities),
		};

		// Today block — intervals.icu events for today + activities filtered to today
		const todays = data.activities.filter((a) => a.start_date_local.startsWith(today));
		const completed: TodayCompletedWorkout[] = todays.map((a: ActivitySummary) => ({
			id: `iv-${a.id}`,
			name: a.type,
			type: a.type,
			started_at: a.start_date_local.endsWith("Z") ? a.start_date_local : `${a.start_date_local}Z`,
			duration_s: a.moving_time,
			tss: a.icu_training_load ?? null,
			intensity_factor: a.icu_intensity != null ? +(a.icu_intensity / 100).toFixed(2) : null,
			avg_power_w: a.icu_average_watts ?? null,
			planned_id: null,
		}));

		let scheduled: TodayScheduledWorkout[] = [];
		try {
			const events = await user.intervals.get<
				Array<{
					id: number | string;
					name?: string;
					type?: string;
					category?: string;
					moving_time?: number;
					icu_training_load?: number;
					workout_doc?: { steps?: unknown[] } | null;
				}>
			>(`/athlete/${user.intervals.athleteId}/events`, { oldest: today, newest: today });
			scheduled = events
				.filter((e) => e.category === "WORKOUT")
				.map((e) => ({
					id: `iv-${e.id}`,
					name: e.name ?? "",
					type: e.type ?? "",
					planned_duration_s: e.moving_time ?? null,
					planned_tss: e.icu_training_load ?? null,
					target_power_w: null,
					structured: Array.isArray(e.workout_doc?.steps) && (e.workout_doc.steps.length ?? 0) > 0,
					stryd_pushed: false,
				}));
		} catch {
			scheduled = [];
		}

		const todayBlock: TodayResponse = { date: today, tz, scheduled, completed };

		// Suggested block — run the engine with the already-fetched data
		let suggestedResp: SuggestedResponse | null = null;
		let awaitingInput: DashboardResponse["awaiting_input"] = null;
		let suggestion: WorkoutSuggestion;
		try {
			suggestion = suggestWorkoutFromData(
				data,
				user.profile.sports[0] ?? "Run",
				now,
				undefined,
				strydCpInput,
				user.profile.id,
				tz,
			);
			if (suggestion.status === "awaiting_input" && suggestion.awaitingInput) {
				awaitingInput = {
					reason: suggestion.awaitingInput.reason,
					activity_id: suggestion.awaitingInput.activityId,
					activity_name: suggestion.awaitingInput.activityName,
					activity_type: suggestion.awaitingInput.activityType,
					prompt: suggestion.awaitingInput.prompt,
				};
			} else if (suggestion.status === "already_trained" && suggestion.restMessage) {
				// Suppression short-circuit (API 0.2.0). Skip vendor swap
				// entirely. Render layer + native clients branch on the
				// already_trained status and show the Quies card.
				const rm = suggestion.restMessage;
				const invocations = user.profile.deities
					? await quiesInvocation(rm.trainedSport, rm.alternateSport, today)
					: plainQuiesMessage(rm.trainedSport, rm.alternateSport);
				suggestedResp = {
					generated_at: now.toISOString(),
					user_id: user.profile.id,
					date: today,
					tz,
					status: "already_trained",
					suggestion: suggestionToApi(suggestion, strydCp != null),
					rest_message: {
						trained_sport: rm.trainedSport,
						trained_activity_id: rm.trainedActivityId,
						trained_activity_type: rm.trainedActivityType,
						trained_at: rm.trainedAt,
						alternate_sport: rm.alternateSport,
						invocation: invocations.opening,
					},
				};
			} else {
				// Same vendor-swap gating as Praescriptor / /workouts/suggested.
				// Sport branches: Run→Stryd, Swim→FORM. DSW emission for FORM
				// lands in Phase 4 (Promus schema rename).
				if (suggestion.sport === "Run") {
					const swap = await applyStrydSwapIfEnabled(suggestion, user.profile, user.stryd);
					suggestion = swap.suggestion;
					void emitDsw({
						kind: "stryd",
						userId: user.profile.id,
						date: today,
						sport: suggestion.sport,
						suggestion,
						strydRecommendationSet: swap.strydRecommendationSet,
					});
				} else if (suggestion.sport === "Swim") {
					const swap = await applyFormSwapIfEnabled(
						suggestion,
						user.profile,
						user.form,
						data.swimSettings,
					);
					suggestion = swap.suggestion;
					void emitDsw({
						kind: "form",
						userId: user.profile.id,
						date: today,
						sport: suggestion.sport,
						suggestion,
						formRecommendationSet: swap.formRecommendationSet,
						formBodies: swap.formBodies,
						swimSettings: data.swimSettings,
					});
				}
				// API 0.2.1: include the patron-deity / plain invocation in
				// the wire response so native clients (Excubitor) can render
				// the same liturgical frame as Praescriptor.
				const invocation = user.profile.deities
					? await generateInvocations(
							suggestion.sport,
							suggestion.category,
							suggestion.readiness_score,
							suggestion.warnings,
							today,
						)
					: plainInvocations(suggestion.sport);
				suggestedResp = {
					generated_at: now.toISOString(),
					user_id: user.profile.id,
					date: today,
					tz,
					status: "ready",
					suggestion: suggestionToApi(suggestion, strydCp != null),
					invocation,
				};
			}
		} catch (err) {
			console.error("dashboard: suggestion failed:", err);
		}

		const body: DashboardResponse = {
			status,
			today: todayBlock,
			suggested: suggestedResp,
			awaiting_input: awaitingInput,
		};
		jsonResponse(res, 200, body);
	} catch (err) {
		console.error("handleDashboard failed:", err);
		apiError(res, 502, "upstream error");
	}
}
