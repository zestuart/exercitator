/**
 * Pushes a running workout to the athlete's Stryd calendar.
 * Creates the workout in the Stryd library, then schedules it for today.
 * Server-side dedup prevents duplicate pushes per user per day.
 */

import type { ServerResponse } from "node:http";
import { getPrescription, getSendEvent, persistSendEvent } from "../compliance/persist.js";
import { localDateStr } from "../engine/date-utils.js";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";
import { generatePrescriptions } from "./prescriptions.js";
import { toStrydWorkout } from "./stryd-format.js";
import type { UserProfile } from "./users.js";

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
	tz?: string,
): Promise<void> {
	try {
		const today = localDateStr(new Date(), tz);

		const existing = getSendEvent(profile.id, today, "Run", "stryd");
		if (!force && existing) {
			const meta = existing.externalMeta ? JSON.parse(existing.externalMeta) : {};
			jsonResponse(res, 409, {
				success: false,
				duplicate: true,
				workout_id: existing.externalId,
				calendar_id: meta.calendarId,
				message: "Already sent to Stryd today \u2014 send again?",
			});
			return;
		}

		// If forcing and a previous entry exists, delete the old calendar entry first
		if (force && existing?.externalMeta) {
			const meta = JSON.parse(existing.externalMeta);
			if (meta.calendarId) {
				try {
					await strydClient.deleteCalendarEntry(meta.calendarId);
				} catch {
					// Best-effort cleanup — continue even if deletion fails
				}
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

		const strydWorkout = toStrydWorkout(suggestion, tz);
		const workoutId = await strydClient.createWorkout(strydWorkout);
		const entry = await strydClient.scheduleWorkout(workoutId, new Date());

		// Persist send event to SQLite
		const rx = getPrescription(profile.id, today, "Run");
		if (rx) {
			persistSendEvent(rx.id, profile.id, today, "Run", "stryd", String(workoutId), {
				calendarId: entry.id,
				stress: entry.stress,
				duration: entry.duration,
				distance: entry.distance,
			});
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
