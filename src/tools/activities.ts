import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheGet } from "../db.js";
import { localDateStr } from "../engine/date-utils.js";
import type { IntervalsClient } from "../intervals.js";

/** Resolve athlete IANA timezone from cached profile or API. */
async function getAthleteTz(client: IntervalsClient): Promise<string> {
	const key = `athlete:${client.athleteId}:profile`;
	const cached = cacheGet(key) as { timezone?: string } | null;
	if (cached?.timezone) return cached.timezone;

	try {
		const profile = await client.get<{ timezone?: string }>(`/athlete/${client.athleteId}`);
		return profile.timezone ?? "UTC";
	} catch {
		return "UTC";
	}
}

export function registerActivityTools(server: McpServer, client: IntervalsClient): void {
	server.tool(
		"list_activities",
		"List recent activities with optional date range and sport filter",
		{
			oldest: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
			newest: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today."),
			sport: z.string().optional().describe('Filter by sport type, e.g. "Ride", "Run"'),
		},
		async ({ oldest, newest, sport }) => {
			const tz = await getAthleteTz(client);
			const now = new Date();
			const defaultOldest = localDateStr(new Date(now.getTime() - 30 * 86_400_000), tz);

			const query: Record<string, string> = {
				oldest: oldest ?? defaultOldest,
				newest: newest ?? localDateStr(now, tz),
			};

			const activities = await client.get<unknown[]>(
				`/athlete/${client.athleteId}/activities`,
				query,
			);

			const filtered = sport
				? activities.filter((a) => (a as Record<string, unknown>).type === sport)
				: activities;

			return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
		},
	);

	server.tool(
		"get_activity",
		"Get full details of a specific activity by ID",
		{
			activityId: z.string().describe("The activity ID"),
		},
		async ({ activityId }) => {
			const activity = await client.get(`/activity/${encodeURIComponent(activityId)}`);
			return { content: [{ type: "text", text: JSON.stringify(activity, null, 2) }] };
		},
	);

	server.tool(
		"get_activity_streams",
		"Get raw data streams (power, HR, cadence, etc.) for an activity",
		{
			activityId: z.string().describe("The activity ID"),
			types: z
				.string()
				.optional()
				.describe(
					'Comma-separated stream types, e.g. "watts,heartrate,cadence,distance,altitude". Omit for all.',
				),
		},
		async ({ activityId, types }) => {
			const query: Record<string, string> = {};
			if (types) query.types = types;

			const streams = await client.get(
				`/activity/${encodeURIComponent(activityId)}/streams`,
				query,
			);
			return { content: [{ type: "text", text: JSON.stringify(streams, null, 2) }] };
		},
	);

	server.tool(
		"get_power_curve",
		"Get the power duration curve for an activity",
		{
			activityId: z.string().describe("The activity ID"),
		},
		async ({ activityId }) => {
			const curve = await client.get(`/activity/${encodeURIComponent(activityId)}/power-curve`);
			return { content: [{ type: "text", text: JSON.stringify(curve, null, 2) }] };
		},
	);
}
