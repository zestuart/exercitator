/** Compliance tracking types. */

import type { WorkoutCategory, WorkoutSegment } from "../engine/types.js";

/** Traffic light status for a segment or overall assessment. */
export type TrafficLight = "green" | "amber" | "red";

/** Per-segment compliance result. */
export interface SegmentCompliance {
	segmentIndex: number;
	segmentName: string;
	actualAvgHr: number | null;
	actualAvgPower: number | null;
	actualAvgPace: number | null; // secs/km
	actualDurationSecs: number | null;
	hrZonePass: boolean | null; // null = no target
	powerPass: boolean | null;
	pacePass: boolean | null;
	durationPass: boolean | null;
	hrZoneActual: number | null;
	powerDeviationPct: number | null;
	paceDeviationPct: number | null;
	segmentPass: boolean;
	light: TrafficLight;
}

/** Full compliance assessment for a single prescription. */
export interface ComplianceAssessment {
	id: number;
	prescriptionId: number;
	userId: string;
	date: string;
	sport: string;
	activityId: string | null;
	status: "completed" | "skipped" | "pending";
	skipReason: string | null;
	overallPass: boolean | null;
	segmentsTotal: number;
	segmentsPassed: number;
	assessedAt: string | null;
	segments: SegmentCompliance[];
}

/** Rendered compliance data passed to the UI. */
export interface ComplianceView {
	assessment: ComplianceAssessment | null;
	/** Pending confirmation: sent but not yet assessed. */
	pendingSent: boolean;
	/** The date of the prescription (for confirmation UI). */
	prescriptionDate: string | null;
}

/** Aggregated compliance data for trending. */
export interface ComplianceAggregate {
	userId: string;
	period: "week" | "month";
	periodStart: string;
	sport: string;
	category: string | null;
	totalWorkouts: number;
	completed: number;
	skipped: number;
	segmentsTotal: number;
	segmentsPassed: number;
	hrOvershootCount: number;
	powerOvershootCount: number;
}

/** Trending summary returned by the API/MCP tools. */
export interface ComplianceTrend {
	complianceRate: number; // % of completed workouts fully compliant
	completionRate: number; // % of prescribed workouts attempted
	byCategory: Record<string, { total: number; compliant: number; rate: number }>;
	commonDeviations: { metric: string; count: number }[];
	weekly: { weekStart: string; rate: number; completed: number; total: number }[];
}

/** Persisted prescription row (subset of fields for queries). */
export interface PrescriptionRow {
	id: number;
	userId: string;
	date: string;
	sport: string;
	category: WorkoutCategory;
	title: string;
	totalDurationSecs: number;
	estimatedLoad: number;
	readinessScore: number;
	hrZones: number[] | null;
	segments: WorkoutSegment[];
	suggestionJson: string;
	generatedAt: string;
}

/** Send event row. */
export interface SendEventRow {
	id: number;
	prescriptionId: number;
	userId: string;
	date: string;
	sport: string;
	target: "intervals" | "stryd";
	externalId: string | null;
	externalMeta: string | null;
	sentAt: string;
}
