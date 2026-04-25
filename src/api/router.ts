/**
 * HTTP API router — dispatches /api/* to the right handler.
 *
 * All per-user endpoints live under /api/users/:userId/...
 * See phase2/exercitator-http-api-spec.md §5.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntervalsClient } from "../intervals.js";
import type { StrydClient } from "../stryd/client.js";
import { getUserProfile } from "../users.js";
import type { UserProfile } from "../users.js";
import type { AuthContext } from "./auth.js";
import { requireBearer } from "./auth.js";
import { apiError } from "./errors.js";
import { handleHealth } from "./handlers/health.js";

export interface ApiContext {
	auth: AuthContext;
	intervalsClients: Map<string, IntervalsClient>;
	strydClients: Map<string, StrydClient>;
	usersConfigured: string[];
	startedAt: number;
	version: string;
}

export interface UserContext {
	profile: UserProfile;
	intervals: IntervalsClient;
	stryd: StrydClient | null;
}

function resolveUser(ctx: ApiContext, userId: string, res: ServerResponse): UserContext | null {
	const profile = getUserProfile(userId);
	if (!profile) {
		apiError(res, 404, "unknown user");
		return null;
	}
	const intervals = ctx.intervalsClients.get(profile.id);
	if (!intervals) {
		apiError(res, 503, "intervals.icu API key not configured for user");
		return null;
	}
	const stryd = profile.stryd ? (ctx.strydClients.get(profile.id) ?? null) : null;
	return { profile, intervals, stryd };
}

export async function handleApiRequest(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: ApiContext,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

	// /api/health — unauthenticated
	if (req.method === "GET" && url.pathname === "/api/health") {
		await handleHealth(res, ctx);
		return;
	}

	// /api/users/:userId/...
	const match = url.pathname.match(/^\/api\/users\/([^/]+)(\/.*)?$/);
	if (!match) {
		apiError(res, 404, "not found");
		return;
	}

	const userId = match[1];
	const subPath = match[2] ?? "/";

	// Auth must succeed before we disclose user existence.
	const key = requireBearer(req, res, ctx.auth, userId);
	if (!key) return;

	const user = resolveUser(ctx, userId, res);
	if (!user) return;

	// Endpoints — Phase 2 stub for everything except /status baseline.
	// Phase 3 fills these in.
	if (req.method === "GET" && subPath === "/status") {
		const { handleStatus } = await import("./handlers/status.js");
		await handleStatus(req, res, user);
		return;
	}

	if (req.method === "GET" && subPath === "/workouts/today") {
		const { handleWorkoutsToday } = await import("./handlers/workouts.js");
		await handleWorkoutsToday(req, res, user);
		return;
	}

	if (req.method === "GET" && subPath === "/workouts/suggested") {
		const { handleWorkoutsSuggested } = await import("./handlers/workouts.js");
		await handleWorkoutsSuggested(req, res, user, url);
		return;
	}

	const workoutDetailMatch = subPath.match(/^\/workouts\/([^/]+)$/);
	if (req.method === "GET" && workoutDetailMatch) {
		const { handleWorkoutDetail } = await import("./handlers/workouts.js");
		await handleWorkoutDetail(req, res, user, workoutDetailMatch[1]);
		return;
	}

	if (req.method === "GET" && subPath === "/dashboard") {
		const { handleDashboard } = await import("./handlers/dashboard.js");
		await handleDashboard(req, res, user, url);
		return;
	}

	if (req.method === "GET" && subPath === "/compliance/summary") {
		const { handleComplianceSummary } = await import("./handlers/compliance.js");
		await handleComplianceSummary(req, res, user, url);
		return;
	}

	if (req.method === "GET" && subPath === "/compliance/detail") {
		const { handleComplianceDetail } = await import("./handlers/compliance.js");
		await handleComplianceDetail(req, res, user, url);
		return;
	}

	const rpeMatch = subPath.match(/^\/cross-training\/([^/]+)\/rpe$/);
	if (req.method === "POST" && rpeMatch) {
		const { handleCrossTrainingRpe } = await import("./handlers/cross-training.js");
		await handleCrossTrainingRpe(req, res, user, rpeMatch[1]);
		return;
	}

	apiError(res, 404, "not found");
}
