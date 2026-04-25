/**
 * GET /api/health — service health + upstream reachability.
 *
 * Reachability is cached for 60 s so /health is cheap to poll and doesn't
 * DDoS intervals.icu / Stryd.
 */

import type { ServerResponse } from "node:http";
import type { IntervalsClient } from "../../intervals.js";
import type { StrydClient } from "../../stryd/client.js";
import { jsonResponse } from "../errors.js";
import type { HealthResponse } from "../types.js";

const REACHABILITY_TTL_MS = 60_000;

interface Reachability {
	intervals: boolean;
	stryd: boolean;
	checkedAt: number;
}

let cached: Reachability | null = null;

async function probeIntervals(clients: Map<string, IntervalsClient>): Promise<boolean> {
	const first = clients.values().next().value as IntervalsClient | undefined;
	if (!first) return false;
	try {
		await first.get(`/athlete/${first.athleteId}`);
		return true;
	} catch {
		return false;
	}
}

async function probeStryd(strydClients: Map<string, StrydClient>): Promise<boolean> {
	const first = strydClients.values().next().value as StrydClient | undefined;
	if (!first) return false;
	try {
		if (!first.isAuthenticated) await first.login();
		return first.isAuthenticated;
	} catch {
		return false;
	}
}

export async function handleHealth(
	res: ServerResponse,
	ctx: {
		intervalsClients: Map<string, IntervalsClient>;
		strydClients: Map<string, StrydClient>;
		usersConfigured: string[];
		startedAt: number;
		version: string;
	},
): Promise<void> {
	if (!cached || Date.now() - cached.checkedAt > REACHABILITY_TTL_MS) {
		const [intervals, stryd] = await Promise.all([
			probeIntervals(ctx.intervalsClients),
			probeStryd(ctx.strydClients),
		]);
		cached = { intervals, stryd, checkedAt: Date.now() };
	}

	const body: HealthResponse = {
		ok: cached.intervals,
		intervals_reachable: cached.intervals,
		stryd_reachable: cached.stryd,
		cache_age_s: Math.floor((Date.now() - ctx.startedAt) / 1000),
		version: ctx.version,
		users_configured: ctx.usersConfigured,
	};
	jsonResponse(res, 200, body);
}
