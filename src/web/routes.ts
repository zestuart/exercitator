/**
 * HTTP route handler for the Praescriptor web UI.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntervalsClient } from "../intervals.js";
import { generateInvocations } from "./invocations.js";
import { generatePrescriptions } from "./prescriptions.js";
import { renderPage } from "./render.js";
import { sendToIntervals } from "./send.js";

export async function handleRoutes(
	req: IncomingMessage,
	res: ServerResponse,
	client: IntervalsClient,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

	try {
		if (req.method === "GET" && url.pathname === "/") {
			const prescriptions = await generatePrescriptions(client);

			// Generate invocations in parallel (falls back to static on failure)
			const [runInvocations, swimInvocations] = await Promise.all([
				generateInvocations(
					"Run",
					prescriptions.run.category,
					prescriptions.run.readiness_score,
					prescriptions.run.warnings,
				),
				generateInvocations(
					"Swim",
					prescriptions.swim.category,
					prescriptions.swim.readiness_score,
					prescriptions.swim.warnings,
				),
			]);

			const html = renderPage({
				run: prescriptions.run,
				swim: prescriptions.swim,
				runInvocations,
				swimInvocations,
				runHrZones: prescriptions.runHrZones,
				swimHrZones: prescriptions.swimHrZones,
				generatedAt: prescriptions.generated_at,
			});
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html);
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/prescriptions") {
			const prescriptions = await generatePrescriptions(client);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(prescriptions));
			return;
		}

		if (req.method === "POST" && url.pathname.startsWith("/api/send/")) {
			const sport = url.pathname.split("/").pop();
			if (sport !== "run" && sport !== "swim") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid sport — use /api/send/run or /api/send/swim" }));
				return;
			}
			const force = url.searchParams.get("force") === "true";
			await sendToIntervals(client, sport, res, force);
			return;
		}

		if (req.method === "GET" && url.pathname === "/health") {
			res.writeHead(200);
			res.end("ok");
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	} catch (err) {
		console.error("Route error:", err);
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end("Internal server error");
	}
}
