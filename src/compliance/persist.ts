/**
 * Compliance persistence: read/write for prescriptions, send events,
 * assessments, segment compliance, and aggregates.
 */

import { getDb } from "../db.js";
import type { WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";
import type {
	ComplianceAggregate,
	ComplianceAssessment,
	PrescriptionRow,
	SegmentCompliance,
	SendEventRow,
	TrafficLight,
} from "./types.js";

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

/** Persist a prescription (upsert by user+date+sport). Returns the row ID. */
export function persistPrescription(
	userId: string,
	date: string,
	suggestion: WorkoutSuggestion,
	hrZones: number[] | null,
	generatedAt: string,
): number {
	const db = getDb();

	const existing = db
		.prepare("SELECT id FROM prescriptions WHERE user_id = ? AND date = ? AND sport = ?")
		.get(userId, date, suggestion.sport) as { id: number } | undefined;

	if (existing) return existing.id;

	const result = db
		.prepare(
			`INSERT INTO prescriptions
				(user_id, date, sport, category, title, total_duration_secs, estimated_load,
				 readiness_score, hr_zones_json, suggestion_json, generated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			userId,
			date,
			suggestion.sport,
			suggestion.category,
			suggestion.title,
			suggestion.total_duration_secs,
			suggestion.estimated_load,
			suggestion.readiness_score,
			hrZones ? JSON.stringify(hrZones) : null,
			JSON.stringify(suggestion),
			generatedAt,
		);

	const prescriptionId = Number(result.lastInsertRowid);

	const insertSeg = db.prepare(
		`INSERT INTO prescription_segments
			(prescription_id, segment_index, name, duration_secs, target_hr_zone,
			 target_power_low, target_power_high, target_pace_secs_low, target_pace_secs_high,
			 repeats, work_duration_secs, rest_duration_secs)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (let i = 0; i < suggestion.segments.length; i++) {
		const s = suggestion.segments[i];
		insertSeg.run(
			prescriptionId,
			i,
			s.name,
			s.duration_secs,
			s.target_hr_zone ?? null,
			s.target_power_low ?? null,
			s.target_power_high ?? null,
			s.target_pace_secs_low ?? null,
			s.target_pace_secs_high ?? null,
			s.repeats ?? null,
			s.work_duration_secs ?? null,
			s.rest_duration_secs ?? null,
		);
	}

	return prescriptionId;
}

/** Get a prescription by user+date+sport. */
export function getPrescription(
	userId: string,
	date: string,
	sport: string,
): PrescriptionRow | null {
	const db = getDb();
	const row = db
		.prepare("SELECT * FROM prescriptions WHERE user_id = ? AND date = ? AND sport = ?")
		.get(userId, date, sport) as Record<string, unknown> | undefined;

	if (!row) return null;
	return rowToPrescription(row);
}

/** Get a prescription by ID. */
export function getPrescriptionById(id: number): PrescriptionRow | null {
	const row = getDb().prepare("SELECT * FROM prescriptions WHERE id = ?").get(id) as
		| Record<string, unknown>
		| undefined;
	if (!row) return null;
	return rowToPrescription(row);
}

/** Get all prescriptions for a user in a date range. */
export function getPrescriptions(
	userId: string,
	oldest: string,
	newest: string,
): PrescriptionRow[] {
	const rows = getDb()
		.prepare(
			"SELECT * FROM prescriptions WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC",
		)
		.all(userId, oldest, newest) as Record<string, unknown>[];
	return rows.map(rowToPrescription);
}

function rowToPrescription(r: Record<string, unknown>): PrescriptionRow {
	const suggestion = JSON.parse(r.suggestion_json as string) as WorkoutSuggestion;
	return {
		id: r.id as number,
		userId: r.user_id as string,
		date: r.date as string,
		sport: r.sport as string,
		category: suggestion.category,
		title: r.title as string,
		totalDurationSecs: r.total_duration_secs as number,
		estimatedLoad: r.estimated_load as number,
		readinessScore: r.readiness_score as number,
		hrZones: r.hr_zones_json ? (JSON.parse(r.hr_zones_json as string) as number[]) : null,
		segments: suggestion.segments,
		suggestionJson: r.suggestion_json as string,
		generatedAt: r.generated_at as string,
	};
}

// ---------------------------------------------------------------------------
// Send events
// ---------------------------------------------------------------------------

/** Record a send event (upsert). Returns the row ID. */
export function persistSendEvent(
	prescriptionId: number,
	userId: string,
	date: string,
	sport: string,
	target: "intervals" | "stryd",
	externalId: string | null,
	externalMeta?: Record<string, unknown>,
): number {
	const db = getDb();
	const result = db
		.prepare(
			`INSERT OR REPLACE INTO send_events
				(prescription_id, user_id, date, sport, target, external_id, external_meta)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			prescriptionId,
			userId,
			date,
			sport,
			target,
			externalId,
			externalMeta ? JSON.stringify(externalMeta) : null,
		);
	return Number(result.lastInsertRowid);
}

/** Check if a send event exists (for dedup). */
export function getSendEvent(
	userId: string,
	date: string,
	sport: string,
	target: "intervals" | "stryd",
): SendEventRow | null {
	const row = getDb()
		.prepare(
			"SELECT * FROM send_events WHERE user_id = ? AND date = ? AND sport = ? AND target = ?",
		)
		.get(userId, date, sport, target) as Record<string, unknown> | undefined;
	if (!row) return null;
	return rowToSendEvent(row);
}

/** Get all send events for a user in a date range. */
export function getSendEvents(userId: string, oldest: string, newest: string): SendEventRow[] {
	const rows = getDb()
		.prepare(
			"SELECT * FROM send_events WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC",
		)
		.all(userId, oldest, newest) as Record<string, unknown>[];
	return rows.map(rowToSendEvent);
}

function rowToSendEvent(r: Record<string, unknown>): SendEventRow {
	return {
		id: r.id as number,
		prescriptionId: r.prescription_id as number,
		userId: r.user_id as string,
		date: r.date as string,
		sport: r.sport as string,
		target: r.target as "intervals" | "stryd",
		externalId: r.external_id as string | null,
		externalMeta: r.external_meta as string | null,
		sentAt: r.sent_at as string,
	};
}

// ---------------------------------------------------------------------------
// Compliance assessments
// ---------------------------------------------------------------------------

/** Save a compliance assessment with its segment results. Returns the assessment ID. */
export function saveComplianceAssessment(
	prescriptionId: number,
	userId: string,
	date: string,
	sport: string,
	activityId: string | null,
	status: "completed" | "skipped" | "pending",
	skipReason: string | null,
	overallPass: boolean | null,
	segmentsTotal: number,
	segmentsPassed: number,
	segments: SegmentCompliance[],
): number {
	const db = getDb();

	// Upsert: delete existing assessment for this prescription
	const existing = db
		.prepare("SELECT id FROM compliance_assessments WHERE prescription_id = ?")
		.get(prescriptionId) as { id: number } | undefined;

	if (existing) {
		db.prepare("DELETE FROM segment_compliance WHERE assessment_id = ?").run(existing.id);
		db.prepare("DELETE FROM compliance_assessments WHERE id = ?").run(existing.id);
	}

	const result = db
		.prepare(
			`INSERT INTO compliance_assessments
				(prescription_id, user_id, date, sport, activity_id, status,
				 skip_reason, overall_pass, segments_total, segments_passed, assessed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		)
		.run(
			prescriptionId,
			userId,
			date,
			sport,
			activityId,
			status,
			skipReason,
			overallPass === null ? null : overallPass ? 1 : 0,
			segmentsTotal,
			segmentsPassed,
		);

	const assessmentId = Number(result.lastInsertRowid);

	const insertSeg = db.prepare(
		`INSERT INTO segment_compliance
			(assessment_id, segment_index, segment_name, actual_avg_hr, actual_avg_power,
			 actual_avg_pace, actual_duration_secs, hr_zone_pass, power_pass, pace_pass,
			 duration_pass, hr_zone_actual, power_deviation_pct, pace_deviation_pct, segment_pass)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const s of segments) {
		insertSeg.run(
			assessmentId,
			s.segmentIndex,
			s.segmentName,
			s.actualAvgHr,
			s.actualAvgPower,
			s.actualAvgPace,
			s.actualDurationSecs,
			boolToInt(s.hrZonePass),
			boolToInt(s.powerPass),
			boolToInt(s.pacePass),
			boolToInt(s.durationPass),
			s.hrZoneActual,
			s.powerDeviationPct,
			s.paceDeviationPct,
			s.segmentPass ? 1 : 0,
		);
	}

	return assessmentId;
}

/** Get compliance assessment for a prescription. */
export function getComplianceAssessment(prescriptionId: number): ComplianceAssessment | null {
	const db = getDb();
	const row = db
		.prepare("SELECT * FROM compliance_assessments WHERE prescription_id = ?")
		.get(prescriptionId) as Record<string, unknown> | undefined;

	if (!row) return null;

	const segments = db
		.prepare("SELECT * FROM segment_compliance WHERE assessment_id = ? ORDER BY segment_index")
		.all(row.id as number) as Record<string, unknown>[];

	return rowToAssessment(row, segments);
}

/** Get compliance assessment by user+date+sport. */
export function getComplianceForDate(
	userId: string,
	date: string,
	sport: string,
): ComplianceAssessment | null {
	const db = getDb();
	const row = db
		.prepare("SELECT * FROM compliance_assessments WHERE user_id = ? AND date = ? AND sport = ?")
		.get(userId, date, sport) as Record<string, unknown> | undefined;

	if (!row) return null;

	const segments = db
		.prepare("SELECT * FROM segment_compliance WHERE assessment_id = ? ORDER BY segment_index")
		.all(row.id as number) as Record<string, unknown>[];

	return rowToAssessment(row, segments);
}

/** Get all assessments for a user in a date range. */
export function getComplianceAssessments(
	userId: string,
	oldest: string,
	newest: string,
	sport?: string,
): ComplianceAssessment[] {
	const db = getDb();
	const query = sport
		? "SELECT * FROM compliance_assessments WHERE user_id = ? AND date >= ? AND date <= ? AND sport = ? ORDER BY date DESC"
		: "SELECT * FROM compliance_assessments WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC";

	const params = sport ? [userId, oldest, newest, sport] : [userId, oldest, newest];
	const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

	return rows.map((row) => {
		const segments = db
			.prepare("SELECT * FROM segment_compliance WHERE assessment_id = ? ORDER BY segment_index")
			.all(row.id as number) as Record<string, unknown>[];
		return rowToAssessment(row, segments);
	});
}

function rowToAssessment(
	r: Record<string, unknown>,
	segRows: Record<string, unknown>[],
): ComplianceAssessment {
	return {
		id: r.id as number,
		prescriptionId: r.prescription_id as number,
		userId: r.user_id as string,
		date: r.date as string,
		sport: r.sport as string,
		activityId: r.activity_id as string | null,
		status: r.status as "completed" | "skipped" | "pending",
		skipReason: r.skip_reason as string | null,
		overallPass: r.overall_pass === null ? null : (r.overall_pass as number) === 1,
		segmentsTotal: r.segments_total as number,
		segmentsPassed: r.segments_passed as number,
		assessedAt: r.assessed_at as string | null,
		segments: segRows.map(rowToSegmentCompliance),
	};
}

function rowToSegmentCompliance(r: Record<string, unknown>): SegmentCompliance {
	const hrPass = intToBool(r.hr_zone_pass as number | null);
	const powerPass = intToBool(r.power_pass as number | null);
	const pacePass = intToBool(r.pace_pass as number | null);
	const durationPass = intToBool(r.duration_pass as number | null);
	const segPass = (r.segment_pass as number) === 1;

	return {
		segmentIndex: r.segment_index as number,
		segmentName: r.segment_name as string,
		actualAvgHr: r.actual_avg_hr as number | null,
		actualAvgPower: r.actual_avg_power as number | null,
		actualAvgPace: r.actual_avg_pace as number | null,
		actualDurationSecs: r.actual_duration_secs as number | null,
		hrZonePass: hrPass,
		powerPass: powerPass,
		pacePass: pacePass,
		durationPass: durationPass,
		hrZoneActual: r.hr_zone_actual as number | null,
		powerDeviationPct: r.power_deviation_pct as number | null,
		paceDeviationPct: r.pace_deviation_pct as number | null,
		segmentPass: segPass,
		light: segPass
			? "green"
			: hasAnyPass(hrPass, powerPass, pacePass, durationPass)
				? "amber"
				: "red",
	};
}

function boolToInt(v: boolean | null): number | null {
	if (v === null) return null;
	return v ? 1 : 0;
}

function intToBool(v: number | null): boolean | null {
	if (v === null) return null;
	return v === 1;
}

function hasAnyPass(...values: (boolean | null)[]): boolean {
	return values.some((v) => v === true);
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/** Save or update a compliance aggregate. */
export function saveComplianceAggregate(a: ComplianceAggregate): void {
	getDb()
		.prepare(
			`INSERT OR REPLACE INTO compliance_aggregates
				(user_id, period, period_start, sport, category,
				 total_workouts, completed, skipped, segments_total, segments_passed,
				 hr_overshoot_count, power_overshoot_count, computed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		)
		.run(
			a.userId,
			a.period,
			a.periodStart,
			a.sport,
			a.category,
			a.totalWorkouts,
			a.completed,
			a.skipped,
			a.segmentsTotal,
			a.segmentsPassed,
			a.hrOvershootCount,
			a.powerOvershootCount,
		);
}

/** Get aggregates for a user, filtered by period and sport. */
export function getComplianceAggregates(
	userId: string,
	period: "week" | "month",
	sport?: string,
	oldest?: string,
): ComplianceAggregate[] {
	const db = getDb();
	let query =
		"SELECT * FROM compliance_aggregates WHERE user_id = ? AND period = ? AND category IS NULL";
	const params: unknown[] = [userId, period];

	if (sport) {
		query += " AND sport = ?";
		params.push(sport);
	}
	if (oldest) {
		query += " AND period_start >= ?";
		params.push(oldest);
	}

	query += " ORDER BY period_start DESC";

	const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
	return rows.map(rowToAggregate);
}

function rowToAggregate(r: Record<string, unknown>): ComplianceAggregate {
	return {
		userId: r.user_id as string,
		period: r.period as "week" | "month",
		periodStart: r.period_start as string,
		sport: r.sport as string,
		category: r.category as string | null,
		totalWorkouts: r.total_workouts as number,
		completed: r.completed as number,
		skipped: r.skipped as number,
		segmentsTotal: r.segments_total as number,
		segmentsPassed: r.segments_passed as number,
		hrOvershootCount: r.hr_overshoot_count as number,
		powerOvershootCount: r.power_overshoot_count as number,
	};
}
