/**
 * POST /api/users/:userId/cross-training/:activityId/rpe
 *
 * Writes RPE (1–10) to intervals.icu as perceived_exertion. After submission,
 * the suggestion engine will re-evaluate the activity's strain on the next
 * /workouts/suggested call.
 *
 * See phase2/exercitator-http-api-spec.md §5.5.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { cacheInvalidate } from "../cache.js";
import { apiError, jsonResponse } from "../errors.js";
import type { UserContext } from "../router.js";
import type { CrossTrainingRpeRequest, CrossTrainingRpeResponse } from "../types.js";

function strainTier(sessionRpe: number): "easy" | "moderate" | "hard" {
	// Mirror the thresholds from src/engine/cross-training-strain.ts
	// (absolute fallback: >200 moderate, >400 hard)
	if (sessionRpe > 400) return "hard";
	if (sessionRpe > 200) return "moderate";
	return "easy";
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = "";
		let tooLarge = false;
		req.on("data", (chunk: Buffer) => {
			if (data.length + chunk.length > 1024) {
				tooLarge = true;
				req.destroy();
				return;
			}
			data += chunk.toString();
		});
		req.on("end", () => {
			if (tooLarge) {
				reject(new Error("body too large"));
				return;
			}
			if (!data) {
				resolve(null);
				return;
			}
			try {
				resolve(JSON.parse(data));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

export async function handleCrossTrainingRpe(
	req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
	activityId: string,
): Promise<void> {
	let body: unknown;
	try {
		body = await readJsonBody(req);
	} catch {
		apiError(res, 400, "invalid JSON body");
		return;
	}

	const payload = body as CrossTrainingRpeRequest | null;
	const rpe = payload?.rpe;
	if (typeof rpe !== "number" || !Number.isFinite(rpe) || rpe < 1 || rpe > 10) {
		apiError(res, 400, "rpe must be an integer 1–10");
		return;
	}

	let activity: { id: string; moving_time: number; start_date_local?: string } | null = null;
	try {
		activity = await user.intervals.get<{
			id: string;
			moving_time: number;
			start_date_local?: string;
		}>(`/activity/${encodeURIComponent(activityId)}`);
	} catch {
		apiError(res, 404, "unknown activity");
		return;
	}

	try {
		await user.intervals.put(`/activity/${encodeURIComponent(activityId)}`, {
			perceived_exertion: rpe,
		});
	} catch (err) {
		console.error("RPE write failed:", err);
		apiError(res, 502, "failed to write RPE to intervals.icu");
		return;
	}

	const sessionRpe = rpe * activity.moving_time;
	const tier = strainTier(sessionRpe);

	// Invalidate the cached suggestion so the next call regenerates.
	cacheInvalidate(user.profile.id);

	const today = new Date().toISOString().slice(0, 10);
	const appliedToToday = activity.start_date_local?.startsWith(today) ?? false;

	const response: CrossTrainingRpeResponse = {
		activity_id: activityId,
		rpe,
		strain_tier: tier,
		applied_to_today: appliedToToday,
	};
	jsonResponse(res, 200, response);
}
