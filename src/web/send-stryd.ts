/**
 * Pushes a running workout to the athlete's Stryd calendar.
 * Creates the workout in the Stryd library, then schedules it for today.
 * Server-side dedup prevents duplicate pushes per user per day.
 */

import type { ServerResponse } from "node:http";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";
import { generatePrescriptions } from "./prescriptions.js";
import { toStrydWorkout } from "./stryd-format.js";
import type { UserProfile } from "./users.js";

// Dedup: track sends per userId+date → { workoutId, calendarId }
const strydSentToday = new Map<string, { workoutId: number; calendarId: number }>();

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

export async function sendToStryd(
	client: IntervalsClient,
	profile: UserProfile,
	strydClient: StrydClient,
	res: ServerResponse,
	force = false,
): Promise<void> {
	try {
		const today = new Date().toISOString().slice(0, 10);
		const dedupKey = `${profile.id}-${today}`;

		if (!force && strydSentToday.has(dedupKey)) {
			const prev = strydSentToday.get(dedupKey) as { workoutId: number; calendarId: number };
			jsonResponse(res, 409, {
				success: false,
				duplicate: true,
				workout_id: prev.workoutId,
				calendar_id: prev.calendarId,
				message: "Already sent to Stryd today \u2014 send again?",
			});
			return;
		}

		// If forcing and a previous entry exists, delete the old calendar entry first
		if (force && strydSentToday.has(dedupKey)) {
			const prev = strydSentToday.get(dedupKey) as { workoutId: number; calendarId: number };
			try {
				await strydClient.deleteCalendarEntry(prev.calendarId);
			} catch {
				// Best-effort cleanup — continue even if deletion fails
			}
		}

		if (!strydClient.isAuthenticated) await strydClient.login();

		const prescriptions = await generatePrescriptions(client, profile);
		const suggestion = prescriptions.run;

		if (!suggestion) {
			jsonResponse(res, 400, {
				success: false,
				error: `No run prescription available for ${profile.displayName}`,
			});
			return;
		}

		const strydWorkout = toStrydWorkout(suggestion);
		const workoutId = await strydClient.createWorkout(strydWorkout);
		const entry = await strydClient.scheduleWorkout(workoutId, new Date());

		strydSentToday.set(dedupKey, { workoutId, calendarId: entry.id });

		// Clean stale entries
		for (const key of strydSentToday.keys()) {
			if (!key.includes(today)) strydSentToday.delete(key);
		}

		jsonResponse(res, 200, {
			success: true,
			workout_id: workoutId,
			calendar_id: entry.id,
			stress: entry.stress,
			duration_mins: Math.round(entry.duration / 60),
			distance_m: Math.round(entry.distance),
		});
	} catch (err) {
		jsonResponse(res, 500, { success: false, error: String(err) });
	}
}
