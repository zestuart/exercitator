/**
 * Compliance aggregation: compute weekly/monthly rollups and trending data.
 */

import { getComplianceAssessments, getPrescriptions, saveComplianceAggregate } from "./persist.js";
import type { ComplianceAggregate, ComplianceTrend } from "./types.js";

/** Get the Monday of the week containing a date (ISO weeks). */
function weekStart(dateStr: string): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	const day = d.getUTCDay();
	const diff = day === 0 ? -6 : 1 - day; // Monday = 1
	d.setUTCDate(d.getUTCDate() + diff);
	return d.toISOString().slice(0, 10);
}

/** Get the first day of the month containing a date. */
function monthStart(dateStr: string): string {
	return `${dateStr.slice(0, 7)}-01`;
}

/**
 * Recompute aggregates for a user over a date range.
 * Rebuilds both weekly and monthly rollups.
 */
export function recomputeAggregates(userId: string, oldest: string, newest: string): void {
	const assessments = getComplianceAssessments(userId, oldest, newest);
	const prescriptions = getPrescriptions(userId, oldest, newest);

	// Group by period (week + month) and sport
	const weeklyBuckets = new Map<string, ComplianceAggregate>();
	const monthlyBuckets = new Map<string, ComplianceAggregate>();

	for (const rx of prescriptions) {
		const wk = weekStart(rx.date);
		const mo = monthStart(rx.date);

		for (const [period, start, buckets] of [
			["week", wk, weeklyBuckets],
			["month", mo, monthlyBuckets],
		] as const) {
			const key = `${start}-${rx.sport}`;
			if (!buckets.has(key)) {
				buckets.set(key, {
					userId,
					period,
					periodStart: start,
					sport: rx.sport,
					category: null,
					totalWorkouts: 0,
					completed: 0,
					skipped: 0,
					segmentsTotal: 0,
					segmentsPassed: 0,
					hrOvershootCount: 0,
					powerOvershootCount: 0,
				});
			}
			const agg = buckets.get(key) as ComplianceAggregate;
			agg.totalWorkouts++;

			const assessment = assessments.find((a) => a.prescriptionId === rx.id);
			if (assessment) {
				if (assessment.status === "completed") {
					agg.completed++;
					agg.segmentsTotal += assessment.segmentsTotal;
					agg.segmentsPassed += assessment.segmentsPassed;

					for (const seg of assessment.segments) {
						if (seg.hrZonePass === false) agg.hrOvershootCount++;
						if (seg.powerPass === false) agg.powerOvershootCount++;
					}
				} else if (assessment.status === "skipped") {
					agg.skipped++;
				}
			}
		}
	}

	// Persist all aggregates
	for (const agg of [...weeklyBuckets.values(), ...monthlyBuckets.values()]) {
		saveComplianceAggregate(agg);
	}
}

/**
 * Build a compliance trend summary for the API/MCP tools.
 */
export function buildComplianceTrend(
	userId: string,
	days: number,
	sport?: string,
): ComplianceTrend {
	const now = new Date();
	const oldest = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
	const newest = now.toISOString().slice(0, 10);

	const prescriptions = getPrescriptions(userId, oldest, newest);
	const assessments = getComplianceAssessments(userId, oldest, newest, sport);

	const filtered = sport ? prescriptions.filter((p) => p.sport === sport) : prescriptions;

	// Completion rate
	const totalPrescribed = filtered.length;
	const completed = assessments.filter((a) => a.status === "completed");
	const completionRate = totalPrescribed > 0 ? (completed.length / totalPrescribed) * 100 : 0;

	// Compliance rate (of completed, how many fully compliant)
	const fullyCompliant = completed.filter((a) => a.overallPass);
	const complianceRate =
		completed.length > 0 ? (fullyCompliant.length / completed.length) * 100 : 0;

	// By category
	const byCategory: Record<string, { total: number; compliant: number; rate: number }> = {};
	for (const rx of filtered) {
		if (!byCategory[rx.category]) {
			byCategory[rx.category] = { total: 0, compliant: 0, rate: 0 };
		}
		byCategory[rx.category].total++;
		const assessment = assessments.find((a) => a.prescriptionId === rx.id);
		if (assessment?.status === "completed" && assessment.overallPass) {
			byCategory[rx.category].compliant++;
		}
	}
	for (const cat of Object.values(byCategory)) {
		cat.rate = cat.total > 0 ? (cat.compliant / cat.total) * 100 : 0;
	}

	// Common deviations
	const deviationCounts: Record<string, number> = { hr: 0, power: 0, pace: 0, duration: 0 };
	for (const a of completed) {
		for (const seg of a.segments) {
			if (seg.hrZonePass === false) deviationCounts.hr++;
			if (seg.powerPass === false) deviationCounts.power++;
			if (seg.pacePass === false) deviationCounts.pace++;
			if (seg.durationPass === false) deviationCounts.duration++;
		}
	}
	const commonDeviations = Object.entries(deviationCounts)
		.filter(([, count]) => count > 0)
		.sort((a, b) => b[1] - a[1])
		.map(([metric, count]) => ({ metric, count }));

	// Weekly trend
	const weeklyMap = new Map<string, { completed: number; compliant: number; total: number }>();
	for (const rx of filtered) {
		const wk = weekStart(rx.date);
		if (!weeklyMap.has(wk)) weeklyMap.set(wk, { completed: 0, compliant: 0, total: 0 });
		const entry = weeklyMap.get(wk) as { completed: number; compliant: number; total: number };
		entry.total++;
		const assessment = assessments.find((a) => a.prescriptionId === rx.id);
		if (assessment?.status === "completed") {
			entry.completed++;
			if (assessment.overallPass) entry.compliant++;
		}
	}
	const weekly = [...weeklyMap.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([weekStartDate, data]) => ({
			weekStart: weekStartDate,
			rate: data.completed > 0 ? (data.compliant / data.completed) * 100 : 0,
			completed: data.completed,
			total: data.total,
		}));

	return { complianceRate, completionRate, byCategory, commonDeviations, weekly };
}
