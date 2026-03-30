/**
 * Server-side HTML renderer for the Praescriptor web UI.
 * Produces a self-contained page with inlined CSS and JS.
 */

import type { VigilSummary, WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";
import type { Invocations } from "./invocations.js";
import type { DataSource } from "./prescriptions.js";
import type { UserProfile } from "./users.js";

export interface RenderData {
	profile: UserProfile;
	run: WorkoutSuggestion | null;
	swim: WorkoutSuggestion | null;
	runInvocations: Invocations | null;
	swimInvocations: Invocations | null;
	/** HR zone ceilings from intervals.icu (index 0 = Z1 ceiling, etc.) */
	runHrZones: number[] | null;
	swimHrZones: number[] | null;
	dataSource: DataSource;
	generatedAt: string;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatDuration(secs: number): string {
	const h = Math.floor(secs / 3600);
	const m = Math.floor((secs % 3600) / 60);
	if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
	return `${m}min`;
}

function dayName(dateStr: string): string {
	const d = new Date(dateStr);
	return d.toLocaleDateString("en-GB", { weekday: "long" });
}

/**
 * Build a zone guide string for a segment.
 *
 * Running (with power): "Z2 (161–219W)"
 * Running (no power):   "Z2"
 * Swimming (with HR):   "Z2 (137–145bpm)"
 * Swimming (no HR):     "Z2"
 */
function zoneGuide(
	seg: WorkoutSegment,
	sport: "Run" | "Swim",
	ftp: number,
	hrZones: number[] | null,
): string {
	if (seg.target_hr_zone == null) return "";
	const z = seg.target_hr_zone;
	const label = `Z${z}`;

	if (sport === "Run" && ftp > 0) {
		// Derive watts from FTP zone percentages
		const zonePcts: [number, number][] = [
			[0, 55],
			[55, 75],
			[75, 90],
			[90, 105],
			[105, 120],
		];
		const pcts = zonePcts[z - 1] ?? zonePcts[zonePcts.length - 1];
		const lo = Math.round((ftp * pcts[0]) / 100);
		const hi = Math.round((ftp * pcts[1]) / 100);
		return lo === 0 ? `${label} (&lt;${hi}W)` : `${label} (${lo}\u2013${hi}W)`;
	}

	if (sport === "Swim" && hrZones && hrZones.length > 0) {
		// hrZones[i] is the ceiling of zone i+1; floor is previous ceiling
		const ceiling = hrZones[z - 1] ?? hrZones[hrZones.length - 1];
		const floor = z >= 2 ? hrZones[z - 2] : null;
		return floor ? `${label} (${floor}\u2013${ceiling}bpm)` : `${label} (&lt;${ceiling}bpm)`;
	}

	return label;
}

function renderSegment(
	seg: WorkoutSegment,
	accent: string,
	sport: "Run" | "Swim",
	ftp: number,
	hrZones: number[] | null,
): string {
	const dur = formatDuration(seg.duration_secs);
	const repeatInfo =
		seg.repeats && seg.repeats > 1
			? `<span class="segment-repeats">${seg.repeats}&times;</span>`
			: "";
	const guide = zoneGuide(seg, sport, ftp, hrZones);

	return `
		<div class="segment">
			<div class="segment-header">
				<span class="segment-name">${escapeHtml(seg.name)}</span>
				<span class="segment-duration">${dur}</span>
			</div>
			<div class="segment-target">${repeatInfo}${escapeHtml(seg.target_description)}${guide ? ` <span class="zone-guide">${guide}</span>` : ""}</div>
		</div>`;
}

function renderWarnings(warnings: string[]): string {
	if (warnings.length === 0) return "";
	const items = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("");
	return `<div class="warnings"><ul>${items}</ul></div>`;
}

function renderVigilSection(vigil: VigilSummary | undefined): string {
	if (!vigil || vigil.severity === 0) return "";

	const severityClass = vigil.severity === 3 ? "vigil-alert" : "vigil-caution";
	const icons = "\u26A0".repeat(vigil.severity);

	const flagLines = vigil.flags
		.slice(0, 4)
		.map((f) => {
			const sign = f.zScore > 0 ? "+" : "";
			const weightNote =
				f.weight < 1.0
					? ` <span class="vigil-weight">* weighted ${f.weight} \u2014 raw z = ${sign}${f.zScore.toFixed(1)}\u03C3</span>`
					: "";
			const displayZ = f.zScore * f.weight;
			const displaySign = displayZ > 0 ? "+" : "";
			return `<span class="vigil-flag">${escapeHtml(f.metric)} ${displaySign}${displayZ.toFixed(1)}\u03C3${weightNote}</span>`;
		})
		.join(", ");

	const details =
		vigil.severity >= 2
			? `<div class="vigil-detail">${escapeHtml(vigil.recommendation)}</div>`
			: "";

	return `
		<div class="vigil-section ${severityClass}">
			<div class="vigil-header">${icons} ${escapeHtml(vigil.summary)}</div>
			<div class="vigil-flags">${flagLines}</div>
			${details}
		</div>`;
}

function renderCard(
	suggestion: WorkoutSuggestion,
	invocations: Invocations,
	sportClass: string,
	accent: string,
	hrZones: number[] | null,
	showStryd = false,
): string {
	const ftp = suggestion.power_context.ftp;
	const sport = suggestion.sport;
	const segments = suggestion.segments
		.map((s) => renderSegment(s, accent, sport, ftp, hrZones))
		.join("");

	const sportTag = suggestion.sport === "Run" ? "CURSUS" : "NATATIO";
	const sportEndpoint = suggestion.sport.toLowerCase();

	return `
	<div class="card ${sportClass}" style="--card-accent: ${accent}">
		<div class="card-accent"></div>
		<div class="card-body">
			<div class="card-header">
				<div class="card-header-top">
					<span class="sport-tag">${sportTag}</span>
					<div class="readiness-block">
						<div class="readiness-score">${suggestion.readiness_score}</div>
						<div class="readiness-label">readiness</div>
					</div>
				</div>
				<h2 class="card-title">${escapeHtml(suggestion.title)}</h2>
				<div class="card-meta">
					<span class="meta-pill">${escapeHtml(suggestion.category)}</span>
					<span class="meta-pill">${formatDuration(suggestion.total_duration_secs)}</span>
					<span class="meta-pill">~${suggestion.estimated_load} load</span>
				</div>
			</div>

			<blockquote class="invocation" style="border-left-color: ${accent}">
				<p>${escapeHtml(invocations.opening)}</p>
			</blockquote>

			${renderWarnings(suggestion.warnings)}

			${renderVigilSection(suggestion.vigil)}

			<div class="segments">
				${segments}
			</div>

			<div class="terrain-block">
				<span class="terrain-label">Terrain</span>
				<span class="terrain-value">${escapeHtml(suggestion.terrain)}</span>
				<span class="terrain-rationale">${escapeHtml(suggestion.terrain_rationale)}</span>
			</div>

			<div class="rationale-section">
				<h3 class="rationale-header">${escapeHtml(invocations.rationale_header)}</h3>
				<p class="rationale-text">${escapeHtml(suggestion.rationale)}</p>
				<p class="rationale-text sport-reason">${escapeHtml(suggestion.sport_selection_reason)}</p>
			</div>

			<blockquote class="closing" style="border-left-color: ${accent}">
				<p>${escapeHtml(invocations.closing)}</p>
			</blockquote>

			<div class="send-buttons">
				<button class="send-btn" data-sport="${sportEndpoint}" style="--btn-accent: ${accent}">
					&#x2197; Send to intervals.icu
				</button>
				${showStryd ? `<button class="send-btn stryd-btn" data-sport="${sportEndpoint}" style="--btn-accent: #5a3eb8">&#x2197; Send to Stryd</button>` : ""}
			</div>
		</div>
	</div>`;
}

function renderVigilDataSource(vigil: VigilSummary | null): string {
	if (!vigil) return "";

	const cssClass = vigil.severity >= 2 ? "ds-vigil-warn" : "ds-vigil";

	if (vigil.status === "inactive") {
		return `<span class="${cssClass}">Vigil: no Stryd data</span>`;
	}
	if (vigil.status === "building") {
		return `<span class="${cssClass}">${escapeHtml(vigil.summary)}</span>`;
	}
	const actMatch = vigil.baselineWindow.match(/\((\d+)/);
	const runCount = actMatch ? `, ${actMatch[1]} runs` : "";

	if (vigil.severity === 0) {
		return `<span class="${cssClass}">Vigil: clear${runCount}</span>`;
	}

	const flagCount = vigil.flags.length;
	return `<span class="${cssClass}">Vigil: ${flagCount} flag${flagCount !== 1 ? "s" : ""} (sev ${vigil.severity})${runCount}</span>`;
}

function renderDataSource(ds: DataSource, generatedAt: string): string {
	const time = generatedAt.slice(11, 16);

	const actRange = ds.activityRange
		? `${ds.activityRange[0]} \u2013 ${ds.activityRange[1]}`
		: "none";
	const wellRange = ds.wellnessRange
		? `${ds.wellnessRange[0]} \u2013 ${ds.wellnessRange[1]}`
		: "none";

	const strydParts: string[] = [];
	if (ds.strydCp) strydParts.push(`CP ${Math.round(ds.strydCp)}W`);
	if (ds.strydEnriched > 0) strydParts.push(`${ds.strydEnriched} enriched`);
	const strydNote =
		strydParts.length > 0 ? `<span class="ds-enriched">Stryd: ${strydParts.join(", ")}</span>` : "";

	const vigilNote = renderVigilDataSource(ds.vigil);

	return `
	<div class="data-source">
		<span class="ds-item"><span class="ds-label">Activities</span> ${ds.activityCount} (${actRange})</span>
		<span class="ds-sep">&middot;</span>
		<span class="ds-item"><span class="ds-label">Wellness</span> ${ds.wellnessCount}d (${wellRange})</span>
		${strydNote ? `<span class="ds-sep">&middot;</span>${strydNote}` : ""}
		${vigilNote ? `<span class="ds-sep">&middot;</span>${vigilNote}` : ""}
		<span class="ds-sep">&middot;</span>
		<span class="ds-item"><span class="ds-label">Generated</span> ${time}</span>
	</div>`;
}

export function renderPage(data: RenderData): string {
	const dateStr = data.generatedAt.slice(0, 10);
	const day = dayName(data.generatedAt);
	const runAccent = "#3a7a4a";
	const swimAccent = "#1e5a7e";
	const { profile } = data;
	const singleCard = (data.run ? 1 : 0) + (data.swim ? 1 : 0) === 1;

	const dataSourceBlock = renderDataSource(data.dataSource, data.generatedAt);
	const showStryd = profile.stryd;
	const runCard =
		data.run && data.runInvocations
			? renderCard(data.run, data.runInvocations, "card-run", runAccent, data.runHrZones, showStryd)
			: "";
	const swimCard =
		data.swim && data.swimInvocations
			? renderCard(data.swim, data.swimInvocations, "card-swim", swimAccent, data.swimHrZones)
			: "";

	const titleSuffix = profile.id === "ze" ? "" : ` &middot; ${escapeHtml(profile.displayName)}`;
	const cardsClass = singleCard ? "cards cards-single" : "cards";

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Praescriptor${titleSuffix ? ` \u00b7 ${profile.displayName}` : ""} &middot; ${dateStr}</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
	<style>${CSS}</style>
</head>
<body>
	<header class="page-header">
		<h1>PR\u00C6SCRIPTOR${titleSuffix}</h1>
		<div class="header-row">
			<span class="header-date">${dateStr} &middot; ${day}</span>
			<button class="refresh-btn" id="refresh-btn" title="Regenerate prescriptions">&#x21bb;</button>
		</div>
	</header>

	${dataSourceBlock}

	<main class="${cardsClass}">
		${runCard}
		${swimCard}
	</main>

	<footer class="page-footer">
		<span class="diamond">&loz;</span>
	</footer>

	<script>${clientJs(profile.id)}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Inlined CSS
// ---------------------------------------------------------------------------

const CSS = `
:root {
	--bg: #f4efe6;
	--surface: #fffcf7;
	--border: #ddd5c5;
	--gold: #c48c28;
	--gold-dim: #9a6e20;
	--gold-glow: rgba(196, 140, 40, 0.08);
	--silver: #7e8680;
	--text: #302820;
	--text-dim: #7a6e5e;
	--z2: #3a7a4a;
	--z2-glow: rgba(58, 122, 74, 0.15);
	--swim: #1e5a7e;
	--swim-glow: rgba(30, 90, 126, 0.15);
	--warn: #c44e22;
	--font-display: 'Cormorant Garamond', serif;
	--font-mono: 'JetBrains Mono', monospace;
	--shadow-sm: 0 1px 3px rgba(48, 40, 32, 0.06);
	--shadow-md: 0 4px 12px rgba(48, 40, 32, 0.08);
	--radius: 10px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
	background: var(--bg);
	color: var(--text);
	font-family: var(--font-mono);
	font-size: 13px;
	line-height: 1.65;
	min-height: 100vh;
	-webkit-font-smoothing: antialiased;
}

/* --- Header --- */

.page-header {
	text-align: center;
	padding: 2.5rem 1rem 1.2rem;
}

.page-header h1 {
	font-family: var(--font-display);
	font-weight: 600;
	font-size: 2rem;
	letter-spacing: 0.25em;
	color: var(--gold);
}

.header-row {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.6rem;
	margin-top: 0.3rem;
}

.header-date {
	font-size: 0.82rem;
	color: var(--text-dim);
	letter-spacing: 0.04em;
}

.refresh-btn {
	background: transparent;
	border: 1px solid var(--border);
	border-radius: 6px;
	color: var(--text-dim);
	font-size: 1rem;
	cursor: pointer;
	padding: 0.2rem 0.45rem;
	line-height: 1;
	transition: all 0.25s ease;
}

.refresh-btn:hover {
	border-color: var(--gold-dim);
	color: var(--gold);
	box-shadow: var(--shadow-sm);
}

.refresh-btn:disabled {
	cursor: not-allowed;
	opacity: 0.5;
}

.refresh-btn.spinning {
	animation: spin 0.8s linear infinite;
}

@keyframes spin {
	from { transform: rotate(0deg); }
	to { transform: rotate(360deg); }
}

/* --- Data source bar --- */

.data-source {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	align-items: baseline;
	gap: 0.25rem 0.5rem;
	max-width: 1400px;
	margin: 0 auto;
	padding: 0.6rem 1.5rem;
	font-size: 0.7rem;
	color: var(--text-dim);
	border-bottom: 1px solid var(--border);
}

.ds-label {
	color: var(--silver);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	font-size: 0.62rem;
	margin-right: 0.2rem;
}

.ds-sep { color: var(--border); }

.ds-enriched { color: var(--gold-dim); }

.ds-vigil { color: var(--text-dim); }
.ds-vigil-warn { color: var(--warn); }

/* --- Card grid --- */

.cards {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 1.8rem;
	max-width: 1400px;
	margin: 2.5rem auto;
	padding: 0 1.5rem;
	align-items: start;
}

.cards-single {
	grid-template-columns: 1fr;
	max-width: 680px;
}

/* --- Card --- */

.card {
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	overflow: hidden;
	box-shadow: var(--shadow-md);
	transition: box-shadow 0.3s ease;
}

.card:hover {
	box-shadow: 0 6px 20px rgba(48, 40, 32, 0.1);
}

.card-accent {
	height: 4px;
	background: var(--card-accent);
}

.card-body {
	padding: 1.6rem 1.5rem 1.4rem;
}

.card-header { margin-bottom: 1.4rem; }

.card-header-top {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
}

.sport-tag {
	font-family: var(--font-display);
	font-size: 0.7rem;
	font-weight: 600;
	letter-spacing: 0.15em;
	text-transform: uppercase;
	color: var(--surface);
	background: var(--card-accent);
	padding: 3px 10px;
	border-radius: 4px;
}

.card-title {
	font-family: var(--font-display);
	font-weight: 600;
	font-size: 1.5rem;
	color: var(--text);
	margin-top: 0.7rem;
	line-height: 1.25;
}

.card-meta {
	display: flex;
	gap: 0.4rem;
	margin-top: 0.6rem;
	flex-wrap: wrap;
}

.meta-pill {
	font-size: 0.72rem;
	color: var(--text-dim);
	background: var(--bg);
	padding: 2px 8px;
	border-radius: 12px;
	text-transform: capitalize;
	border: 1px solid var(--border);
}

/* --- Readiness --- */

.readiness-block {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
}

.readiness-score {
	font-family: var(--font-display);
	font-size: 2.4rem;
	font-weight: 600;
	line-height: 1;
	color: var(--card-accent);
}

.readiness-label {
	font-size: 0.65rem;
	color: var(--text-dim);
	text-transform: uppercase;
	letter-spacing: 0.1em;
	margin-top: 0.15rem;
}

/* --- Invocations --- */

.invocation, .closing {
	font-family: var(--font-display);
	font-style: italic;
	font-size: 1rem;
	color: var(--gold);
	border-left: 3px solid;
	padding: 0.7rem 1rem;
	margin: 1.2rem 0;
	background: var(--gold-glow);
	border-radius: 0 6px 6px 0;
	line-height: 1.5;
}

/* --- Warnings --- */

.warnings {
	background: rgba(196, 78, 34, 0.06);
	border: 1px solid rgba(196, 78, 34, 0.2);
	border-radius: 6px;
	padding: 0.6rem 1rem;
	margin: 1rem 0;
}

.warnings ul { list-style: none; }

.warnings li {
	font-size: 0.78rem;
	color: var(--warn);
	padding: 0.15rem 0;
}

.warnings li::before {
	content: "\\26A0  ";
}

/* --- Vigil --- */

.vigil-section {
	border-radius: 6px;
	padding: 0.6rem 1rem;
	margin: 1rem 0;
}

.vigil-caution {
	background: rgba(196, 78, 34, 0.06);
	border: 1px solid rgba(196, 78, 34, 0.2);
}

.vigil-alert {
	background: rgba(168, 48, 48, 0.08);
	border: 1px solid rgba(168, 48, 48, 0.25);
}

.vigil-header {
	font-size: 0.82rem;
	font-weight: 500;
	margin-bottom: 0.3rem;
}

.vigil-caution .vigil-header { color: var(--warn); }
.vigil-alert .vigil-header { color: #a83030; }

.vigil-flags {
	font-size: 0.75rem;
	color: var(--text-dim);
}

.vigil-flag { white-space: nowrap; }

.vigil-weight {
	font-size: 0.68rem;
	color: var(--text-dim);
	opacity: 0.7;
}

.vigil-detail {
	font-size: 0.78rem;
	color: var(--text-dim);
	margin-top: 0.3rem;
	font-style: italic;
}

/* --- Segments --- */

.segments {
	margin: 1.4rem 0;
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

.segment {
	background: rgba(255, 255, 255, 0.55);
	border: 1px solid var(--border);
	border-left: 3px solid var(--card-accent);
	border-radius: 2px 6px 6px 2px;
	padding: 0.6rem 0.9rem;
	transition: background 0.2s ease;
}

.segment:hover {
	background: rgba(255, 255, 255, 0.75);
}

.segment-header {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
}

.segment-name {
	font-weight: 500;
	font-size: 0.82rem;
}

.segment-duration {
	font-size: 0.78rem;
	font-weight: 500;
	color: var(--card-accent);
}

.segment-target {
	font-size: 0.75rem;
	color: var(--text-dim);
	margin-top: 0.15rem;
}

.segment-repeats {
	color: var(--gold-dim);
	margin-right: 0.3rem;
	font-weight: 500;
}

.zone-guide {
	color: var(--gold-dim);
	font-size: 0.72rem;
	white-space: nowrap;
}

/* --- Terrain --- */

.terrain-block {
	font-size: 0.78rem;
	color: var(--text-dim);
	margin: 1.2rem 0 0.8rem;
	padding: 0.6rem 0;
	border-top: 1px solid var(--border);
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 0.3rem;
}

.terrain-label {
	font-size: 0.65rem;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--silver);
}

.terrain-value {
	color: var(--text);
	text-transform: capitalize;
	font-weight: 500;
}

.terrain-rationale { font-style: italic; }

/* --- Rationale --- */

.rationale-section { margin: 0.8rem 0 1rem; }

.rationale-header {
	font-family: var(--font-display);
	font-weight: 600;
	font-size: 0.9rem;
	color: var(--silver);
	letter-spacing: 0.05em;
	margin-bottom: 0.4rem;
}

.rationale-text {
	font-size: 0.78rem;
	color: var(--text-dim);
	margin-bottom: 0.3rem;
}

.sport-reason { font-style: italic; }

/* --- Send buttons --- */

.send-buttons {
	display: flex;
	gap: 0.5rem;
	margin-top: 1.4rem;
	padding-top: 1rem;
	border-top: 1px solid var(--border);
}

.send-btn {
	display: block;
	flex: 1;
	padding: 0.65rem 0.8rem;
	background: transparent;
	border: 1.5px solid var(--btn-accent, var(--border));
	border-radius: 6px;
	color: var(--btn-accent, var(--text-dim));
	font-family: var(--font-mono);
	font-size: 0.78rem;
	cursor: pointer;
	transition: all 0.25s ease;
}

.send-btn:hover {
	background: var(--btn-accent);
	color: var(--surface);
	box-shadow: var(--shadow-sm);
}

.send-btn:disabled {
	cursor: not-allowed;
	opacity: 0.5;
}

.send-btn.sent {
	background: var(--btn-accent);
	border-color: var(--btn-accent);
	color: var(--surface);
}

.send-btn.error {
	border-color: var(--warn);
	color: var(--warn);
	background: rgba(196, 78, 34, 0.06);
}

/* --- Footer --- */

.page-footer {
	text-align: center;
	padding: 2.5rem;
	color: var(--border);
}

.diamond { font-size: 1rem; }

/* --- Responsive --- */

@media (max-width: 960px) {
	.cards {
		grid-template-columns: 1fr;
		max-width: 680px;
		gap: 1.5rem;
	}
}

@media (max-width: 520px) {
	.page-header { padding: 1.8rem 1rem 1rem; }
	.page-header h1 { font-size: 1.4rem; letter-spacing: 0.15em; }
	.card-body { padding: 1.2rem 1rem 1rem; }
	.card-title { font-size: 1.2rem; }
	.readiness-score { font-size: 2rem; }
	.cards { padding: 0 1rem; margin: 1.5rem auto; }
	.send-buttons { flex-direction: column; }
}
`;

// ---------------------------------------------------------------------------
// Inlined client JS for send button (user-prefixed API paths)
// ---------------------------------------------------------------------------

function clientJs(userId: string): string {
	const prefix = `/${userId}`;
	return `
document.getElementById('refresh-btn')?.addEventListener('click', async function() {
	this.disabled = true;
	this.classList.add('spinning');
	try {
		const res = await fetch('${prefix}/api/refresh', { method: 'POST' });
		if (res.ok) {
			window.location.reload();
			return;
		}
		this.classList.remove('spinning');
		this.disabled = false;
	} catch {
		this.classList.remove('spinning');
		this.disabled = false;
	}
});

document.querySelectorAll('.send-btn:not(.stryd-btn)').forEach(btn => {
	btn.addEventListener('click', async function() {
		const sport = this.dataset.sport;
		const isSent = this.classList.contains('sent');

		if (isSent) {
			if (!confirm('Already sent today \\u2014 send again?')) return;
		}

		this.disabled = true;
		this.textContent = 'Sending\\u2026';

		try {
			const forceParam = isSent ? '?force=true' : '';
			const res = await fetch('${prefix}/api/send/' + sport + forceParam, { method: 'POST' });
			const data = await res.json();

			if (data.duplicate) {
				this.disabled = false;
				if (confirm(data.message)) {
					const retry = await fetch('${prefix}/api/send/' + sport + '?force=true', { method: 'POST' });
					const retryData = await retry.json();
					if (retryData.success) {
						this.textContent = '\\u2713 Sent to calendar';
						this.classList.add('sent');
						this.classList.remove('error');
					} else {
						throw new Error(retryData.error);
					}
				} else {
					this.textContent = '\\u2713 Sent to calendar';
					this.classList.add('sent');
				}
				this.disabled = false;
				return;
			}

			if (data.success) {
				this.textContent = '\\u2713 Sent to calendar';
				this.classList.add('sent');
				this.classList.remove('error');
			} else {
				throw new Error(data.error);
			}
		} catch (err) {
			this.textContent = '\\u2717 Failed \\u2014 try again';
			this.classList.add('error');
			this.classList.remove('sent');
			setTimeout(() => {
				this.textContent = '\\u2197 Send to intervals.icu';
				this.classList.remove('error');
			}, 5000);
		}

		this.disabled = false;
	});
});

document.querySelectorAll('.stryd-btn').forEach(btn => {
	btn.addEventListener('click', async function() {
		const sport = this.dataset.sport;
		const isSent = this.classList.contains('sent');

		if (isSent) {
			if (!confirm('Already sent to Stryd today \\u2014 send again?')) return;
		}

		this.disabled = true;
		this.textContent = 'Sending\\u2026';

		try {
			const forceParam = isSent ? '?force=true' : '';
			const res = await fetch('${prefix}/api/stryd/' + sport + forceParam, { method: 'POST' });
			const data = await res.json();

			if (data.duplicate) {
				this.disabled = false;
				if (confirm(data.message)) {
					const retry = await fetch('${prefix}/api/stryd/' + sport + '?force=true', { method: 'POST' });
					const retryData = await retry.json();
					if (retryData.success) {
						this.textContent = '\\u2713 Sent to Stryd';
						this.classList.add('sent');
						this.classList.remove('error');
					} else {
						throw new Error(retryData.error);
					}
				} else {
					this.textContent = '\\u2713 Sent to Stryd';
					this.classList.add('sent');
				}
				this.disabled = false;
				return;
			}

			if (data.success) {
				this.textContent = '\\u2713 Sent to Stryd';
				this.classList.add('sent');
				this.classList.remove('error');
			} else {
				throw new Error(data.error);
			}
		} catch (err) {
			this.textContent = '\\u2717 Failed \\u2014 try again';
			this.classList.add('error');
			this.classList.remove('sent');
			setTimeout(() => {
				this.textContent = '\\u2197 Send to Stryd';
				this.classList.remove('error');
			}, 5000);
		}

		this.disabled = false;
	});
});
`;
}
