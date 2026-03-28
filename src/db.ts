/**
 * SQLite cache layer for intervals.icu responses.
 *
 * Used to reduce API calls for data that changes infrequently
 * (athlete profile, sport settings, gear, etc.).
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = process.env.EXERCITATOR_DB_PATH ?? "data/exercitator.db";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
	if (db) return db;

	const dir = dirname(DB_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	db = new Database(DB_PATH);
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

	db.exec(`
		CREATE TABLE IF NOT EXISTS stryd_enrichments (
			icu_activity_id   TEXT PRIMARY KEY,
			stryd_activity_id INTEGER NOT NULL,
			enriched_icu_id   TEXT NOT NULL,
			enriched_at       TEXT NOT NULL DEFAULT (datetime('now'))
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
