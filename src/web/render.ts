/**
 * Server-side HTML renderer for the Praescriptor web UI.
 * Produces a self-contained page with inlined CSS and JS.
 */

import type { ComplianceView, SegmentCompliance } from "../compliance/types.js";
import type { VigilSummary, WorkoutSegment, WorkoutSuggestion } from "../engine/types.js";
import type { UserProfile } from "../users.js";
import { buildFormDescription } from "./form-format.js";
import type { Invocations } from "./invocations.js";
import type { DataSource } from "./prescriptions.js";

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
	/** IANA timezone for display formatting (e.g. "America/Los_Angeles"). */
	tz?: string;
	/** Yesterday's compliance data for the confirmation/traffic light UI. */
	runCompliance?: ComplianceView | null;
	swimCompliance?: ComplianceView | null;
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

function dayName(dateStr: string, tz?: string): string {
	const d = new Date(dateStr);
	return d.toLocaleDateString("en-GB", { weekday: "long", timeZone: tz });
}

function formatLocalTime(isoStr: string, tz?: string): string {
	const d = new Date(isoStr);
	return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

/**
 * Build a zone guide string for a segment.
 *
 * Running (with power): "Z2 (161–219W)"
 * Running (no power):   "Z2"
 * Swimming (with HR):   "Z2 (137–145bpm)"
 * Swimming (no HR):     "Z2"
 */
/**
 * Stryd 5-zone CP percentage bands. Mirrors src/web/stryd-format.ts \u2014
 * keep the two in sync if either changes.
 */
const STRYD_ZONE_PCT: Record<number, [number, number]> = {
	1: [65, 80],
	2: [80, 90],
	3: [90, 100],
	4: [100, 115],
	5: [115, 130],
};

const STRYD_ZONE_LABEL: Record<number, string> = {
	1: "Stryd Z1 Easy",
	2: "Stryd Z2 Moderate",
	3: "Stryd Z3 Threshold",
	4: "Stryd Z4 Interval",
	5: "Stryd Z5 Repetition",
};

function zoneGuide(
	seg: WorkoutSegment,
	sport: "Run" | "Swim",
	ftp: number,
	hrZones: number[] | null,
): string {
	// Run with explicit Stryd zone \u2014 derive watts from Stryd's published
	// 5-zone percentage bands (keeps the on-page guide aligned with the
	// engine's actual prescription).
	if (sport === "Run" && ftp > 0 && seg.stryd_zone != null) {
		const pcts = STRYD_ZONE_PCT[seg.stryd_zone];
		const label = STRYD_ZONE_LABEL[seg.stryd_zone] ?? `Stryd Z${seg.stryd_zone}`;
		if (pcts) {
			const lo = Math.round((ftp * pcts[0]) / 100);
			const hi = Math.round((ftp * pcts[1]) / 100);
			return `${label} (${lo}\u2013${hi}W)`;
		}
		return label;
	}

	if (seg.target_hr_zone == null) return "";
	const z = seg.target_hr_zone;
	const label = `Z${z}`;

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
	segIndex?: number,
	complianceSegments?: SegmentCompliance[],
): string {
	const dur = formatDuration(seg.duration_secs);
	const repeatInfo =
		seg.repeats && seg.repeats > 1
			? `<span class="segment-repeats">${seg.repeats}&times;</span>`
			: "";
	const guide = zoneGuide(seg, sport, ftp, hrZones);

	// Traffic light dot (only when compliance data exists for this segment)
	let complianceDot = "";
	if (complianceSegments && segIndex != null) {
		const matching = complianceSegments.filter((s) => s.segmentIndex === segIndex);
		if (matching.length > 0) {
			// For repeat segments, show worst-case light
			const lights = matching.map((m) => m.light);
			const light = lights.includes("red") ? "red" : lights.includes("amber") ? "amber" : "green";
			const title = matching
				.map((m) => {
					const parts: string[] = [];
					if (m.hrZonePass === false) parts.push(`HR Z${m.hrZoneActual ?? "?"}`);
					if (m.powerPass === false) parts.push(`Power ${m.powerDeviationPct?.toFixed(0) ?? "?"}%`);
					if (m.pacePass === false) parts.push("Pace");
					if (m.durationPass === false) parts.push("Duration");
					return parts.length > 0 ? parts.join(", ") : "OK";
				})
				.join(" | ");
			complianceDot = `<span class="compliance-dot compliance-${light}" title="${escapeHtml(title)}"></span>`;
		}
	}

	return `
		<div class="segment">
			<div class="segment-header">
				<span class="segment-name">${escapeHtml(seg.name)}</span>
				<span class="segment-duration">${dur}${complianceDot}</span>
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

function renderComplianceSection(
	compliance: ComplianceView | null | undefined,
	sport: string,
	sportEndpoint: string,
): string {
	if (!compliance) return "";

	// Case 1: Assessment already done — show summary
	if (compliance.assessment) {
		const a = compliance.assessment;
		if (a.status === "skipped") {
			return `
			<div class="compliance-section">
				<div class="compliance-summary compliance-skipped">
					<span class="compliance-label">Yesterday's ${sport}</span>
					<span class="compliance-status">Skipped${a.skipReason ? ` \u2014 ${escapeHtml(a.skipReason)}` : ""}</span>
				</div>
			</div>`;
		}
		if (a.status === "completed") {
			const light = a.overallPass ? "green" : a.segmentsPassed > 0 ? "amber" : "red";
			return `
			<div class="compliance-section">
				<div class="compliance-summary compliance-${light}">
					<span class="compliance-label">Yesterday's ${sport}</span>
					<span class="compliance-status">${a.segmentsPassed}/${a.segmentsTotal} segments compliant</span>
					<span class="compliance-dot compliance-${light}"></span>
				</div>
			</div>`;
		}
	}

	// Case 2: Prescription was sent but no assessment yet — show confirmation buttons
	if (compliance.pendingSent && compliance.prescriptionDate) {
		return `
		<div class="compliance-section">
			<div class="compliance-confirm" data-sport="${sportEndpoint}" data-date="${compliance.prescriptionDate}">
				<span class="compliance-label">Yesterday's ${sport} prescription</span>
				<div class="compliance-actions">
					<button class="compliance-btn confirm-btn" data-action="confirm">I completed this</button>
					<button class="compliance-btn skip-btn" data-action="skip">I skipped this</button>
				</div>
			</div>
		</div>`;
	}

	return "";
}

function renderCard(
	suggestion: WorkoutSuggestion,
	invocations: Invocations,
	sportClass: string,
	accent: string,
	hrZones: number[] | null,
	showStryd = false,
	filteredWarnings?: string[],
	compliance?: ComplianceView | null,
	formText?: string,
): string {
	const ftp = suggestion.power_context.ftp;
	const sport = suggestion.sport;
	const complianceSegs = compliance?.assessment?.segments;
	const segments = suggestion.segments
		.map((s, i) => renderSegment(s, accent, sport, ftp, hrZones, i, complianceSegs))
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

			${renderWarnings(filteredWarnings ?? suggestion.warnings)}

			${renderVigilSection(suggestion.vigil)}

			<div class="segments">
				${segments}
			</div>

			<div class="rationale-section">
				<h3 class="rationale-header">${escapeHtml(invocations.rationale_header)}</h3>
				<p class="rationale-text">${escapeHtml(suggestion.rationale)}</p>
			</div>

			<div class="send-buttons">
				<button class="send-btn" data-sport="${sportEndpoint}" style="--btn-accent: ${accent}">
					&#x2197; Send to intervals.icu
				</button>
				${showStryd ? `<button class="send-btn stryd-btn" data-sport="${sportEndpoint}" style="--btn-accent: #5a3eb8">&#x2197; Send to Stryd</button>` : ""}
				${formText ? `<button class="send-btn form-btn" data-form-text="${escapeHtml(formText)}" style="--btn-accent: #c8d600">&#x1F4CB; Copy FORM Text</button>` : ""}
			</div>
			${renderComplianceSection(compliance, sport, sportEndpoint)}
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

function renderDataSource(ds: DataSource, generatedAt: string, tz?: string): string {
	const time = formatLocalTime(generatedAt, tz);

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
	const { tz } = data;
	const dateStr = new Date(data.generatedAt).toLocaleDateString("en-CA", { timeZone: tz });
	const day = dayName(data.generatedAt, tz);
	const runAccent = "#3a7a4a";
	const swimAccent = "#1e5a7e";
	const { profile } = data;
	const singleCard = (data.run ? 1 : 0) + (data.swim ? 1 : 0) === 1;

	const dataSourceBlock = renderDataSource(data.dataSource, data.generatedAt, tz);
	// Extract warnings shared between both prescriptions — render once above cards
	const runWarnings = data.run?.warnings ?? [];
	const swimWarnings = data.swim?.warnings ?? [];
	const sharedWarnings =
		data.run && data.swim ? runWarnings.filter((w) => swimWarnings.includes(w)) : [];
	const sharedSet = new Set(sharedWarnings);
	const runOnlyWarnings = runWarnings.filter((w) => !sharedSet.has(w));
	const swimOnlyWarnings = swimWarnings.filter((w) => !sharedSet.has(w));
	const sharedWarningsBlock = renderWarnings(sharedWarnings);

	const showStryd = profile.stryd;
	const runCard =
		data.run && data.runInvocations
			? renderCard(
					data.run,
					data.runInvocations,
					"card-run",
					runAccent,
					data.runHrZones,
					showStryd,
					runOnlyWarnings,
					data.runCompliance,
				)
			: "";
	const swimFormText = data.swim ? buildFormDescription(data.swim) : undefined;
	const swimCard =
		data.swim && data.swimInvocations
			? renderCard(
					data.swim,
					data.swimInvocations,
					"card-swim",
					swimAccent,
					data.swimHrZones,
					false,
					swimOnlyWarnings,
					data.swimCompliance,
					swimFormText,
				)
			: "";

	// Apollo's closing — rendered once at the bottom of the page
	const closingText = data.runInvocations?.closing ?? data.swimInvocations?.closing ?? "";
	const closingBlock = closingText
		? `<blockquote class="closing-page"><p>${escapeHtml(closingText)}</p></blockquote>`
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

	${sharedWarningsBlock}

	<main class="${cardsClass}">
		${runCard}
		${swimCard}
	</main>

	${closingBlock}

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
	--gold: #7a5a1a;
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

.invocation {
	font-family: var(--font-display);
	font-style: italic;
	font-weight: 600;
	font-size: 1rem;
	color: var(--gold);
	border-left: 3px solid;
	padding: 0.7rem 1rem;
	margin: 1.2rem 0;
	background: var(--gold-glow);
	border-radius: 0 6px 6px 0;
	line-height: 1.5;
}

.closing-page {
	font-family: var(--font-display);
	font-style: italic;
	font-weight: 600;
	font-size: 1rem;
	color: var(--gold);
	text-align: center;
	max-width: 720px;
	margin: 2rem auto 1rem;
	padding: 1rem;
	line-height: 1.5;
	border: none;
}

/* --- Warnings --- */

.warnings {
	background: rgba(196, 78, 34, 0.06);
	border: 1px solid rgba(196, 78, 34, 0.2);
	border-radius: 6px;
	padding: 0.6rem 1rem;
	margin: 1rem auto;
	text-align: center;
	max-width: 720px;
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

/* --- Rationale --- */

.rationale-section {
	margin: 0.8rem 0 1rem;
	text-align: center;
}

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

/* --- Compliance --- */

.compliance-dot {
	display: inline-block;
	width: 10px;
	height: 10px;
	border-radius: 50%;
	margin-left: 0.4rem;
	vertical-align: middle;
}

.compliance-green { background: #3a7a4a; }
.compliance-amber { background: #c49828; }
.compliance-red { background: #c44e22; }

.compliance-section {
	margin-top: 1rem;
	padding-top: 0.8rem;
	border-top: 1px solid var(--border);
}

.compliance-summary {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	font-size: 0.78rem;
}

.compliance-label {
	color: var(--text-dim);
	font-size: 0.72rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.compliance-status {
	color: var(--text);
	font-weight: 500;
}

.compliance-skipped .compliance-status { color: var(--text-dim); }

.compliance-confirm {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

.compliance-actions {
	display: flex;
	gap: 0.4rem;
}

.compliance-btn {
	padding: 0.4rem 0.7rem;
	border-radius: 5px;
	font-family: var(--font-mono);
	font-size: 0.72rem;
	cursor: pointer;
	transition: all 0.2s ease;
}

.confirm-btn {
	background: transparent;
	border: 1.5px solid #3a7a4a;
	color: #3a7a4a;
}

.confirm-btn:hover {
	background: #3a7a4a;
	color: var(--surface);
}

.skip-btn {
	background: transparent;
	border: 1.5px solid var(--text-dim);
	color: var(--text-dim);
}

.skip-btn:hover {
	background: var(--text-dim);
	color: var(--surface);
}

.compliance-btn:disabled {
	cursor: not-allowed;
	opacity: 0.5;
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
document.cookie = 'tz=' + Intl.DateTimeFormat().resolvedOptions().timeZone
	+ ';path=/;max-age=31536000;SameSite=Lax';

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

// Compliance confirmation buttons
document.querySelectorAll('.compliance-confirm').forEach(el => {
	const sport = el.dataset.sport;
	const date = el.dataset.date;
	const sportUpper = sport === 'run' ? 'Run' : 'Swim';

	el.querySelector('.confirm-btn')?.addEventListener('click', async function() {
		this.disabled = true;
		this.textContent = 'Finding activity\\u2026';
		try {
			const listRes = await fetch('${prefix}/api/compliance/activities?date=' + date + '&sport=' + sportUpper);
			const activities = await listRes.json();

			if (activities.length === 0) {
				this.textContent = 'No activity found';
				this.classList.add('error');
				return;
			}

			// Auto-pick if only one match, otherwise let user pick
			const actId = activities.length === 1
				? activities[0].id
				: prompt('Multiple activities found. Enter ID:\\n' + activities.map(a => a.id + ' - ' + a.name).join('\\n'));

			if (!actId) { this.disabled = false; this.textContent = 'I completed this'; return; }

			this.textContent = 'Assessing\\u2026';
			const res = await fetch('${prefix}/api/compliance/confirm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ date, sport: sportUpper, activityId: actId })
			});
			const data = await res.json();
			if (data.success) {
				window.location.reload();
			} else {
				this.textContent = data.error || 'Assessment failed';
			}
		} catch (err) {
			this.textContent = 'Error';
		}
	});

	el.querySelector('.skip-btn')?.addEventListener('click', async function() {
		const reason = prompt('Why did you skip? (optional)');
		this.disabled = true;
		try {
			await fetch('${prefix}/api/compliance/skip', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ date, sport: sportUpper, reason: reason || null })
			});
			window.location.reload();
		} catch {
			this.disabled = false;
		}
	});
});

// FORM copy button
document.querySelectorAll('.form-btn').forEach(btn => {
	btn.addEventListener('click', async function() {
		const text = this.dataset.formText;
		try {
			await navigator.clipboard.writeText(text);
			this.textContent = '\\u2713 Copied';
			setTimeout(() => { this.textContent = '\\uD83D\\uDCCB Copy FORM Text'; }, 3000);
		} catch {
			// Fallback for non-HTTPS or older browsers
			const ta = document.createElement('textarea');
			ta.value = text;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
			this.textContent = '\\u2713 Copied';
			setTimeout(() => { this.textContent = '\\uD83D\\uDCCB Copy FORM Text'; }, 3000);
		}
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
