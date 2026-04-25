/**
 * GET /api/users/:userId/compliance/{summary,detail}
 *
 * Wraps the existing compliance module (see src/compliance/). Response shape
 * mirrors the MCP tool outputs; native clients read numbers, not prose.
 *
 * See phase2/exercitator-http-api-spec.md §5.4.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { buildComplianceTrend } from "../../compliance/aggregate.js";
import { getComplianceAssessments, getPrescriptions } from "../../compliance/persist.js";
import { apiError, jsonResponse } from "../errors.js";
import type { UserContext } from "../router.js";

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
	const n = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(n, lo), hi);
}

export async function handleComplianceSummary(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
	url: URL,
): Promise<void> {
	const weeks = clampInt(url.searchParams.get("weeks"), 1, 26, 4);
	const months = clampInt(url.searchParams.get("months"), 1, 12, 3);
	const sport = url.searchParams.get("sport") ?? undefined;

	try {
		const weeklyTrend = buildComplianceTrend(user.profile.id, weeks * 7, sport);
		const monthlyTrend = buildComplianceTrend(user.profile.id, months * 30, sport);
		jsonResponse(res, 200, {
			user_id: user.profile.id,
			weeks,
			months,
			sport: sport ?? null,
			weekly: weeklyTrend,
			monthly: monthlyTrend,
		});
	} catch (err) {
		console.error("handleComplianceSummary failed:", err);
		apiError(res, 500, "compliance summary failed");
	}
}

export async function handleComplianceDetail(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
	url: URL,
): Promise<void> {
	const now = new Date();
	const today = now.toISOString().slice(0, 10);
	const defaultFrom = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
	const from = url.searchParams.get("from") ?? defaultFrom;
	const to = url.searchParams.get("to") ?? today;

	if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
		apiError(res, 400, "from/to must be YYYY-MM-DD");
		return;
	}

	try {
		const prescriptions = getPrescriptions(user.profile.id, from, to);
		const assessments = getComplianceAssessments(user.profile.id, from, to);
		jsonResponse(res, 200, {
			user_id: user.profile.id,
			from,
			to,
			prescriptions: prescriptions.map((p) => ({
				id: p.id,
				date: p.date,
				sport: p.sport,
				category: p.category,
				title: p.title,
				planned_duration_s: p.totalDurationSecs,
				planned_load: p.estimatedLoad,
				readiness_score: p.readinessScore,
				generated_at: p.generatedAt,
			})),
			assessments: assessments.map((a) => ({
				prescription_id: a.prescriptionId,
				date: a.date,
				sport: a.sport,
				status: a.status,
				overall_pass: a.overallPass,
				segments_total: a.segmentsTotal,
				segments_passed: a.segmentsPassed,
				skip_reason: a.skipReason,
				assessed_at: a.assessedAt,
			})),
		});
	} catch (err) {
		console.error("handleComplianceDetail failed:", err);
		apiError(res, 500, "compliance detail failed");
	}
}
