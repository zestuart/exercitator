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

async function resolveTz(user: UserContext, url: URL): Promise<string> {
	const q = url.searchParams.get("tz");
	if (q?.includes("/")) return q;
	try {
		const profile = await user.intervals.get<{ timezone?: string }>(
			`/athlete/${user.intervals.athleteId}`,
		);
		return profile.timezone ?? "UTC";
	} catch {
		return "UTC";
	}
}

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
			} else {
				suggestedResp = {
					generated_at: now.toISOString(),
					user_id: user.profile.id,
					date: today,
					tz,
					status: "ready",
					suggestion: suggestionToApi(suggestion, strydCp != null),
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
