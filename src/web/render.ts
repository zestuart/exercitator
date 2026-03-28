/**
 * Server-side HTML renderer for the Praescriptor web UI.
 * Produces a self-contained page with inlined CSS and JS.
 */

import type { VigilSummary, WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";
import type { Invocations } from "./invocations.js";
import type { DataSource } from "./prescriptions.js";

export interface RenderData {
	run: WorkoutSuggestion;
	swim: WorkoutSuggestion;
	runInvocations: Invocations;
	swimInvocations: Invocations;
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
				<span class="segment-duration" style="color: ${accent}">${dur}</span>
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
): string {
	const ftp = suggestion.power_context.ftp;
	const sport = suggestion.sport;
	const segments = suggestion.segments
		.map((s) => renderSegment(s, accent, sport, ftp, hrZones))
		.join("");

	const sportTag = suggestion.sport === "Run" ? "CURSUS" : "NATATIO";
	const sportEndpoint = suggestion.sport.toLowerCase();

	return `
	<div class="card ${sportClass}">
		<div class="card-header">
			<span class="sport-tag" style="border-color: ${accent}; color: ${accent}">${sportTag}</span>
			<h2 class="card-title">${escapeHtml(suggestion.title)}</h2>
			<p class="card-subtitle">${escapeHtml(suggestion.category)} &middot; ${formatDuration(suggestion.total_duration_secs)} &middot; ~${suggestion.estimated_load} load</p>
		</div>

		<blockquote class="invocation" style="border-left-color: ${accent}">
			<p>${escapeHtml(invocations.opening)}</p>
		</blockquote>

		<div class="readiness-block">
			<div class="readiness-score" style="color: ${accent}">${suggestion.readiness_score}</div>
			<div class="readiness-label">readiness</div>
		</div>

		${renderWarnings(suggestion.warnings)}

		${renderVigilSection(suggestion.vigil)}

		<div class="segments">
			${segments}
		</div>

		<div class="terrain-block">
			<span class="terrain-label">Terrain:</span>
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

		<button class="send-btn" data-sport="${sportEndpoint}" style="--btn-accent: ${accent}">
			&#x2197; Send to intervals.icu
		</button>
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
	if (vigil.severity === 0) {
		return `<span class="${cssClass}">Vigil: clear</span>`;
	}

	const flagCount = vigil.flags.length;
	return `<span class="${cssClass}">Vigil: ${flagCount} flag${flagCount !== 1 ? "s" : ""} (sev ${vigil.severity})</span>`;
}

function renderDataSource(ds: DataSource, generatedAt: string): string {
	const time = generatedAt.slice(11, 16);

	const deviceParts = Object.entries(ds.activityDevices)
		.sort((a, b) => b[1] - a[1])
		.map(([name, count]) => `${escapeHtml(name)} (${count})`)
		.join(", ");

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
		<span class="ds-item"><span class="ds-label">Devices</span> ${deviceParts}</span>
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
	const runAccent = "#2d8a4e";
	const swimAccent = "#2d6e8a";

	const dataSourceBlock = renderDataSource(data.dataSource, data.generatedAt);
	const runCard = renderCard(data.run, data.runInvocations, "card-run", runAccent, data.runHrZones);
	const swimCard = renderCard(
		data.swim,
		data.swimInvocations,
		"card-swim",
		swimAccent,
		data.swimHrZones,
	);

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Praescriptor &middot; ${dateStr}</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
	<style>${CSS}</style>
</head>
<body>
	<header class="page-header">
		<h1>PR\u00C6SCRIPTOR</h1>
		<div class="header-row">
			<span class="header-date">${dateStr} &middot; ${day}</span>
			<button class="refresh-btn" id="refresh-btn" title="Regenerate prescriptions">&#x21bb;</button>
		</div>
	</header>

	${dataSourceBlock}

	<main class="cards">
		${runCard}
		${swimCard}
	</main>

	<footer class="page-footer">
		<span class="diamond">&loz;</span>
	</footer>

	<script>${CLIENT_JS}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Inlined CSS
// ---------------------------------------------------------------------------

const CSS = `
:root {
	--bg: #0a0a0c;
	--surface: #111114;
	--border: #1e1e24;
	--gold: #c9a84c;
	--gold-dim: #8a7234;
	--gold-glow: rgba(201, 168, 76, 0.12);
	--silver: #a8a8b0;
	--text: #d4d4d8;
	--text-dim: #71717a;
	--z2: #2d8a4e;
	--z2-glow: rgba(45, 138, 78, 0.15);
	--swim: #2d6e8a;
	--swim-glow: rgba(45, 110, 138, 0.15);
	--warn: #b45309;
	--font-display: 'Cormorant Garamond', serif;
	--font-mono: 'JetBrains Mono', monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
	background: var(--bg);
	color: var(--text);
	font-family: var(--font-mono);
	font-size: 14px;
	line-height: 1.6;
	min-height: 100vh;
}

.page-header {
	text-align: center;
	padding: 2rem 1rem 1rem;
	border-bottom: 1px solid var(--border);
}

.page-header h1 {
	font-family: var(--font-display);
	font-weight: 600;
	font-size: 1.8rem;
	letter-spacing: 0.2em;
	color: var(--gold);
}

.header-row {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.6rem;
}

.header-date {
	font-size: 0.85rem;
	color: var(--text-dim);
	letter-spacing: 0.05em;
}

.refresh-btn {
	background: transparent;
	border: 1px solid var(--border);
	border-radius: 4px;
	color: var(--text-dim);
	font-size: 1rem;
	cursor: pointer;
	padding: 0.15rem 0.4rem;
	line-height: 1;
	transition: all 0.2s;
}

.refresh-btn:hover {
	border-color: var(--gold-dim);
	color: var(--gold);
}

.refresh-btn:disabled {
	cursor: not-allowed;
	opacity: 0.6;
}

.refresh-btn.spinning {
	animation: spin 0.8s linear infinite;
}

@keyframes spin {
	from { transform: rotate(0deg); }
	to { transform: rotate(360deg); }
}

.data-source {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	align-items: baseline;
	gap: 0.3rem 0.5rem;
	max-width: 1400px;
	margin: 0.8rem auto 0;
	padding: 0 1.5rem;
	font-size: 0.72rem;
	color: var(--text-dim);
}

.ds-label {
	color: var(--silver);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	font-size: 0.65rem;
	margin-right: 0.25rem;
}

.ds-sep { color: var(--border); }

.ds-enriched { color: var(--gold-dim); }

.ds-vigil { color: var(--text-dim); }
.ds-vigil-warn { color: var(--warn); }

.cards {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 1.5rem;
	max-width: 1400px;
	margin: 2rem auto;
	padding: 0 1.5rem;
}

.card {
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 1.5rem;
}

.card-run { border-top: 2px solid var(--z2); }
.card-swim { border-top: 2px solid var(--swim); }

.card-header { margin-bottom: 1.2rem; }

.sport-tag {
	font-family: var(--font-display);
	font-size: 0.75rem;
	font-weight: 600;
	letter-spacing: 0.15em;
	text-transform: uppercase;
	border: 1px solid;
	padding: 2px 8px;
	border-radius: 3px;
}

.card-title {
	font-family: var(--font-display);
	font-weight: 600;
	font-size: 1.4rem;
	color: var(--text);
	margin-top: 0.5rem;
}

.card-subtitle {
	font-size: 0.8rem;
	color: var(--text-dim);
	text-transform: capitalize;
}

.invocation, .closing {
	font-family: var(--font-display);
	font-style: italic;
	font-size: 0.95rem;
	color: var(--gold);
	border-left: 3px solid;
	padding: 0.8rem 1rem;
	margin: 1rem 0;
	background: var(--gold-glow);
	border-radius: 0 4px 4px 0;
}

.readiness-block {
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
	margin: 1rem 0;
}

.readiness-score {
	font-family: var(--font-display);
	font-size: 2.2rem;
	font-weight: 600;
}

.readiness-label {
	font-size: 0.75rem;
	color: var(--text-dim);
	text-transform: uppercase;
	letter-spacing: 0.1em;
}

.warnings {
	background: rgba(180, 83, 9, 0.1);
	border: 1px solid rgba(180, 83, 9, 0.3);
	border-radius: 4px;
	padding: 0.6rem 1rem;
	margin: 0.8rem 0;
}

.warnings ul { list-style: none; }

.warnings li {
	font-size: 0.8rem;
	color: var(--warn);
	padding: 0.15rem 0;
}

.warnings li::before {
	content: "\\26A0  ";
}

.vigil-section {
	border-radius: 4px;
	padding: 0.6rem 1rem;
	margin: 0.8rem 0;
}

.vigil-caution {
	background: rgba(180, 83, 9, 0.1);
	border: 1px solid rgba(180, 83, 9, 0.3);
}

.vigil-alert {
	background: rgba(180, 40, 40, 0.12);
	border: 1px solid rgba(180, 40, 40, 0.4);
}

.vigil-header {
	font-size: 0.82rem;
	font-weight: 500;
	margin-bottom: 0.3rem;
}

.vigil-caution .vigil-header { color: var(--warn); }
.vigil-alert .vigil-header { color: #c04040; }

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

.segments {
	margin: 1.2rem 0;
	display: flex;
	flex-direction: column;
	gap: 0.6rem;
}

.segment {
	background: rgba(255, 255, 255, 0.02);
	border: 1px solid var(--border);
	border-radius: 4px;
	padding: 0.6rem 0.8rem;
}

.segment-header {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
}

.segment-name {
	font-weight: 500;
	font-size: 0.85rem;
}

.segment-duration {
	font-size: 0.8rem;
	font-weight: 500;
}

.segment-target {
	font-size: 0.78rem;
	color: var(--text-dim);
	margin-top: 0.2rem;
}

.segment-repeats {
	color: var(--gold-dim);
	margin-right: 0.3rem;
}

.zone-guide {
	color: var(--gold-dim);
	font-size: 0.75rem;
	white-space: nowrap;
}

.terrain-block {
	font-size: 0.8rem;
	color: var(--text-dim);
	margin: 0.8rem 0;
	padding: 0.5rem 0;
	border-top: 1px solid var(--border);
}

.terrain-value {
	color: var(--text);
	text-transform: capitalize;
	margin: 0 0.3rem;
}

.terrain-rationale { font-style: italic; }

.rationale-section { margin: 1rem 0; }

.rationale-header {
	font-family: var(--font-display);
	font-weight: 600;
	font-size: 0.9rem;
	color: var(--silver);
	letter-spacing: 0.05em;
	margin-bottom: 0.4rem;
}

.rationale-text {
	font-size: 0.82rem;
	color: var(--text-dim);
	margin-bottom: 0.3rem;
}

.sport-reason { font-style: italic; }

.send-btn {
	display: block;
	width: 100%;
	margin-top: 1.2rem;
	padding: 0.7rem;
	background: transparent;
	border: 1px solid var(--border);
	border-radius: 4px;
	color: var(--text-dim);
	font-family: var(--font-mono);
	font-size: 0.85rem;
	cursor: pointer;
	transition: all 0.2s;
}

.send-btn:hover {
	border-color: var(--gold-dim);
	color: var(--gold);
}

.send-btn:disabled {
	cursor: not-allowed;
	opacity: 0.6;
}

.send-btn.sent {
	border-color: var(--btn-accent);
	color: var(--btn-accent);
}

.send-btn.error {
	border-color: var(--warn);
	color: var(--warn);
}

.page-footer {
	text-align: center;
	padding: 2rem;
	color: var(--text-dim);
}

.diamond { font-size: 1.2rem; }

@media (max-width: 960px) {
	.cards { grid-template-columns: 1fr; }
}

@media (max-width: 520px) {
	.page-header h1 { font-size: 1.3rem; }
	.card { padding: 1rem; }
	.card-title { font-size: 1.1rem; }
}
`;

// ---------------------------------------------------------------------------
// Inlined client JS for send button
// ---------------------------------------------------------------------------

const CLIENT_JS = `
document.getElementById('refresh-btn')?.addEventListener('click', async function() {
	this.disabled = true;
	this.classList.add('spinning');
	try {
		const res = await fetch('/api/refresh', { method: 'POST' });
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

document.querySelectorAll('.send-btn').forEach(btn => {
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
			const res = await fetch('/api/send/' + sport + forceParam, { method: 'POST' });
			const data = await res.json();

			if (data.duplicate) {
				this.disabled = false;
				if (confirm(data.message)) {
					const retry = await fetch('/api/send/' + sport + '?force=true', { method: 'POST' });
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
`;
