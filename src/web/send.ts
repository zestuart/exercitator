/**
 * Pushes a workout prescription to intervals.icu as a planned calendar event.
 * Server-side dedup prevents duplicate events per user per sport per day.
 */

import type { ServerResponse } from "node:http";
import { getPrescription, getSendEvent, persistSendEvent } from "../compliance/persist.js";
import { localDateStr } from "../engine/date-utils.js";
import type { FormClient } from "../form/client.js";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";
import type { UserProfile } from "../users.js";
import { buildIntervalsDescription } from "./intervals-format.js";
import { markStrydRecommendationSelected } from "./mark-stryd-selected.js";
import { generatePrescriptions } from "./prescriptions.js";

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

export async function sendToIntervals(
	client: IntervalsClient,
	profile: UserProfile,
	sport: "run" | "swim",
	res: ServerResponse,
	force = false,
	tz?: string,
	strydClient?: StrydClient | null,
	formClient?: FormClient | null,
): Promise<void> {
	try {
		const today = localDateStr(new Date(), tz);
		const sportKey = sport === "run" ? "Run" : "Swim";

		const existing = getSendEvent(profile.id, today, sportKey, "intervals");
		if (!force && existing) {
			jsonResponse(res, 409, {
				success: false,
				duplicate: true,
				event_id: existing.externalId,
				message: "Already sent today \u2014 send again?",
			});
			return;
		}

		// Pass both vendor clients through so a fresh generation runs the
		// vendor swap and ships the swapped suggestion. When Praescriptor
		// has already rendered today the daily cache returns the same
		// swapped prescription, but the iOS-first flow (push before
		// loading the web page) must not regress to engine output.
		const prescriptions = await generatePrescriptions(client, profile, strydClient, formClient, tz);
		const suggestion = sport === "run" ? prescriptions.run : prescriptions.swim;

		if (!suggestion) {
			jsonResponse(res, 400, {
				success: false,
				error: `No ${sport} prescription available for ${profile.displayName}`,
			});
			return;
		}

		// Refuse to push anything that isn't a real prescription (awaiting_input /
		// already_trained / health_unavailable). The web render shows dedicated
		// cards for these; the send path must not push the placeholder. 422 (not
		// 409) — the client auto-retries 409 with ?force=true. See lessons.md
		// 2026-06-03.
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

		const event = {
			category: "WORKOUT",
			start_date_local: `${today}T00:00:00`,
			name: suggestion.title,
			description: buildIntervalsDescription(suggestion),
			type: suggestion.sport,
		};

		const result = (await client.post(`/athlete/${client.athleteId}/events`, event)) as {
			id: string;
		};

		// Persist send event to SQLite
		const rx = getPrescription(profile.id, today, sportKey);
		if (rx) {
			persistSendEvent(rx.id, profile.id, today, sportKey, "intervals", result.id);
		}

		// Fire-and-forget: tell Stryd we picked this option, regardless of
		// the chosen execution channel. State-only side-effect; safe to
		// ignore failures. No-op when the suggestion isn't Stryd-sourced.
		void markStrydRecommendationSelected(strydClient, suggestion);

		jsonResponse(res, 200, { success: true, event_id: result.id });
	} catch (err) {
		// Full error (incl. stack) goes to server logs; client gets a
		// generic message so internal details don't leak over the wire.
		console.error("sendToIntervals failed:", err);
		jsonResponse(res, 500, {
			success: false,
			error: "Failed to send workout to intervals.icu",
		});
	}
}
