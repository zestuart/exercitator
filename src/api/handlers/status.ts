/**
 * GET /api/users/:userId/status — readiness, CP, fitness/fatigue/form.
 *
 * See phase2/exercitator-http-api-spec.md §5.2.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { detectPowerSource } from "../../engine/power-source.js";
import { computeReadiness } from "../../engine/readiness.js";
import { fetchStrydCpInput, fetchTrainingData } from "../../engine/suggest.js";
import { runVigilBackfillIfNeeded } from "../../engine/vigil/backfill.js";
import { runVigilPipeline } from "../../engine/vigil/index.js";
import { cacheGet, cacheSet } from "../cache.js";
import { apiError, jsonResponse } from "../errors.js";
import {
	criticalPowerFromContext,
	injuryWarningFromVigil,
	lastWorkoutFromActivities,
	readinessFromEngine,
	trainingLoadFromActivities,
} from "../payload.js";
import type { UserContext } from "../router.js";
import type { StatusResponse } from "../types.js";

export async function handleStatus(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
): Promise<void> {
	const cached = cacheGet<StatusResponse>(user.profile.id, "status");
	if (cached) {
		res.setHeader("Cache-Control", "private, max-age=300");
		jsonResponse(res, 200, cached);
		return;
	}

	try {
		const data = await fetchTrainingData(user.intervals);
		const now = new Date();
		const powerContext = detectPowerSource(data.activities);
		const readiness = computeReadiness(data.wellness, data.activities, now);
		const strydCp = await fetchStrydCpInput(user.stryd ?? null, now);
		// Convert the engine-shape CP into the API DTO shape — `updatedAt` is
		// the real Stryd CP creation timestamp (not now()), letting clients
		// detect stale CP without a separate API call.
		const strydCpForApi = strydCp
			? {
					watts: strydCp.cp,
					updatedAt:
						strydCp.ageDays != null
							? new Date(now.getTime() - strydCp.ageDays * 86_400_000).toISOString()
							: null,
				}
			: { watts: null as number | null, updatedAt: null as string | null };

		const isRunSport = user.profile.sports.includes("Run");
		const vigil = isRunSport ? runVigilPipeline(user.profile.id, "Run", now) : null;

		// Fire-and-forget Vigil backfill on first call for this athlete.
		// runVigilBackfillIfNeeded short-circuits when (a) no Stryd creds,
		// (b) metrics already present, or (c) a backfill is in-flight.
		// Subsequent /status calls (after the backfill completes) will see
		// real injury_warning data; this call returns the current
		// "building" / "inactive" state.
		if (user.profile.stryd) {
			void runVigilBackfillIfNeeded(user.stryd, user.profile.id);
		}

		const body: StatusResponse = {
			generated_at: now.toISOString(),
			user_id: user.profile.id,
			athlete_id: user.intervals.athleteId,
			readiness: readinessFromEngine(readiness.score, data.wellness, data.wellness.length >= 3),
			injury_warning: injuryWarningFromVigil(vigil),
			critical_power: criticalPowerFromContext(
				powerContext,
				strydCpForApi.watts,
				strydCpForApi.updatedAt,
			),
			training_load: trainingLoadFromActivities(data.wellness, data.activities, now),
			last_workout: lastWorkoutFromActivities(data.activities),
		};

		cacheSet(user.profile.id, "status", body);
		res.setHeader("Cache-Control", "private, max-age=300");
		jsonResponse(res, 200, body);
	} catch (err) {
		console.error("handleStatus failed:", err);
		apiError(res, 502, "upstream error");
	}
}
