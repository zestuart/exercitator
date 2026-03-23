import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IntervalsClient } from "../intervals.js";

export function registerWellnessTools(server: McpServer, client: IntervalsClient): void {
	server.tool(
		"get_wellness",
		"Get wellness data (weight, resting HR, HRV, sleep, mood, etc.) for a date range",
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
			const data = await client.get(`/athlete/${client.athleteId}/wellness`, {
				oldest,
				newest,
			});
			return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
		},
	);

	server.tool(
		"update_wellness",
		"Update wellness data for a specific date. Only supplied fields are updated. Set numeric fields to -1 to clear them.",
		{
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
				.describe("Date to update (YYYY-MM-DD)"),
			weight: z.number().optional().describe("Body weight in kg"),
			restingHR: z.number().optional().describe("Resting heart rate in bpm"),
			hrv: z.number().optional().describe("Heart rate variability (ms)"),
			sleepSecs: z.number().optional().describe("Sleep duration in seconds"),
			sleepQuality: z.number().optional().describe("Sleep quality (1-5)"),
			mood: z.number().optional().describe("Mood (1-5)"),
			readiness: z.number().optional().describe("Readiness (1-10)"),
			soreness: z.number().optional().describe("Soreness (1-10, higher = more sore)"),
			fatigue: z.number().optional().describe("Fatigue (1-10, higher = more fatigued)"),
			stress: z.number().optional().describe("Stress (1-10, higher = more stressed)"),
		},
		async ({ date, ...fields }) => {
			const body: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(fields)) {
				if (v !== undefined) body[k] = v;
			}

			const result = await client.put(
				`/athlete/${client.athleteId}/wellness/${encodeURIComponent(date)}`,
				body,
			);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		},
	);
}
