/**
 * MCP tools for querying workout compliance data.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildComplianceTrend } from "../compliance/aggregate.js";
import {
	getComplianceAssessments,
	getComplianceForDate,
	getPrescription,
} from "../compliance/persist.js";

export function registerComplianceTools(server: McpServer): void {
	server.tool(
		"get_compliance_summary",
		"Get workout compliance summary: completion rate, compliance rate, deviations by category, and weekly trends",
		{
			days: z.number().optional().describe("Number of days to look back (default 30)"),
			sport: z.enum(["Run", "Swim"]).optional().describe("Filter by sport"),
		},
		async ({ days, sport }) => {
			// Use athlete ID "0" as proxy for the MCP user (single-user MCP context)
			const userId = "ze";
			const trend = buildComplianceTrend(userId, days ?? 30, sport);
			return { content: [{ type: "text", text: JSON.stringify(trend, null, 2) }] };
		},
	);

	server.tool(
		"get_compliance_detail",
		"Get detailed per-segment compliance for a specific date, showing pass/fail for each metric",
		{
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.describe("Date in YYYY-MM-DD format"),
			sport: z.enum(["Run", "Swim"]).optional().describe("Filter by sport"),
		},
		async ({ date, sport }) => {
			const userId = "ze";

			if (sport) {
				const assessment = getComplianceForDate(userId, date, sport);
				if (!assessment) {
					return {
						content: [
							{
								type: "text",
								text: `No compliance assessment found for ${date} ${sport}`,
							},
						],
					};
				}
				const rx = getPrescription(userId, date, sport);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ prescription: rx, assessment }, null, 2),
						},
					],
				};
			}

			// Both sports
			const run = getComplianceForDate(userId, date, "Run");
			const swim = getComplianceForDate(userId, date, "Swim");
			const runRx = run ? getPrescription(userId, date, "Run") : null;
			const swimRx = swim ? getPrescription(userId, date, "Swim") : null;

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								run: run ? { prescription: runRx, assessment: run } : null,
								swim: swim ? { prescription: swimRx, assessment: swim } : null,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}
