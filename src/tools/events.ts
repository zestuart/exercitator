import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IntervalsClient } from "../intervals.js";

export function registerEventTools(server: McpServer, client: IntervalsClient): void {
	server.tool(
		"list_events",
		"List calendar events (planned workouts, notes, races) for a date range",
		{
			oldest: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
				.describe("Start date (YYYY-MM-DD)"),
			newest: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
				.describe("End date (YYYY-MM-DD)"),
		},
		async ({ oldest, newest }) => {
			const events = await client.get(`/athlete/${client.athleteId}/events`, {
				oldest,
				newest,
			});
			return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
		},
	);

	server.tool(
		"create_event",
		"Create a calendar event (planned workout, note, or race)",
		{
			category: z.enum(["WORKOUT", "NOTE", "RACE", "REST_DAY"]).describe("Event category"),
			startDate: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
				.describe("Event date (YYYY-MM-DD)"),
			name: z.string().describe("Event name/title"),
			description: z.string().optional().describe("Event description or workout details"),
			sportType: z.string().optional().describe('Sport type for workouts, e.g. "Ride", "Run"'),
		},
		async ({ category, startDate, name, description, sportType }) => {
			// intervals.icu requires a datetime, not just a date
			const startDateTime = startDate.length === 10 ? `${startDate}T00:00:00` : startDate;
			const body: Record<string, unknown> = {
				category,
				start_date_local: startDateTime,
				name,
			};
			if (description) body.description = description;
			if (sportType) body.type = sportType;

			const result = await client.post(`/athlete/${client.athleteId}/events`, body);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		},
	);
}
