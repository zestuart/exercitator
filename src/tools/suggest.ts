import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheGet } from "../db.js";
import { suggestWorkout } from "../engine/suggest.js";
import type { IntervalsClient } from "../intervals.js";

/** Resolve the athlete's IANA timezone from the cached profile, or fetch + cache it. */
async function getAthleteTz(client: IntervalsClient): Promise<string> {
	const cacheKey = `athlete:${client.athleteId}:profile`;
	const cached = cacheGet(cacheKey) as { timezone?: string } | null;
	if (cached?.timezone) return cached.timezone;

	try {
		const profile = await client.get<{ timezone?: string }>(`/athlete/${client.athleteId}`);
		return profile.timezone ?? "UTC";
	} catch {
		return "UTC";
	}
}

export function registerSuggestTools(server: McpServer, client: IntervalsClient): void {
	server.tool(
		"suggest_workout",
		"Generate a personalised daily workout suggestion based on recent training load, " +
			"wellness data, and recovery status. Analyses 14 days of activities and 7 days of " +
			"wellness data to recommend a running or swimming workout with structured warm-up, " +
			"main set, and cool-down. Detects power source (Stryd vs Garmin native) and " +
			"expresses all targets in the correct scale. Includes terrain guidance and dual-target " +
			"prescription (power + HR safety cap). Does not create a calendar event — use " +
			"create_event separately to add the workout to your calendar. " +
			"If status is 'awaiting_input', use submit_cross_training_rpe to provide RPE first.",
		{},
		async () => {
			const tz = await getAthleteTz(client);
			const suggestion = await suggestWorkout(client, tz);
			return {
				content: [{ type: "text", text: JSON.stringify(suggestion, null, 2) }],
			};
		},
	);

	server.tool(
		"submit_cross_training_rpe",
		"Submit RPE (1–10) for a cross-training activity that lacks strain data. " +
			"Use this when suggest_workout returns status 'awaiting_input'. " +
			"After submission, call suggest_workout again for an updated prescription.",
		{
			activityId: z.string().describe("The intervals.icu activity ID"),
			rpe: z.number().min(1).max(10).describe("RPE on 1–10 scale"),
		},
		async ({ activityId, rpe }) => {
			// Fetch the activity to get its moving_time for synthetic session_rpe
			const activity = await client.get<{ id: string; moving_time: number }>(
				`/activity/${activityId}`,
			);
			const syntheticSessionRpe = rpe * activity.moving_time;

			// Write RPE back to intervals.icu
			await client.put(`/activity/${activityId}`, {
				perceived_exertion: rpe,
			});

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							activityId,
							rpe,
							syntheticSessionRpe: Math.round(syntheticSessionRpe),
							message: `RPE ${rpe} recorded for activity ${activityId}. Call suggest_workout again for updated prescription.`,
						}),
					},
				],
			};
		},
	);
}
