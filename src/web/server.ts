/**
 * Praescriptor — web UI entrypoint.
 *
 * Serves daily workout prescriptions per user (URL-based routing).
 * Tailnet-only via Tailscale serve (not funnel).
 */

import { createServer } from "node:http";
import { IntervalsClient } from "../intervals.js";
import { StrydClient } from "../stryd/client.js";
import { handleRoutes } from "./routes.js";
import { getUserIds, getUserProfile } from "./users.js";

const PORT = Number.parseInt(process.env.PRAESCRIPTOR_PORT ?? "3847", 10);

// Build per-user IntervalsClient map.
// Users whose API key env var is unset get no client — their routes return 503.
const clients = new Map<string, IntervalsClient>();

let hasAnyClient = false;
for (const id of getUserIds()) {
	const profile = getUserProfile(id);
	if (!profile) continue;
	const apiKey = process.env[profile.apiKeyEnv];
	if (apiKey) {
		clients.set(profile.id, new IntervalsClient({ apiKey }));
		console.error(`${profile.displayName}: intervals.icu client ready`);
		hasAnyClient = true;
	} else {
		console.error(`${profile.displayName}: ${profile.apiKeyEnv} not set — routes will return 503`);
	}
}

if (!hasAnyClient) {
	console.error("No intervals.icu API keys configured — exiting");
	process.exit(1);
}

// Build per-user StrydClient map.
// Users whose Stryd env vars are unset get no client — enrichment/Vigil silently skipped.
const strydClients = new Map<string, StrydClient>();
for (const id of getUserIds()) {
	const profile = getUserProfile(id);
	if (!profile?.stryd || !profile.strydEmailEnv || !profile.strydPasswordEnv) continue;
	const email = process.env[profile.strydEmailEnv];
	const password = process.env[profile.strydPasswordEnv];
	if (email && password) {
		strydClients.set(profile.id, new StrydClient({ email, password }));
		console.error(`${profile.displayName}: Stryd client ready`);
	} else {
		console.error(`${profile.displayName}: Stryd credentials not set — enrichment disabled`);
	}
}

const server = createServer((req, res) => {
	handleRoutes(req, res, clients, strydClients).catch((err) => {
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
