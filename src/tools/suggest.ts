import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheGet } from "../db.js";
import type { HealthFetchOptions } from "../engine/suggest.js";
import { suggestWorkout } from "../engine/suggest.js";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";

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

export function registerSuggestTools(
	server: McpServer,
	client: IntervalsClient,
	strydClient?: StrydClient | null,
	health?: HealthFetchOptions,
): void {
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
			const suggestion = await suggestWorkout(client, tz, strydClient ?? null, health);
			return {
				content: [{ type: "text", text: JSON.stringify(suggestion, null, 2) }],
			};
		},
	);

	server.tool(
		"submit_cross_training_rpe",
		"Submit RPE (1–10) for a cross-training activity that lacks strain data. " +
			"Accepts any recent cross-training activity ID (not just today's). " +
			"Use when suggest_workout returns status 'awaiting_input', or proactively for a " +
			"prior-day weights / climbing session whose strain the engine couldn't classify. " +
			"After submission, call suggest_workout again for an updated prescription.",
		{
			// Same allowlist as the HTTP API (`isValidIntervalsId`). Belt-and-
			// braces with `encodeURIComponent`: blocks path-traversal characters
			// at the request boundary so a crafted Claude-supplied id can't
			// reach `IntervalsClient.request` via SSRF, even if the URL
			// construction in `src/intervals.ts` ever changes.
			activityId: z
				.string()
				.regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid activity ID format")
				.describe("The intervals.icu activity ID"),
			rpe: z.number().min(1).max(10).describe("RPE on 1–10 scale"),
		},
		async ({ activityId, rpe }) => {
			// Encode the caller-supplied activityId so a crafted value can't
			// traverse the intervals.icu API path.
			const encodedId = encodeURIComponent(activityId);
			// Fetch the activity to get its moving_time for synthetic session_rpe
			const activity = await client.get<{ id: string; moving_time: number }>(
				`/activity/${encodedId}`,
			);
			// Foster's session-RPE: RPE × duration in MINUTES. intervals.icu stores
			// moving_time in seconds, so divide by 60. The strain cascade's absolute
			// thresholds (>200 moderate, >400 hard in `assessStrainFromSessionRpe`)
			// assume the Foster minute-unit convention.
			const syntheticSessionRpe = Math.round((rpe * activity.moving_time) / 60);

			// Write both fields. The cross-training strain cascade reads
			// session_rpe; perceived_exertion provides a separate signal used
			// by isHardSession() for run prescriptions. intervals.icu doesn't
			// auto-derive session_rpe from perceived_exertion, so we set it
			// explicitly.
			await client.put(`/activity/${encodedId}`, {
				perceived_exertion: rpe,
				session_rpe: syntheticSessionRpe,
			});

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							activityId,
							rpe,
							syntheticSessionRpe,
							message: `RPE ${rpe} recorded for activity ${activityId}. Call suggest_workout again for updated prescription.`,
						}),
					},
				],
			};
		},
	);
}
