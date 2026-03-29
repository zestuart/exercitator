import { describe, expect, it } from "vitest";
import type { VigilSummary, WorkoutSuggestion } from "../../src/engine/types.js";
import { type RenderData, renderPage } from "../../src/web/render.js";
import type { UserProfile } from "../../src/web/users.js";

const ZE_PROFILE: UserProfile = {
	id: "ze",
	displayName: "Ze",
	sports: ["Run", "Swim"],
	deities: true,
	stryd: true,
	apiKeyEnv: "INTERVALS_ICU_API_KEY",
	strydEmailEnv: "STRYD_EMAIL",
	strydPasswordEnv: "STRYD_PASSWORD",
};

function makeMinimalSuggestion(overrides: Partial<WorkoutSuggestion> = {}): WorkoutSuggestion {
	return {
		sport: "Run",
		category: "base",
		title: "Test Workout",
		rationale: "Test rationale",
		total_duration_secs: 2400,
		estimated_load: 50,
		segments: [
			{
				name: "Warm-up",
				duration_secs: 600,
				target_description: "Easy Z1",
				target_hr_zone: 1,
			},
		],
		readiness_score: 65,
		sport_selection_reason: "Forced: Run",
		terrain: "flat",
		terrain_rationale: "Default",
		power_context: {
			source: "stryd",
			ftp: 280,
			rolling_ftp: 280,
			correction_factor: 1.0,
			confidence: "high",
			warnings: [],
		},
		warnings: [],
		...overrides,
	};
}

function makeRenderData(overrides: Partial<RenderData> = {}): RenderData {
	return {
		profile: ZE_PROFILE,
		run: makeMinimalSuggestion(),
		swim: makeMinimalSuggestion({ sport: "Swim" }),
		runInvocations: {
			opening: "Diana watches.",
			rationale_header: "Minerva",
			closing: "Go forth.",
		},
		swimInvocations: {
			opening: "Amphitrite beckons.",
			rationale_header: "Minerva",
			closing: "Dive deep.",
		},
		runHrZones: [130, 145, 160, 175, 190],
		swimHrZones: [120, 135, 150, 165, 180],
		dataSource: {
			activityCount: 10,
			activityRange: ["2026-03-14", "2026-03-27"],
			activityDevices: { "Forerunner 970": 8, STRYD: 2 },
			wellnessCount: 7,
			wellnessRange: ["2026-03-21", "2026-03-27"],
			strydEnriched: 1,
			strydCp: 292,
			vigil: null,
		},
		generatedAt: "2026-03-28T10:30:00Z",
		...overrides,
	};
}

function makeVigilSummary(
	severity: 0 | 1 | 2 | 3,
	status: "active" | "building" | "inactive" = "active",
): VigilSummary {
	if (status === "building") {
		return {
			severity: 0,
			summary: "Vigil: baseline building (3/5 activities)",
			recommendation: "",
			flags: [],
			baselineWindow: "30d (3 activities)",
			acuteWindow: "7d (pending)",
			status: "building",
		};
	}
	if (status === "inactive") {
		return {
			severity: 0,
			summary: "Vigil: no Stryd data",
			recommendation: "",
			flags: [],
			baselineWindow: "30d (0 activities)",
			acuteWindow: "7d (0 activities)",
			status: "inactive",
		};
	}

	return {
		severity,
		summary:
			severity === 0
				? "No biomechanical concerns detected."
				: "Caution: avg_gct_ms +2.5\u03C3, avg_lss -2.3\u03C3 above 30-day baseline",
		recommendation:
			severity >= 2 ? "Intensity downshifted. Monitor form." : "Prescription unchanged.",
		flags:
			severity > 0
				? [
						{
							metric: "avg_gct_ms",
							zScore: 2.5,
							weight: 1.0,
							weightedZ: 2.5,
							value7d: 255,
							value30d: 235,
						},
						{
							metric: "avg_ilr",
							zScore: 3.2,
							weight: 0.5,
							weightedZ: 1.6,
							value7d: 15.2,
							value30d: 12.0,
						},
					]
				: [],
		baselineWindow: "30d (12 activities)",
		acuteWindow: "7d (3 activities)",
		status: "active",
	};
}

// ---------------------------------------------------------------------------
// Vigil section rendering
// ---------------------------------------------------------------------------

/** Extract the main content area (after </style>) to avoid matching CSS class names. */
function htmlBody(html: string): string {
	const styleEnd = html.indexOf("</style>");
	return styleEnd > 0 ? html.slice(styleEnd) : html;
}

describe("Vigil section in rendered HTML", () => {
	it("no Vigil section when severity 0", () => {
		const data = makeRenderData({
			run: makeMinimalSuggestion({ vigil: makeVigilSummary(0) }),
		});
		const body = htmlBody(renderPage(data));
		expect(body).not.toContain("vigil-header");
	});

	it("no Vigil section when vigil is undefined", () => {
		const body = htmlBody(renderPage(makeRenderData()));
		expect(body).not.toContain("vigil-header");
	});

	it("renders amber advisory for severity 1", () => {
		const data = makeRenderData({
			run: makeMinimalSuggestion({ vigil: makeVigilSummary(1) }),
		});
		const body = htmlBody(renderPage(data));
		expect(body).toContain("vigil-caution");
		expect(body).toContain("avg_gct_ms");
		expect(body).not.toMatch(/class="vigil-section vigil-alert"/);
	});

	it("renders amber warning for severity 2 with downshift detail", () => {
		const data = makeRenderData({
			run: makeMinimalSuggestion({ vigil: makeVigilSummary(2) }),
		});
		const html = renderPage(data);
		expect(html).toContain("vigil-caution");
		expect(html).toContain("vigil-detail");
		expect(html).toContain("downshifted");
	});

	it("renders red alert for severity 3", () => {
		const data = makeRenderData({
			run: makeMinimalSuggestion({ vigil: makeVigilSummary(3) }),
		});
		const html = renderPage(data);
		expect(html).toContain("vigil-alert");
		expect(html).toContain("vigil-detail");
	});

	it("shows weight annotation for ILR (weight 0.5)", () => {
		const data = makeRenderData({
			run: makeMinimalSuggestion({ vigil: makeVigilSummary(2) }),
		});
		const html = renderPage(data);
		// ILR has weight 0.5 — should show weighted note
		expect(html).toContain("weighted 0.5");
		expect(html).toContain("raw z");
	});

	it("no Vigil section on swim card", () => {
		const data = makeRenderData({
			run: makeMinimalSuggestion({ vigil: makeVigilSummary(2) }),
			swim: makeMinimalSuggestion({ sport: "Swim", vigil: undefined }),
		});
		const body = htmlBody(renderPage(data));
		// The run card should have Vigil, the swim card should not
		const swimStart = body.indexOf("card-swim");
		const swimContent = body.slice(swimStart);
		expect(swimContent).not.toContain("vigil-header");
	});
});

// ---------------------------------------------------------------------------
// Vigil in data source bar
// ---------------------------------------------------------------------------

describe("Vigil in data source bar", () => {
	it("shows Vigil: clear when severity 0 and active", () => {
		const data = makeRenderData({
			dataSource: {
				...makeRenderData().dataSource,
				vigil: makeVigilSummary(0),
			},
		});
		const html = renderPage(data);
		expect(html).toContain("Vigil: clear, 12 runs");
	});

	it("shows flag count and severity when active with flags", () => {
		const data = makeRenderData({
			dataSource: {
				...makeRenderData().dataSource,
				vigil: makeVigilSummary(2),
			},
		});
		const html = renderPage(data);
		expect(html).toContain("Vigil: 2 flags (sev 2), 12 runs");
	});

	it("shows baseline building status", () => {
		const data = makeRenderData({
			dataSource: {
				...makeRenderData().dataSource,
				vigil: makeVigilSummary(0, "building"),
			},
		});
		const html = renderPage(data);
		expect(html).toContain("baseline building (3/5 activities)");
	});

	it("shows no Stryd data when inactive", () => {
		const data = makeRenderData({
			dataSource: {
				...makeRenderData().dataSource,
				vigil: makeVigilSummary(0, "inactive"),
			},
		});
		const html = renderPage(data);
		expect(html).toContain("Vigil: no Stryd data");
	});

	it("no Vigil in data source bar when null", () => {
		const body = htmlBody(renderPage(makeRenderData()));
		// When vigil is null, the data source bar should not contain "Vigil:"
		expect(body).not.toContain("Vigil:");
	});
});
