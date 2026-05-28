/**
 * One-shot diagnostic for the stride_rejected_on_recovery fallback.
 *
 * Pulls Stryd's "easy" recommendation set (what category=recovery maps to via
 * mapCategoryToStrydType) and prints each candidate's workout type + title.
 * If every candidate is type==="stride", pickStrydWorkout returns null on
 * recovery days and the dashboard surfaces "Stryd unavailable:
 * stride_rejected_on_recovery".
 */

import { readFileSync } from "node:fs";
import { StrydClient } from "../src/stryd/client.js";

const envContent = readFileSync(".env", "utf-8");
const env: Record<string, string> = {};
for (const line of envContent.split("\n")) {
	if (line.startsWith("#") || !line.includes("=")) continue;
	const [key, ...rest] = line.split("=");
	env[key.trim()] = rest.join("=").trim();
}

const email = env.STRYD_EMAIL;
const password = env.STRYD_PASSWORD;
if (!email || !password) {
	console.error("STRYD_EMAIL and STRYD_PASSWORD must be set in .env");
	process.exit(1);
}

async function main() {
	const client = new StrydClient({ email, password });
	await client.login();
	console.log("Authenticated.\n");

	for (const strydType of ["easy", "workout", "long"] as const) {
		const set = await client.getRecommendedWorkouts(strydType);
		if (set === null) {
			console.log(`type=${strydType}: 204 no content`);
			continue;
		}
		const candidates = set.workouts ?? [];
		console.log(`type=${strydType}: set.id=${set.id} candidates=${candidates.length}`);
		for (const c of candidates) {
			const w = c.estimated_workout.workout;
			const intensity = c.estimated_workout.average.intensity;
			console.log(
				`  - type=${w.type.padEnd(10)} title=${w.title.padEnd(40)} avg_intensity=${intensity.toFixed(2)}`,
			);
		}
		const allStrides =
			candidates.length > 0 &&
			candidates.every((c) => c.estimated_workout.workout.type === "stride");
		console.log(`  allStrides=${allStrides}\n`);
	}
}

main().catch((err) => {
	console.error("Error:", err);
	process.exit(1);
});
