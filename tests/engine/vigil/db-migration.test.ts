import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDb, getDb, getVigilMetrics } from "../../../src/db.js";

// Exercises the in-place upgrade path a real Cogitator DB takes: an existing
// vigil_metrics/vigil_baselines from before the source-provenance change. The
// :memory: tests always create fresh tables (already source-aware), so this is
// the only coverage of ALTER TABLE ADD COLUMN + the vigil_baselines PK rebuild.

let dir: string;
let dbPath: string;

/** Write the pre-source (athlete_id-era) Vigil schema + one row each. */
function seedLegacyDb(path: string): void {
	const legacy = new Database(path);
	legacy.exec(`
		CREATE TABLE vigil_metrics (
			activity_id TEXT PRIMARY KEY,
			athlete_id  TEXT NOT NULL DEFAULT '0',
			icu_activity_id TEXT,
			computed_at TEXT NOT NULL,
			activity_date TEXT NOT NULL,
			sport TEXT NOT NULL,
			surface_type TEXT,
			avg_gct_ms REAL, avg_lss REAL, avg_form_power REAL, avg_ilr REAL,
			avg_vo_cm REAL, avg_cadence REAL, form_power_ratio REAL,
			gct_drift_pct REAL, power_hr_drift REAL, stryd_rpe INTEGER, stryd_feel TEXT,
			l_avg_gct_ms REAL, r_avg_gct_ms REAL, l_avg_lss REAL, r_avg_lss REAL,
			l_avg_vo_cm REAL, r_avg_vo_cm REAL, l_avg_ilr REAL, r_avg_ilr REAL,
			gct_asymmetry_pct REAL, lss_asymmetry_pct REAL, vo_asymmetry_pct REAL, ilr_asymmetry_pct REAL
		);
		CREATE TABLE vigil_baselines (
			athlete_id TEXT NOT NULL DEFAULT '0',
			sport TEXT NOT NULL, metric TEXT NOT NULL, computed_at TEXT NOT NULL,
			mean_30d REAL NOT NULL, stddev_30d REAL NOT NULL, mean_7d REAL,
			sample_count_30d INTEGER NOT NULL, sample_count_7d INTEGER,
			PRIMARY KEY (athlete_id, sport, metric)
		);
	`);
	legacy
		.prepare(
			"INSERT INTO vigil_metrics (activity_id, athlete_id, computed_at, activity_date, sport, avg_gct_ms) VALUES (?, ?, datetime('now'), ?, ?, ?)",
		)
		.run("legacy-1", "0", "2026-03-20", "Run", 235);
	legacy
		.prepare(
			"INSERT INTO vigil_baselines (athlete_id, sport, metric, computed_at, mean_30d, stddev_30d, sample_count_30d) VALUES (?, ?, ?, datetime('now'), ?, ?, ?)",
		)
		.run("0", "Run", "avg_gct_ms", 235, 8, 12);
	legacy.close();
}

describe("Vigil DB source-provenance migration", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "exerc-mig-"));
		dbPath = join(dir, "exercitator.db");
	});

	afterEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = undefined;
		if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("adds source to vigil_metrics in place and preserves existing rows (default 'stryd')", () => {
		seedLegacyDb(dbPath);

		_resetDb();
		process.env.EXERCITATOR_DB_PATH = dbPath;
		getDb(); // triggers migration

		// Existing row survived and is tagged as Stryd (the pre-Garmin default).
		const rows = getVigilMetrics("0", "Run", "2026-03-01", "2026-03-31");
		expect(rows.length).toBe(1);
		expect(rows[0].activityId).toBe("legacy-1");
		expect(rows[0].source).toBe("stryd");

		// Source filter now works against the migrated table.
		expect(getVigilMetrics("0", "Run", "2026-03-01", "2026-03-31", "stryd").length).toBe(1);
		expect(getVigilMetrics("0", "Run", "2026-03-01", "2026-03-31", "garmin").length).toBe(0);
	});

	it("rebuilds vigil_baselines with source in the PK", () => {
		seedLegacyDb(dbPath);

		_resetDb();
		process.env.EXERCITATOR_DB_PATH = dbPath;
		const db = getDb(); // triggers migration

		const sql = (
			db.prepare("SELECT sql FROM sqlite_master WHERE name='vigil_baselines'").get() as {
				sql: string;
			}
		).sql;
		expect(sql).toContain("source");
		expect(sql).toMatch(/PRIMARY KEY \(athlete_id, source, sport, metric\)/);
	});
});
