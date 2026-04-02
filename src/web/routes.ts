/**
 * HTTP route handler for the Praescriptor web UI.
 *
 * All user-facing routes are prefixed with /:userId (e.g. /ze/, /pam/).
 * GET / redirects to the default user's page.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { localDateStr } from "../engine/date-utils.js";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";
import { generateInvocations, plainInvocations } from "./invocations.js";
import { generatePrescriptions, invalidateCache } from "./prescriptions.js";
import { renderPage } from "./render.js";
import { sendToStryd } from "./send-stryd.js";
import { sendToIntervals } from "./send.js";
import { DEFAULT_USER, type UserProfile, getUserProfile } from "./users.js";

/** Cache of athlete profile timezone per user (1h TTL via athlete profile cache). */
const athleteTzCache = new Map<string, { tz: string; fetchedAt: number }>();
const TZ_CACHE_TTL = 3_600_000; // 1 hour

/**
 * Resolve the user's IANA timezone from available sources.
 * Fallback chain: browser cookie → intervals.icu athlete profile → UTC.
 */
async function resolveTimezone(req: IncomingMessage, client: IntervalsClient): Promise<string> {
	// 1. Browser-detected TZ via cookie
	const cookies = req.headers.cookie ?? "";
	const tzMatch = cookies.match(/(?:^|;\s*)tz=([^;]+)/);
	if (tzMatch) {
		const tz = decodeURIComponent(tzMatch[1]);
		// Basic validation: IANA timezone names contain a slash
		if (tz.includes("/")) return tz;
	}

	// 2. intervals.icu athlete profile timezone (cached)
	const cached = athleteTzCache.get(client.athleteId);
	if (cached && Date.now() - cached.fetchedAt < TZ_CACHE_TTL) {
		return cached.tz;
	}

	try {
		const profile = await client.get<{ timezone?: string }>(`/athlete/${client.athleteId}`);
		const tz = profile.timezone ?? "UTC";
		athleteTzCache.set(client.athleteId, { tz, fetchedAt: Date.now() });
		return tz;
	} catch {
		return "UTC";
	}
}

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

		const tz = await resolveTimezone(req, client);

		if (req.method === "GET" && (subPath === "/" || subPath === "")) {
			await handleMainPage(profile, client, userStryd, tz, res);
			return;
		}

		if (req.method === "GET" && subPath === "/api/prescriptions") {
			const prescriptions = await generatePrescriptions(client, profile, userStryd, tz);
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
			await sendToIntervals(client, profile, sport, res, force, tz);
			return;
		}

		if (req.method === "POST" && subPath.startsWith("/api/stryd/")) {
			const sport = subPath.split("/").pop();
			if (sport !== "run") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Stryd push only supports running workouts" }));
				return;
			}
			if (!profile.stryd || !userStryd) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Stryd not configured for this user" }));
				return;
			}
			const force = url.searchParams.get("force") === "true";
			await sendToStryd(client, profile, userStryd, res, force, tz);
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
	tz: string,
	res: ServerResponse,
): Promise<void> {
	const prescriptions = await generatePrescriptions(client, profile, strydClient, tz);
	const today = localDateStr(new Date(), tz);

	// Generate invocations for each sport this user has
	const runInvocations = prescriptions.run
		? profile.deities
			? await generateInvocations(
					"Run",
					prescriptions.run.category,
					prescriptions.run.readiness_score,
					prescriptions.run.warnings,
					today,
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
					today,
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
		tz,
	});
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(html);
}
