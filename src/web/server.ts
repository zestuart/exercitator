/**
 * Praescriptor — web UI entrypoint.
 *
 * Serves daily workout prescriptions (Run + Swim) with a ritualistic visual
 * style. Tailnet-only via Tailscale serve (not funnel).
 */

import { createServer } from "node:http";
import { IntervalsClient } from "../intervals.js";
import { StrydClient } from "../stryd/client.js";
import { handleRoutes } from "./routes.js";

const PORT = Number.parseInt(process.env.PRAESCRIPTOR_PORT ?? "3847", 10);
const API_KEY = process.env.INTERVALS_ICU_API_KEY;

if (!API_KEY) {
	console.error("INTERVALS_ICU_API_KEY is required");
	process.exit(1);
}

const client = new IntervalsClient({ apiKey: API_KEY });

const STRYD_EMAIL = process.env.STRYD_EMAIL;
const STRYD_PASSWORD = process.env.STRYD_PASSWORD;
const strydClient =
	STRYD_EMAIL && STRYD_PASSWORD
		? new StrydClient({ email: STRYD_EMAIL, password: STRYD_PASSWORD })
		: null;

if (!strydClient) {
	console.error("STRYD_EMAIL/STRYD_PASSWORD not set — Stryd FIT enrichment disabled");
}

const server = createServer((req, res) => {
	handleRoutes(req, res, client, strydClient).catch((err) => {
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
