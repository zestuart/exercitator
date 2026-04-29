/**
 * HTTP route handler for the Praescriptor web UI.
 *
 * All user-facing routes are prefixed with /:userId (e.g. /ze/, /pam/).
 * GET / redirects to the default user's page.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { recomputeAggregates } from "../compliance/aggregate.js";
import { type ActivityLap, assessCompliance } from "../compliance/assess.js";
import {
	getComplianceAssessments,
	getComplianceForDate,
	getPrescription,
	getSendEvents,
	saveComplianceAssessment,
} from "../compliance/persist.js";
import type { ComplianceView } from "../compliance/types.js";
import { isValidTimezone, localDateStr } from "../engine/date-utils.js";
import type { IntervalsClient } from "../intervals.js";
import { checkRate } from "../rate-limit.js";
import type { StrydClient } from "../stryd/client.js";
import { DEFAULT_USER, type UserProfile, getUserProfile } from "../users.js";
import { generateInvocations, plainInvocations } from "./invocations.js";
import { generatePrescriptions, invalidateCache } from "./prescriptions.js";
import { renderPage } from "./render.js";
import { applyBaseSecurityHeaders, applyHtmlSecurityHeaders } from "./security-headers.js";
import { sendToStryd } from "./send-stryd.js";
import { sendToIntervals } from "./send.js";

/** Cache of athlete profile timezone per user (1h TTL via athlete profile cache). */
const athleteTzCache = new Map<string, { tz: string; fetchedAt: number }>();
const TZ_CACHE_TTL = 3_600_000; // 1 hour

/**
 * Resolve the user's IANA timezone from available sources.
 * Fallback chain: browser cookie → intervals.icu athlete profile → UTC.
 */
async function resolveTimezone(req: IncomingMessage, client: IntervalsClient): Promise<string> {
	// 1. Browser-detected TZ via cookie — strict IANA validation. A crafted
	//    cookie like `tz=a/b` would otherwise reach `localDateStr` and throw
	//    a RangeError, surfacing as a 500.
	const cookies = req.headers.cookie ?? "";
	const tzMatch = cookies.match(/(?:^|;\s*)tz=([^;]+)/);
	if (tzMatch) {
		try {
			const tz = decodeURIComponent(tzMatch[1]);
			if (isValidTimezone(tz)) return tz;
		} catch {
			// malformed URI escape — fall through
		}
	}

	// 2. intervals.icu athlete profile timezone (cached)
	const cached = athleteTzCache.get(client.athleteId);
	if (cached && Date.now() - cached.fetchedAt < TZ_CACHE_TTL) {
		return cached.tz;
	}

	try {
		const profile = await client.get<{ timezone?: string }>(`/athlete/${client.athleteId}`);
		const profileTz = profile.timezone;
		const tz = isValidTimezone(profileTz) ? profileTz : "UTC";
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

	// Defence-in-depth headers — applied to every response.
	applyBaseSecurityHeaders(res);

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

		// Rate limit per-userId — reads vs. writes share independent buckets.
		// The HTML page render is a read; calendar pushes / refresh / compliance
		// confirm-skip-backfill are writes.
		const scope: "read" | "write" =
			req.method === "GET" || req.method === "HEAD" ? "read" : "write";
		const limit = checkRate(scope, profile.id);
		if (!limit.allowed) {
			res.setHeader("Retry-After", String(limit.retryAfterS));
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: "rate limit exceeded",
					details: {
						scope,
						retry_after_s: limit.retryAfterS,
						limit: limit.limit,
					},
				}),
			);
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

		// ---------------------------------------------------------------
		// Compliance API
		// ---------------------------------------------------------------

		if (req.method === "GET" && subPath.match(/^\/api\/compliance\/(\d{4}-\d{2}-\d{2})$/)) {
			const date = subPath.split("/").pop() ?? "";
			const runCompliance = getComplianceForDate(profile.id, date, "Run");
			const swimCompliance = getComplianceForDate(profile.id, date, "Swim");
			jsonRes(res, 200, { run: runCompliance, swim: swimCompliance });
			return;
		}

		if (req.method === "GET" && subPath === "/api/compliance/trending") {
			const { buildComplianceTrend } = await import("../compliance/aggregate.js");
			const requested = Number(url.searchParams.get("days") ?? "30");
			const days =
				Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 730) : 30;
			const sport = url.searchParams.get("sport") ?? undefined;
			const trend = buildComplianceTrend(profile.id, days, sport);
			jsonRes(res, 200, trend);
			return;
		}

		if (req.method === "POST" && subPath === "/api/compliance/confirm") {
			const body = await readJsonBody(req);
			if (!body?.date || !body?.sport || !body?.activityId) {
				jsonRes(res, 400, { error: "Required: date, sport, activityId" });
				return;
			}
			const result = await runComplianceAssessment(
				client,
				profile.id,
				String(body.date),
				String(body.sport),
				String(body.activityId),
			);
			jsonRes(res, result.error ? 400 : 200, result);
			return;
		}

		if (req.method === "POST" && subPath === "/api/compliance/skip") {
			const body = await readJsonBody(req);
			if (!body?.date || !body?.sport) {
				jsonRes(res, 400, { error: "Required: date, sport" });
				return;
			}
			const date = String(body.date);
			const sport = String(body.sport);
			const reason = body.reason ? String(body.reason) : null;
			const rx = getPrescription(profile.id, date, sport);
			if (!rx) {
				jsonRes(res, 404, { error: "No prescription found for that date/sport" });
				return;
			}
			saveComplianceAssessment(
				rx.id,
				profile.id,
				date,
				sport,
				null,
				"skipped",
				reason,
				false,
				rx.segments.length,
				0,
				[],
			);
			// Recompute aggregates for the affected week
			recomputeAggregates(profile.id, date, date);
			jsonRes(res, 200, { success: true, status: "skipped" });
			return;
		}

		if (req.method === "POST" && subPath === "/api/compliance/backfill") {
			// Clamp the lookback window — `runComplianceBackfill` issues one
			// upstream call per day with a send event, so an unclamped `days`
			// value lets a tailnet caller burn intervals.icu quota and CPU
			// for as long as they please. 730 d ≈ 2 y, comfortably more than
			// the longest reasonable backfill.
			const requested = Number(url.searchParams.get("days") ?? "90");
			const days =
				Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 730) : 90;
			const result = await runComplianceBackfill(client, profile.id, days, tz);
			jsonRes(res, 200, result);
			return;
		}

		if (req.method === "GET" && subPath === "/api/compliance/activities") {
			// List candidate activities for a given date+sport (for manual matching)
			const date = url.searchParams.get("date");
			const sport = url.searchParams.get("sport");
			if (!date || !sport) {
				jsonRes(res, 400, { error: "Required query params: date, sport" });
				return;
			}
			const activities = await client.get<Record<string, unknown>[]>(
				`/athlete/${client.athleteId}/activities`,
				{ oldest: date, newest: date },
			);
			const filtered = activities.filter((a) => a.type === sport);
			const summary = filtered.map((a) => ({
				id: a.id,
				name: a.name,
				type: a.type,
				moving_time: a.moving_time,
				distance: a.distance,
				start_date_local: a.start_date_local,
			}));
			jsonRes(res, 200, summary);
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

function jsonRes(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 65_536) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => resolve(null));
	});
}

async function runComplianceAssessment(
	client: IntervalsClient,
	userId: string,
	date: string,
	sport: string,
	activityId: string,
): Promise<Record<string, unknown>> {
	// Allowlist the activity ID shape before interpolation. encodeURIComponent
	// already prevents protocol-relative SSRF (`%2F%2F` survives URL parsing),
	// but a strict regex also gives 400 for clearly-malformed input rather
	// than a 502 from the upstream and aligns with the `Date param` allowlist
	// pattern documented in CLAUDE.md.
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(activityId)) {
		return { error: "Invalid activityId format" };
	}

	const rx = getPrescription(userId, date, sport);
	if (!rx) return { error: "No prescription found for that date/sport" };

	const activity = await client.get<Record<string, unknown>>(
		`/activity/${encodeURIComponent(activityId)}`,
	);
	const laps = (activity.laps ?? []) as ActivityLap[];

	if (laps.length === 0) {
		return { error: "Activity has no lap data for compliance assessment" };
	}

	const result = assessCompliance(rx.segments, laps, rx.hrZones);

	saveComplianceAssessment(
		rx.id,
		userId,
		date,
		sport,
		activityId,
		"completed",
		null,
		result.overallPass,
		result.segmentsTotal,
		result.segmentsPassed,
		result.segments,
	);

	// Recompute aggregates
	recomputeAggregates(userId, date, date);

	return {
		success: true,
		overallPass: result.overallPass,
		segmentsTotal: result.segmentsTotal,
		segmentsPassed: result.segmentsPassed,
		segments: result.segments,
	};
}

async function runComplianceBackfill(
	client: IntervalsClient,
	userId: string,
	days: number,
	tz: string,
): Promise<Record<string, unknown>> {
	const now = new Date();
	const oldest = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
	const newest = localDateStr(now, tz);

	const sendEvents = getSendEvents(userId, oldest, newest);
	let processed = 0;
	let assessed = 0;
	const errors: string[] = [];

	for (const event of sendEvents) {
		if (event.target !== "intervals" || !event.externalId) continue;

		// Skip if already assessed
		const existing = getComplianceForDate(userId, event.date, event.sport);
		if (existing && existing.status !== "pending") continue;

		processed++;
		try {
			// Find the activity for this date+sport
			const activities = await client.get<Record<string, unknown>[]>(
				`/athlete/${client.athleteId}/activities`,
				{ oldest: event.date, newest: event.date },
			);
			const match = activities.find((a) => a.type === event.sport);
			if (!match) continue;

			const activity = await client.get<Record<string, unknown>>(`/activity/${match.id}`);
			const laps = (activity.laps ?? []) as ActivityLap[];
			if (laps.length === 0) continue;

			const rx = getPrescription(userId, event.date, event.sport);
			if (!rx) continue;

			const result = assessCompliance(rx.segments, laps, rx.hrZones);
			saveComplianceAssessment(
				rx.id,
				userId,
				event.date,
				event.sport,
				match.id as string,
				"completed",
				null,
				result.overallPass,
				result.segmentsTotal,
				result.segmentsPassed,
				result.segments,
			);
			assessed++;
		} catch (err) {
			errors.push(`${event.date}/${event.sport}: ${String(err)}`);
		}
	}

	// Recompute aggregates for the full range
	if (assessed > 0) recomputeAggregates(userId, oldest, newest);

	return { processed, assessed, errors };
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

	// Load compliance data for yesterday's prescriptions (for confirmation UI)
	const yesterday = localDateStr(new Date(Date.now() - 86_400_000), tz);
	const runCompliance = buildComplianceView(profile.id, yesterday, "Run");
	const swimCompliance = buildComplianceView(profile.id, yesterday, "Swim");

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
		runCompliance,
		swimCompliance,
	});
	applyHtmlSecurityHeaders(res);
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(html);
}

function buildComplianceView(userId: string, date: string, sport: string): ComplianceView {
	const assessment = getComplianceForDate(userId, date, sport);
	const rx = getPrescription(userId, date, sport);
	// A prescription was sent but not yet assessed
	const hasSend = rx !== null;
	const pendingSent = hasSend && assessment === null;

	return {
		assessment,
		pendingSent,
		prescriptionDate: rx ? date : null,
	};
}
