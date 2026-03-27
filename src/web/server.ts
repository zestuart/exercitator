/**
 * Praescriptor — web UI entrypoint.
 *
 * Serves daily workout prescriptions (Run + Swim) with a ritualistic visual
 * style. Tailnet-only via Tailscale serve (not funnel).
 */

import { createServer } from "node:http";
import { IntervalsClient } from "../intervals.js";
import { handleRoutes } from "./routes.js";

const PORT = Number.parseInt(process.env.PRAESCRIPTOR_PORT ?? "3847", 10);
const API_KEY = process.env.INTERVALS_ICU_API_KEY;

if (!API_KEY) {
	console.error("INTERVALS_ICU_API_KEY is required");
	process.exit(1);
}

const client = new IntervalsClient({ apiKey: API_KEY });

const server = createServer((req, res) => {
	handleRoutes(req, res, client).catch((err) => {
		console.error("Unhandled route error:", err);
		if (!res.headersSent) {
			res.writeHead(500);
			res.end("Internal server error");
		}
	});
});

server.listen(PORT, "0.0.0.0", () => {
	console.error(`Praescriptor web UI listening on port ${PORT}`);
});
