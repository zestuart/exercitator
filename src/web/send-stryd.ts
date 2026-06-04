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
import type { UserProfile } from "../users.js";
import { markStrydRecommendationSelected } from "./mark-stryd-selected.js";
import { generatePrescriptions } from "./prescriptions.js";
import { toStrydWorkout } from "./stryd-format.js";

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
			// external_id is stored as TEXT (generic across targets); the wire contract is numeric for parity with the 200 path.
			jsonResponse(res, 409, {
				success: false,
				duplicate: true,
				workout_id: existing.externalId ? Number(existing.externalId) : null,
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

		// Forward strydClient + tz so the regeneration (a) computes "today" in
		// the athlete timezone — not UTC, which after local 17:00 PDT rolls to
		// tomorrow and targets a WHOOP night that hasn't happened yet, yielding
		// a spurious health_unavailable — and (b) runs the Stryd swap so a cold
		// cache pushes the rendered Stryd recommendation, not raw engine output.
		// formClient stays undefined: Stryd pushes are run-only. See lessons.md
		// 2026-06-03.
		const prescriptions = await generatePrescriptions(client, profile, strydClient, undefined, tz);
		const suggestion = prescriptions.run;

		if (!suggestion) {
			jsonResponse(res, 400, {
				success: false,
				error: `No run prescription available for ${profile.displayName}`,
			});
			return;
		}

		// Refuse to push anything that isn't a real prescription. The web render
		// has dedicated cards for these statuses; the send path must not serialise
		// the placeholder (e.g. the "Health telemetry unavailable" rest card) into
		// a junk Stryd calendar entry. 422 (not 409) — the client auto-retries 409
		// with ?force=true, which would loop on the same unavailable state.
		if (suggestion.status && suggestion.status !== "ready") {
			const message =
				suggestion.healthUnavailableMessage ?? `Workout not sendable (${suggestion.status}).`;
			jsonResponse(res, 422, {
				success: false,
				not_sendable: true,
				status: suggestion.status,
				message,
				// `error` mirrors `message` for the web client, which surfaces
				// `data.error` on the non-duplicate failure path.
				error: message,
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

		// Fire-and-forget: tell Stryd we picked this option. State-only
		// side-effect; safe to ignore failures. No-op when the suggestion
		// isn't Stryd-sourced (engine builds / fallback / Pam).
		void markStrydRecommendationSelected(strydClient, suggestion);

		jsonResponse(res, 200, {
			success: true,
			workout_id: workoutId,
			calendar_id: entry.id,
			stress: entry.stress,
			duration_mins: Math.round(entry.duration / 60),
			distance_m: Math.round(entry.distance),
		});
	} catch (err) {
		// Full error (incl. stack) goes to server logs; client gets a
		// generic message so internal details don't leak over the wire.
		console.error("sendToStryd failed:", err);
		jsonResponse(res, 500, {
			success: false,
			error: "Failed to send workout to Stryd",
		});
	}
}
