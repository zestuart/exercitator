import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheGet, cacheSet } from "../db.js";
import type { IntervalsClient } from "../intervals.js";

const ATHLETE_CACHE_TTL = 3600; // 1 hour

export function registerAthleteTools(server: McpServer, client: IntervalsClient): void {
	server.tool(
		"get_athlete_profile",
		"Get the athlete's profile including name, sport settings, and training zones",
		{},
		async () => {
			const cacheKey = `athlete:${client.athleteId}:profile`;
			let profile = cacheGet(cacheKey);
			if (!profile) {
				profile = await client.get(`/athlete/${client.athleteId}`);
				cacheSet(cacheKey, profile, ATHLETE_CACHE_TTL);
			}
			return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
		},
	);

	server.tool(
		"get_sport_settings",
		"Get sport-specific settings (zones, FTP, LTHR, threshold pace) for a given sport type",
		{
			sport: z.string().describe('Sport type, e.g. "Ride", "Run", "Swim", "WeightTraining"'),
		},
		async ({ sport }) => {
			const settings = await client.get(
				`/athlete/${client.athleteId}/sport-settings/${encodeURIComponent(sport)}`,
			);
			return { content: [{ type: "text", text: JSON.stringify(settings, null, 2) }] };
		},
	);
}
