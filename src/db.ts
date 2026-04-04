/**
 * SQLite cache layer for intervals.icu responses.
 *
 * Used to reduce API calls for data that changes infrequently
 * (athlete profile, sport settings, gear, etc.).
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

function getDbPath(): string {
	return process.env.EXERCITATOR_DB_PATH ?? "data/exercitator.db";
}

let db: Database.Database | null = null;

/** Reset the DB connection (for testing only). */
export function _resetDb(): void {
	if (db) db.close();
	db = null;
}

export function getDb(): Database.Database {
	if (db) return db;

	const dbPath = getDbPath();
	if (dbPath !== ":memory:") {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");

	db.exec(`
		CREATE TABLE IF NOT EXISTS cache (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			ttl   INTEGER NOT NULL,
			ts    INTEGER NOT NULL DEFAULT (unixepoch())
		)
	`);

	// Vigil metrics: per-activity biomechanical summaries, scoped by athlete_id.
	// Migration: if old schema exists (no athlete_id), drop and recreate.
	// Data is rebuilt from Stryd backfill on next prescription generation.
	const hasAthleteCol = db
		.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vigil_metrics'")
		.get() as { sql: string } | undefined;
	if (hasAthleteCol && !hasAthleteCol.sql.includes("athlete_id")) {
		db.exec("DROP TABLE IF EXISTS vigil_metrics");
		db.exec("DROP TABLE IF EXISTS vigil_baselines");
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS vigil_metrics (
			activity_id       TEXT PRIMARY KEY,
			athlete_id        TEXT NOT NULL DEFAULT '0',
			icu_activity_id   TEXT,
			computed_at       TEXT NOT NULL,
			activity_date     TEXT NOT NULL,
			sport             TEXT NOT NULL,
			surface_type      TEXT,
			avg_gct_ms        REAL,
			avg_lss           REAL,
			avg_form_power    REAL,
			avg_ilr           REAL,
			avg_vo_cm         REAL,
			avg_cadence       REAL,
			form_power_ratio  REAL,
			gct_drift_pct     REAL,
			power_hr_drift    REAL,
			stryd_rpe         INTEGER,
			stryd_feel        TEXT,
			l_avg_gct_ms      REAL,
			r_avg_gct_ms      REAL,
			l_avg_lss         REAL,
			r_avg_lss         REAL,
			l_avg_vo_cm       REAL,
			r_avg_vo_cm       REAL,
			l_avg_ilr         REAL,
			r_avg_ilr         REAL,
			gct_asymmetry_pct REAL,
			lss_asymmetry_pct REAL,
			vo_asymmetry_pct  REAL,
			ilr_asymmetry_pct REAL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS vigil_baselines (
			athlete_id       TEXT NOT NULL DEFAULT '0',
			sport            TEXT NOT NULL,
			metric           TEXT NOT NULL,
			computed_at      TEXT NOT NULL,
			mean_30d         REAL NOT NULL,
			stddev_30d       REAL NOT NULL,
			mean_7d          REAL,
			sample_count_30d INTEGER NOT NULL,
			sample_count_7d  INTEGER,
			PRIMARY KEY (athlete_id, sport, metric)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS stryd_enrichments (
			icu_activity_id   TEXT PRIMARY KEY,
			stryd_activity_id INTEGER NOT NULL,
			enriched_icu_id   TEXT NOT NULL,
			enriched_at       TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	// -----------------------------------------------------------------------
	// Compliance tracking tables
	// -----------------------------------------------------------------------

	db.exec(`
		CREATE TABLE IF NOT EXISTS prescriptions (
			id                  INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id             TEXT NOT NULL,
			date                TEXT NOT NULL,
			sport               TEXT NOT NULL,
			category            TEXT NOT NULL,
			title               TEXT NOT NULL,
			total_duration_secs INTEGER NOT NULL,
			estimated_load      REAL NOT NULL,
			readiness_score     INTEGER NOT NULL,
			hr_zones_json       TEXT,
			suggestion_json     TEXT NOT NULL,
			generated_at        TEXT NOT NULL,
			UNIQUE(user_id, date, sport)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS prescription_segments (
			id                    INTEGER PRIMARY KEY AUTOINCREMENT,
			prescription_id       INTEGER NOT NULL REFERENCES prescriptions(id),
			segment_index         INTEGER NOT NULL,
			name                  TEXT NOT NULL,
			duration_secs         INTEGER NOT NULL,
			target_hr_zone        INTEGER,
			target_power_low      REAL,
			target_power_high     REAL,
			target_pace_secs_low  REAL,
			target_pace_secs_high REAL,
			repeats               INTEGER,
			work_duration_secs    INTEGER,
			rest_duration_secs    INTEGER,
			UNIQUE(prescription_id, segment_index)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS send_events (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
			user_id         TEXT NOT NULL,
			date            TEXT NOT NULL,
			sport           TEXT NOT NULL,
			target          TEXT NOT NULL,
			external_id     TEXT,
			external_meta   TEXT,
			sent_at         TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(user_id, date, sport, target)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS compliance_assessments (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			prescription_id   INTEGER NOT NULL REFERENCES prescriptions(id),
			user_id           TEXT NOT NULL,
			date              TEXT NOT NULL,
			sport             TEXT NOT NULL,
			activity_id       TEXT,
			status            TEXT NOT NULL,
			skip_reason       TEXT,
			overall_pass      INTEGER,
			segments_total    INTEGER NOT NULL DEFAULT 0,
			segments_passed   INTEGER NOT NULL DEFAULT 0,
			assessed_at       TEXT,
			created_at        TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(prescription_id)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS segment_compliance (
			id                  INTEGER PRIMARY KEY AUTOINCREMENT,
			assessment_id       INTEGER NOT NULL REFERENCES compliance_assessments(id),
			segment_index       INTEGER NOT NULL,
			segment_name        TEXT NOT NULL,
			actual_avg_hr       REAL,
			actual_avg_power    REAL,
			actual_avg_pace     REAL,
			actual_duration_secs INTEGER,
			hr_zone_pass        INTEGER,
			power_pass          INTEGER,
			pace_pass           INTEGER,
			duration_pass       INTEGER,
			hr_zone_actual      INTEGER,
			power_deviation_pct REAL,
			pace_deviation_pct  REAL,
			segment_pass        INTEGER NOT NULL,
			UNIQUE(assessment_id, segment_index)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS compliance_aggregates (
			id                    INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id               TEXT NOT NULL,
			period                TEXT NOT NULL,
			period_start          TEXT NOT NULL,
			sport                 TEXT NOT NULL,
			category              TEXT,
			total_workouts        INTEGER NOT NULL DEFAULT 0,
			completed             INTEGER NOT NULL DEFAULT 0,
			skipped               INTEGER NOT NULL DEFAULT 0,
			segments_total        INTEGER NOT NULL DEFAULT 0,
			segments_passed       INTEGER NOT NULL DEFAULT 0,
			hr_overshoot_count    INTEGER NOT NULL DEFAULT 0,
			power_overshoot_count INTEGER NOT NULL DEFAULT 0,
			computed_at           TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(user_id, period, period_start, sport, category)
		)
	`);

	return db;
}

const getStmt = () =>
	getDb().prepare("SELECT value FROM cache WHERE key = ? AND ts + ttl > unixepoch()");
const setStmt = () =>
	getDb().prepare(
		"INSERT OR REPLACE INTO cache (key, value, ttl, ts) VALUES (?, ?, ?, unixepoch())",
	);
const delStmt = () => getDb().prepare("DELETE FROM cache WHERE key = ?");

/** Get a cached value, or null if expired/missing. */
export function cacheGet<T = unknown>(key: string): T | null {
	const row = getStmt().get(key) as { value: string } | undefined;
	if (!row) return null;
	return JSON.parse(row.value) as T;
}

/** Cache a value with a TTL in seconds. */
export function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
	setStmt().run(key, JSON.stringify(value), ttlSeconds);
}

/** Invalidate a cache entry. */
export function cacheDel(key: string): void {
	delStmt().run(key);
}

/** Prune all expired entries. */
export function cachePrune(): number {
	const result = getDb().prepare("DELETE FROM cache WHERE ts + ttl <= unixepoch()").run();
	return result.changes;
}

// ---------------------------------------------------------------------------
// Stryd enrichment tracking
// ---------------------------------------------------------------------------

/** Check if an intervals.icu activity has already been enriched with Stryd FIT data. */
export function isAlreadyEnriched(icuActivityId: string): boolean {
	const row = getDb()
		.prepare("SELECT 1 FROM stryd_enrichments WHERE icu_activity_id = ?")
		.get(icuActivityId);
	return row !== undefined;
}

/** Record a successful Stryd FIT enrichment. */
export function recordEnrichment(
	icuActivityId: string,
	strydActivityId: number,
	enrichedIcuId: string,
): void {
	getDb()
		.prepare(
			"INSERT OR REPLACE INTO stryd_enrichments (icu_activity_id, stryd_activity_id, enriched_icu_id) VALUES (?, ?, ?)",
		)
		.run(icuActivityId, strydActivityId, enrichedIcuId);
}

// ---------------------------------------------------------------------------
// Vigil metric tracking
// ---------------------------------------------------------------------------

import type { VigilBaseline, VigilMetrics } from "./engine/vigil/types.js";

/** Check if any Vigil metrics exist for a given athlete (for triggering initial backfill). */
export function hasAnyVigilMetrics(athleteId: string): boolean {
	const row = getDb()
		.prepare("SELECT 1 FROM vigil_metrics WHERE athlete_id = ? LIMIT 1")
		.get(athleteId);
	return row !== undefined;
}

/** Check if Vigil metrics have already been computed for a Stryd activity. */
export function hasVigilMetrics(activityId: string): boolean {
	const row = getDb().prepare("SELECT 1 FROM vigil_metrics WHERE activity_id = ?").get(activityId);
	return row !== undefined;
}

/** Save computed Vigil metrics for an activity. */
export function saveVigilMetrics(m: VigilMetrics): void {
	getDb()
		.prepare(
			`INSERT OR REPLACE INTO vigil_metrics (
				activity_id, athlete_id, icu_activity_id, computed_at, activity_date, sport, surface_type,
				avg_gct_ms, avg_lss, avg_form_power, avg_ilr, avg_vo_cm, avg_cadence,
				form_power_ratio, gct_drift_pct, power_hr_drift, stryd_rpe, stryd_feel,
				l_avg_gct_ms, r_avg_gct_ms, l_avg_lss, r_avg_lss,
				l_avg_vo_cm, r_avg_vo_cm, l_avg_ilr, r_avg_ilr,
				gct_asymmetry_pct, lss_asymmetry_pct, vo_asymmetry_pct, ilr_asymmetry_pct
			) VALUES (
				?, ?, ?, datetime('now'), ?, ?, ?,
				?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?,
				?, ?, ?, ?,
				?, ?, ?, ?,
				?, ?, ?, ?
			)`,
		)
		.run(
			m.activityId,
			m.athleteId,
			m.icuActivityId,
			m.activityDate,
			m.sport,
			m.surfaceType,
			m.avgGctMs,
			m.avgLss,
			m.avgFormPower,
			m.avgIlr,
			m.avgVoCm,
			m.avgCadence,
			m.formPowerRatio,
			m.gctDriftPct,
			m.powerHrDrift,
			m.strydRpe,
			m.strydFeel,
			m.lAvgGctMs,
			m.rAvgGctMs,
			m.lAvgLss,
			m.rAvgLss,
			m.lAvgVoCm,
			m.rAvgVoCm,
			m.lAvgIlr,
			m.rAvgIlr,
			m.gctAsymmetryPct,
			m.lssAsymmetryPct,
			m.voAsymmetryPct,
			m.ilrAsymmetryPct,
		);
}

/** Fetch Vigil metrics for a date range, ordered by date descending. */
export function getVigilMetrics(
	athleteId: string,
	sport: string,
	oldestDate: string,
	newestDate: string,
): VigilMetrics[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM vigil_metrics
			 WHERE athlete_id = ? AND sport = ? AND activity_date >= ? AND activity_date <= ?
			 ORDER BY activity_date DESC`,
		)
		.all(athleteId, sport, oldestDate, newestDate) as Record<string, unknown>[];

	return rows.map(rowToVigilMetrics);
}

/** Count Vigil metrics for a sport in a date range. */
export function countVigilMetrics(
	athleteId: string,
	sport: string,
	oldestDate: string,
	newestDate: string,
): number {
	const row = getDb()
		.prepare(
			`SELECT COUNT(*) as cnt FROM vigil_metrics
			 WHERE athlete_id = ? AND sport = ? AND activity_date >= ? AND activity_date <= ?`,
		)
		.get(athleteId, sport, oldestDate, newestDate) as { cnt: number };
	return row.cnt;
}

function rowToVigilMetrics(r: Record<string, unknown>): VigilMetrics {
	return {
		athleteId: r.athlete_id as string,
		activityId: r.activity_id as string,
		icuActivityId: r.icu_activity_id as string | null,
		activityDate: r.activity_date as string,
		sport: r.sport as string,
		surfaceType: r.surface_type as string | null,
		avgGctMs: r.avg_gct_ms as number | null,
		avgLss: r.avg_lss as number | null,
		avgFormPower: r.avg_form_power as number | null,
		avgIlr: r.avg_ilr as number | null,
		avgVoCm: r.avg_vo_cm as number | null,
		avgCadence: r.avg_cadence as number | null,
		formPowerRatio: r.form_power_ratio as number | null,
		gctDriftPct: r.gct_drift_pct as number | null,
		powerHrDrift: r.power_hr_drift as number | null,
		strydRpe: r.stryd_rpe as number | null,
		strydFeel: r.stryd_feel as string | null,
		lAvgGctMs: r.l_avg_gct_ms as number | null,
		rAvgGctMs: r.r_avg_gct_ms as number | null,
		lAvgLss: r.l_avg_lss as number | null,
		rAvgLss: r.r_avg_lss as number | null,
		lAvgVoCm: r.l_avg_vo_cm as number | null,
		rAvgVoCm: r.r_avg_vo_cm as number | null,
		lAvgIlr: r.l_avg_ilr as number | null,
		rAvgIlr: r.r_avg_ilr as number | null,
		gctAsymmetryPct: r.gct_asymmetry_pct as number | null,
		lssAsymmetryPct: r.lss_asymmetry_pct as number | null,
		voAsymmetryPct: r.vo_asymmetry_pct as number | null,
		ilrAsymmetryPct: r.ilr_asymmetry_pct as number | null,
	};
}

// ---------------------------------------------------------------------------
// Vigil baseline tracking
// ---------------------------------------------------------------------------

/** Save or update a baseline entry. */
export function saveVigilBaseline(b: VigilBaseline): void {
	getDb()
		.prepare(
			`INSERT OR REPLACE INTO vigil_baselines (
				athlete_id, sport, metric, computed_at, mean_30d, stddev_30d,
				mean_7d, sample_count_30d, sample_count_7d
			) VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
		)
		.run(
			b.athleteId,
			b.sport,
			b.metric,
			b.mean30d,
			b.stddev30d,
			b.mean7d,
			b.sampleCount30d,
			b.sampleCount7d,
		);
}

/** Fetch all baselines for a sport, scoped to an athlete. */
export function getVigilBaselines(athleteId: string, sport: string): VigilBaseline[] {
	const rows = getDb()
		.prepare("SELECT * FROM vigil_baselines WHERE athlete_id = ? AND sport = ?")
		.all(athleteId, sport) as Record<string, unknown>[];

	return rows.map((r) => ({
		athleteId: r.athlete_id as string,
		sport: r.sport as string,
		metric: r.metric as string,
		computedAt: r.computed_at as string,
		mean30d: r.mean_30d as number,
		stddev30d: r.stddev_30d as number,
		mean7d: r.mean_7d as number | null,
		sampleCount30d: r.sample_count_30d as number,
		sampleCount7d: r.sample_count_7d as number | null,
	}));
}
