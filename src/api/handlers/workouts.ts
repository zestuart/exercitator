/**
 * GET /api/users/:userId/workouts/{today,suggested,:id}
 *
 * See phase2/exercitator-http-api-spec.md §5.3.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getPrescription } from "../../compliance/persist.js";
import { localDateStr } from "../../engine/date-utils.js";
import { detectPowerSource } from "../../engine/power-source.js";
import { computeReadiness } from "../../engine/readiness.js";
import { selectSport } from "../../engine/sport-selector.js";
import { fetchTrainingData, suggestWorkoutFromData } from "../../engine/suggest.js";
import type { ActivitySummary, WorkoutSuggestion } from "../../engine/types.js";
import { cacheGet, cacheSet } from "../cache.js";
import { apiError, jsonResponse } from "../errors.js";
import { segmentToApi, suggestionToApi } from "../payload.js";
import type { UserContext } from "../router.js";
import type {
	SuggestedResponse,
	TodayCompletedWorkout,
	TodayResponse,
	TodayScheduledWorkout,
} from "../types.js";

// ---------------------------------------------------------------------------
// TZ resolution — mirror Praescriptor's strategy
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// /workouts/today
// ---------------------------------------------------------------------------

interface IntervalsEvent {
	id: number | string;
	name?: string;
	category?: string;
	type?: string;
	start_date_local?: string;
	moving_time?: number;
	icu_training_load?: number;
	target?: unknown;
	workout_doc?: { steps?: unknown[] } | null;
}

function powerRangeFromEvent(evt: IntervalsEvent): [number, number] | null {
	const steps = evt.workout_doc?.steps as
		| Array<{ power?: { value?: number; start?: number; end?: number; units?: string } }>
		| undefined;
	if (!steps?.length) return null;
	let lo = Number.POSITIVE_INFINITY;
	let hi = 0;
	for (const s of steps) {
		const p = s.power;
		if (!p) continue;
		const start = p.start ?? p.value;
		const end = p.end ?? p.value;
		if (start != null) {
			lo = Math.min(lo, start);
			hi = Math.max(hi, start);
		}
		if (end != null) {
			lo = Math.min(lo, end);
			hi = Math.max(hi, end);
		}
	}
	if (!Number.isFinite(lo) || hi === 0) return null;
	return [Math.round(lo), Math.round(hi)];
}

export async function handleWorkoutsToday(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
): Promise<void> {
	const url = new URL(_req.url ?? "/", `http://${_req.headers.host ?? "localhost"}`);
	const tz = await resolveTz(user, url);
	const today = localDateStr(new Date(), tz);

	try {
		const [events, activities] = await Promise.all([
			user.intervals.get<IntervalsEvent[]>(`/athlete/${user.intervals.athleteId}/events`, {
				oldest: today,
				newest: today,
			}),
			user.intervals.get<ActivitySummary[]>(`/athlete/${user.intervals.athleteId}/activities`, {
				oldest: today,
				newest: today,
			}),
		]);

		const scheduled: TodayScheduledWorkout[] = events
			.filter((e) => e.category === "WORKOUT")
			.map((e) => ({
				id: `iv-${e.id}`,
				name: e.name ?? "",
				type: e.type ?? "",
				planned_duration_s: e.moving_time ?? null,
				planned_tss: e.icu_training_load ?? null,
				target_power_w: powerRangeFromEvent(e),
				structured: Array.isArray(e.workout_doc?.steps) && (e.workout_doc.steps.length ?? 0) > 0,
				stryd_pushed: false,
			}));

		const completed: TodayCompletedWorkout[] = activities.map((a) => ({
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

		const body: TodayResponse = { date: today, tz, scheduled, completed };
		jsonResponse(res, 200, body);
	} catch (err) {
		console.error("handleWorkoutsToday failed:", err);
		apiError(res, 502, "upstream error");
	}
}

// ---------------------------------------------------------------------------
// /workouts/suggested
// ---------------------------------------------------------------------------

function emitAwaitingInput(res: ServerResponse, s: WorkoutSuggestion): void {
	const ai = s.awaitingInput;
	if (!ai) {
		apiError(res, 409, "prescription awaiting input");
		return;
	}
	apiError(res, 409, "awaiting cross-training RPE", {
		awaiting_input: {
			reason: ai.reason,
			activity_id: ai.activityId,
			activity_name: ai.activityName,
			activity_type: ai.activityType,
			prompt: ai.prompt,
		},
	});
}

export async function handleWorkoutsSuggested(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
	url: URL,
): Promise<void> {
	// Allowlist `sport` so an arbitrarily long query string can't pollute the
	// cache key and inflate memory under repeated requests.
	const sportParamRaw = url.searchParams.get("sport") ?? "auto";
	const sportParam = sportParamRaw === "Run" || sportParamRaw === "Swim" ? sportParamRaw : "auto";
	const tz = await resolveTz(user, url);
	const cacheKey = `suggested:${sportParam}`;

	const cached = cacheGet<SuggestedResponse>(user.profile.id, cacheKey);
	if (cached && url.searchParams.get("fresh") !== "1") {
		res.setHeader("Cache-Control", "private, max-age=300");
		jsonResponse(res, 200, cached);
		return;
	}

	try {
		const now = new Date();
		const data = await fetchTrainingData(user.intervals, tz);

		// Authoritative CP from Stryd's foot pod when credentials are present —
		// drives the stryd_direct wire enum and overrides intervals.icu's FTP.
		let strydCp: number | null = null;
		if (user.stryd) {
			try {
				if (!user.stryd.isAuthenticated) await user.stryd.login();
				strydCp = (await user.stryd.getLatestCriticalPower()) ?? null;
			} catch (err) {
				console.error("workouts/suggested: Stryd CP fetch failed:", err);
			}
		}

		let sport: "Run" | "Swim";
		let sportSelectionReason: string | undefined;
		if (sportParam === "Run" || sportParam === "Swim") {
			sport = sportParam;
		} else {
			const pc = detectPowerSource(data.activities);
			const readiness = computeReadiness(data.wellness, data.activities, now);
			const sel = selectSport(data.activities, readiness.score, now, pc);
			sport = sel.sport;
			sportSelectionReason = sel.reason;
		}

		const suggestion: WorkoutSuggestion = suggestWorkoutFromData(
			data,
			sport,
			now,
			sportSelectionReason,
			strydCp,
			user.profile.id,
			tz,
		);

		if (suggestion.status === "awaiting_input") {
			emitAwaitingInput(res, suggestion);
			return;
		}

		const body: SuggestedResponse = {
			generated_at: now.toISOString(),
			user_id: user.profile.id,
			date: localDateStr(now, tz),
			tz,
			status: "ready",
			suggestion: suggestionToApi(suggestion, strydCp != null),
		};

		cacheSet(user.profile.id, cacheKey, body);
		res.setHeader("Cache-Control", "private, max-age=300");
		jsonResponse(res, 200, body);
	} catch (err) {
		console.error("handleWorkoutsSuggested failed:", err);
		apiError(res, 502, "upstream error");
	}
}

// ---------------------------------------------------------------------------
// /workouts/:id
// ---------------------------------------------------------------------------

export async function handleWorkoutDetail(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
	id: string,
): Promise<void> {
	// Synthetic prescription id: prescribed-<userId>-<date>-<sport>
	const prescribedMatch = id.match(/^prescribed-([^-]+)-(\d{4}-\d{2}-\d{2})-(Run|Swim)$/);
	if (prescribedMatch) {
		const [, prescribedUser, date, sport] = prescribedMatch;
		if (prescribedUser !== user.profile.id) {
			apiError(res, 404, "unknown workout");
			return;
		}
		const row = getPrescription(user.profile.id, date, sport);
		if (!row) {
			apiError(res, 404, "unknown workout");
			return;
		}
		let suggestion: WorkoutSuggestion | null = null;
		try {
			suggestion = JSON.parse(row.suggestionJson) as WorkoutSuggestion;
		} catch {
			suggestion = null;
		}
		const body = suggestion
			? {
					id,
					date,
					source: "suggested",
					created_at: row.generatedAt,
					...suggestionToApi(suggestion),
				}
			: {
					id,
					date,
					sport,
					category: row.category,
					title: row.title,
					planned_duration_s: row.totalDurationSecs,
					planned_tss: row.estimatedLoad,
					source: "suggested",
					segments: row.segments.map((s) => segmentToApi(s, sport as "Run" | "Swim")),
					created_at: row.generatedAt,
				};
		jsonResponse(res, 200, body);
		return;
	}

	// intervals.icu activity or event: iv-<id>
	const ivMatch = id.match(/^iv-(.+)$/);
	if (ivMatch) {
		const rawId = ivMatch[1];
		try {
			const activity = await user.intervals.get<ActivitySummary>(
				`/activity/${encodeURIComponent(rawId)}`,
			);
			jsonResponse(res, 200, {
				id,
				name: activity.type,
				type: activity.type,
				duration_s: activity.moving_time,
				tss: activity.icu_training_load ?? null,
				intensity_factor:
					activity.icu_intensity != null ? +(activity.icu_intensity / 100).toFixed(2) : null,
				started_at: activity.start_date_local.endsWith("Z")
					? activity.start_date_local
					: `${activity.start_date_local}Z`,
				source: "intervals",
			});
			return;
		} catch {
			apiError(res, 404, "unknown workout");
			return;
		}
	}

	apiError(res, 404, "unknown workout");
}
