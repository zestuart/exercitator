import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { suggestWorkout } from "../engine/suggest.js";
import type { IntervalsClient } from "../intervals.js";

export function registerSuggestTools(server: McpServer, client: IntervalsClient): void {
	server.tool(
		"suggest_workout",
		"Generate a personalised daily workout suggestion based on recent training load, " +
			"wellness data, and recovery status. Analyses 14 days of activities and 7 days of " +
			"wellness data to recommend a running or swimming workout with structured warm-up, " +
			"main set, and cool-down. Detects power source (Stryd vs Garmin native) and " +
			"expresses all targets in the correct scale. Includes terrain guidance and dual-target " +
			"prescription (power + HR safety cap). Does not create a calendar event — use " +
			"create_event separately to add the workout to your calendar.",
		{},
		async () => {
			const suggestion = await suggestWorkout(client);
			return {
				content: [{ type: "text", text: JSON.stringify(suggestion, null, 2) }],
			};
		},
	);
}
