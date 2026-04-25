/**
 * GET /api/users/:userId/status — readiness, CP, fitness/fatigue/form.
 *
 * See phase2/exercitator-http-api-spec.md §5.2.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { detectPowerSource } from "../../engine/power-source.js";
import { computeReadiness } from "../../engine/readiness.js";
import { fetchTrainingData } from "../../engine/suggest.js";
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

async function fetchStrydCp(
	user: UserContext,
): Promise<{ watts: number | null; updatedAt: string | null }> {
	if (!user.stryd) return { watts: null, updatedAt: null };
	try {
		if (!user.stryd.isAuthenticated) await user.stryd.login();
		const watts = await user.stryd.getLatestCriticalPower();
		return { watts: watts ?? null, updatedAt: watts != null ? new Date().toISOString() : null };
	} catch (err) {
		console.error("Stryd CP fetch failed:", err);
		return { watts: null, updatedAt: null };
	}
}

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
		const strydCp = await fetchStrydCp(user);

		const isRunSport = user.profile.sports.includes("Run");
		const vigil = isRunSport ? runVigilPipeline(user.profile.id, "Run", now) : null;

		const body: StatusResponse = {
			generated_at: now.toISOString(),
			user_id: user.profile.id,
			athlete_id: user.intervals.athleteId,
			readiness: readinessFromEngine(readiness.score, data.wellness, data.wellness.length >= 3),
			injury_warning: injuryWarningFromVigil(vigil),
			critical_power: criticalPowerFromContext(powerContext, strydCp.watts, strydCp.updatedAt),
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
