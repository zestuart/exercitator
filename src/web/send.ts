/**
 * Pushes a workout prescription to intervals.icu as a planned calendar event.
 * Server-side dedup prevents duplicate events per user per sport per day.
 */

import type { ServerResponse } from "node:http";
import { getPrescription, getSendEvent, persistSendEvent } from "../compliance/persist.js";
import { localDateStr } from "../engine/date-utils.js";
import type { IntervalsClient } from "../intervals.js";
import type { UserProfile } from "../users.js";
import { buildIntervalsDescription } from "./intervals-format.js";
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

		const prescriptions = await generatePrescriptions(client, profile);
		const suggestion = sport === "run" ? prescriptions.run : prescriptions.swim;

		if (!suggestion) {
			jsonResponse(res, 400, {
				success: false,
				error: `No ${sport} prescription available for ${profile.displayName}`,
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

		jsonResponse(res, 200, { success: true, event_id: result.id });
	} catch (err) {
		jsonResponse(res, 500, { success: false, error: String(err) });
	}
}
