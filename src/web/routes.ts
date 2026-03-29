/**
 * HTTP route handler for the Praescriptor web UI.
 *
 * All user-facing routes are prefixed with /:userId (e.g. /ze/, /pam/).
 * GET / redirects to the default user's page.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";
import { generateInvocations, plainInvocations } from "./invocations.js";
import { generatePrescriptions, invalidateCache } from "./prescriptions.js";
import { renderPage } from "./render.js";
import { sendToIntervals } from "./send.js";
import { DEFAULT_USER, type UserProfile, getUserProfile } from "./users.js";

// Per-user rate limiter for cache invalidation (30s cooldown)
const refreshLastCall = new Map<string, number>();
const REFRESH_COOLDOWN_MS = 30_000;

export async function handleRoutes(
	req: IncomingMessage,
	res: ServerResponse,
	clients: Map<string, IntervalsClient>,
	strydClients: Map<string, StrydClient>,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

	try {
		// Health check — no user context needed
		if (req.method === "GET" && url.pathname === "/health") {
			res.writeHead(200);
			res.end("ok");
			return;
		}

		// Root redirect → default user
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
			res.writeHead(302, { Location: `/${DEFAULT_USER}/` });
			res.end();
			return;
		}

		// Extract user slug from first path segment
		const segments = url.pathname.split("/").filter(Boolean);
		const userId = segments[0];
		const subPath = `/${segments.slice(1).join("/")}`;

		const profile = userId ? getUserProfile(userId) : undefined;
		if (!profile) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Unknown user");
			return;
		}

		const client = clients.get(profile.id);
		if (!client) {
			res.writeHead(503, { "Content-Type": "text/plain" });
			res.end(`${profile.displayName}'s intervals.icu API key is not configured`);
			return;
		}

		// User-scoped Stryd client: only if user has stryd: true and credentials configured
		const userStryd = profile.stryd ? (strydClients.get(profile.id) ?? null) : null;

		if (req.method === "GET" && (subPath === "/" || subPath === "")) {
			await handleMainPage(profile, client, userStryd, res);
			return;
		}

		if (req.method === "GET" && subPath === "/api/prescriptions") {
			const prescriptions = await generatePrescriptions(client, profile, userStryd);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(prescriptions));
			return;
		}

		if (req.method === "POST" && subPath === "/api/refresh") {
			const now = Date.now();
			const last = refreshLastCall.get(profile.id) ?? 0;
			if (now - last < REFRESH_COOLDOWN_MS) {
				res.writeHead(429, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Too many requests. Please wait." }));
				return;
			}
			refreshLastCall.set(profile.id, now);
			invalidateCache(profile.id);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ success: true }));
			return;
		}

		if (req.method === "POST" && subPath.startsWith("/api/send/")) {
			const sport = subPath.split("/").pop();
			if (sport !== "run" && sport !== "swim") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid sport — use /api/send/run or /api/send/swim" }));
				return;
			}
			// Validate that this user actually has this sport
			const sportUpper = sport === "run" ? "Run" : "Swim";
			if (!profile.sports.includes(sportUpper)) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ error: `${profile.displayName} does not have ${sport} prescriptions` }),
				);
				return;
			}
			const force = url.searchParams.get("force") === "true";
			await sendToIntervals(client, profile, sport, res, force);
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

async function handleMainPage(
	profile: UserProfile,
	client: IntervalsClient,
	strydClient: StrydClient | null | undefined,
	res: ServerResponse,
): Promise<void> {
	const prescriptions = await generatePrescriptions(client, profile, strydClient);

	// Generate invocations for each sport this user has
	const runInvocations = prescriptions.run
		? profile.deities
			? await generateInvocations(
					"Run",
					prescriptions.run.category,
					prescriptions.run.readiness_score,
					prescriptions.run.warnings,
				)
			: plainInvocations("Run")
		: null;

	const swimInvocations = prescriptions.swim
		? profile.deities
			? await generateInvocations(
					"Swim",
					prescriptions.swim.category,
					prescriptions.swim.readiness_score,
					prescriptions.swim.warnings,
				)
			: plainInvocations("Swim")
		: null;

	const html = renderPage({
		profile,
		run: prescriptions.run ?? null,
		swim: prescriptions.swim ?? null,
		runInvocations,
		swimInvocations,
		runHrZones: prescriptions.runHrZones,
		swimHrZones: prescriptions.swimHrZones,
		dataSource: prescriptions.dataSource,
		generatedAt: prescriptions.generated_at,
	});
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(html);
}
