/**
 * Quick smoke test: authenticate with Stryd, list recent activities,
 * and download the most recent FIT file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { StrydClient } from "../src/stryd/client.js";

// Load credentials from .env
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

	console.log("Authenticating...");
	await client.login();
	console.log("Authenticated OK");

	const cp = await client.getLatestCriticalPower();
	console.log(`Critical Power: ${cp ? `${cp.toFixed(1)}W` : "unavailable"}`);

	console.log("\nListing activities (last 14 days)...");
	const activities = await client.listActivities(14);
	console.log(`Found ${activities.length} activities:\n`);

	const sorted = [...activities].sort((a, b) => b.timestamp - a.timestamp);
	for (const a of sorted) {
		const date = new Date(a.timestamp * 1000).toISOString().slice(0, 16);
		const distKm = (a.distance / 1000).toFixed(2);
		const mins = Math.floor(a.elapsed_time / 60);
		const secs = Math.round(a.elapsed_time % 60);
		console.log(
			`  ${date}  ID=${a.id}  ${distKm} km  ${a.average_power.toFixed(0)} W  ${mins}:${String(secs).padStart(2, "0")}`,
		);
	}

	if (sorted.length === 0) {
		console.log("No activities found — nothing to download.");
		return;
	}

	const latest = sorted[0];
	console.log(`\nDownloading FIT for latest activity (ID=${latest.id})...`);
	const fitBuffer = await client.downloadFit(latest.id);

	const outPath = `/tmp/stryd_${latest.id}.fit`;
	writeFileSync(outPath, fitBuffer);
	console.log(`Saved: ${outPath} (${(fitBuffer.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
	console.error("Error:", err);
	process.exit(1);
});
