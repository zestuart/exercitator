/**
 * Determines terrain guidance for running workouts.
 */

import type { ActivitySummary, TerrainPreference, WorkoutCategory } from "./types.js";

const RUN_TYPES = ["Run", "VirtualRun", "TrailRun", "Treadmill"];

export interface TerrainSelection {
	terrain: TerrainPreference;
	rationale: string;
}

function isRun(type: string): boolean {
	return RUN_TYPES.includes(type);
}

function daysAgo(dateStr: string, now: Date): number {
	return (now.getTime() - new Date(dateStr).getTime()) / (1000 * 86400);
}

export function selectTerrain(
	category: WorkoutCategory,
	activities: ActivitySummary[],
	now: Date = new Date(),
): TerrainSelection {
	// Rest produces no terrain guidance
	if (category === "rest") {
		return { terrain: "any", rationale: "Rest day — no terrain guidance needed" };
	}

	// Recovery and base: always flat to prevent power spikes above aerobic ceiling
	if (category === "recovery" || category === "base") {
		return {
			terrain: "flat",
			rationale:
				"Flat terrain recommended to keep power consistent and prevent intensity spikes from elevation changes",
		};
	}

	// Intervals: always flat for accurate power target execution
	if (category === "intervals") {
		return {
			terrain: "flat",
			rationale: "Flat terrain required for consistent interval power targets",
		};
	}

	const recentRuns = activities
		.filter((a) => isRun(a.type) && daysAgo(a.start_date_local, now) <= 14)
		.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));

	// Tempo: flat or rolling depending on recent terrain variety
	if (category === "tempo") {
		const last3Runs = recentRuns.slice(0, 3);
		const allFlat = last3Runs.every((a) => (a.total_elevation_gain ?? 0) < 30);
		if (allFlat && last3Runs.length > 0) {
			return {
				terrain: "rolling",
				rationale: "Recent runs have all been flat — rolling terrain adds variety to tempo effort",
			};
		}
		return {
			terrain: "flat",
			rationale: "Flat terrain recommended for consistent tempo pacing",
		};
	}

	// Long: rolling/trail if athlete regularly runs trails, otherwise flat
	if (category === "long") {
		const trailRuns = recentRuns.filter((a) => a.type === "TrailRun").length;
		const totalRuns = recentRuns.length;
		if (totalRuns > 0 && trailRuns / totalRuns > 0.5) {
			return {
				terrain: "trail",
				rationale: "Athlete regularly runs trails — trail terrain suits the long run",
			};
		}
		return {
			terrain: "flat",
			rationale: "Flat terrain recommended for steady-state long run pacing",
		};
	}

	return { terrain: "any", rationale: "No specific terrain guidance" };
}
