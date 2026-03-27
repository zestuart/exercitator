/**
 * Deity invocation text generator for prescription cards.
 *
 * Deity assignments:
 *   Diana      — Running patron (goddess of the body in motion)
 *   Amphitrite — Swimming patron (queen of the sea, rhythmic flow)
 *   Minerva    — Strategy & rationale section header
 *   Apollo     — Closing blessing (let the data confirm)
 *
 * Uses the Anthropic API for contextual invocations, with static fallbacks.
 * Never blocks page rendering — falls back if the API is unavailable.
 */

import type { WorkoutCategory } from "../engine/types.js";

export interface Invocations {
	opening: string;
	rationale_header: string;
	closing: string;
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// In-memory cache: keyed by date + sport + category
const invocationCache = new Map<string, Invocations>();

function cacheKey(sport: "Run" | "Swim", category: WorkoutCategory): string {
	const today = new Date().toISOString().slice(0, 10);
	return `${today}-${sport}-${category}`;
}

// ---------------------------------------------------------------------------
// Static fallbacks
// ---------------------------------------------------------------------------

const STATIC_OPENING: Record<"Run" | "Swim", string> = {
	Run: "Before Diana, patroness of the swift and the steadfast, this prescription is laid. May each stride be measured, each breath purposeful, and the body obedient to the work set before it.",
	Swim: "Before Amphitrite, queen of calm waters and rhythmic motion, this prescription is laid. May each stroke be counted, each length purposeful, and the body surrender to the discipline of the lane.",
};

const STATIC_CLOSING: Record<"Run" | "Swim", string> = {
	Run: "Let Apollo, keeper of measure and truth, confirm through the data what the body already knows. The work is prescribed; the execution is yours.",
	Swim: "Let Apollo, keeper of measure and truth, confirm through the data what the body already knows. The work is prescribed; the execution is yours.",
};

function staticFallback(sport: "Run" | "Swim"): Invocations {
	return {
		opening: STATIC_OPENING[sport],
		rationale_header: "Rationale \u00b7 Under Minerva\u2019s Counsel",
		closing: STATIC_CLOSING[sport],
	};
}

// ---------------------------------------------------------------------------
// Anthropic API generation
// ---------------------------------------------------------------------------

async function generateFromApi(
	sport: "Run" | "Swim",
	category: WorkoutCategory,
	readinessScore: number,
	warnings: string[],
): Promise<Invocations> {
	const deity = sport === "Run" ? "Diana" : "Amphitrite";
	const domain =
		sport === "Run"
			? "goddess of the body in motion, the swift and the steadfast"
			: "queen of the sea, calm waters and rhythmic flow";

	const warningContext = warnings.length > 0 ? `\nAdvisory warnings: ${warnings.join("; ")}` : "";

	const prompt = `Generate two short invocations for an athlete's ${sport.toLowerCase()} training prescription.

Sport: ${sport}
Workout category: ${category}
Readiness score: ${readinessScore}/100
Patron deity: ${deity} (${domain})${warningContext}

Generate exactly two invocations as JSON:
1. "opening" — 2-3 sentences addressing ${deity}, referencing the ${category} workout and the athlete's current state. Classical Roman religious tone.
2. "closing" — 1-2 sentences invoking Apollo (keeper of measure and truth) to confirm through data. Reference the work prescribed.

Return only valid JSON: {"opening": "...", "closing": "..."}`;

	const res = await fetch(ANTHROPIC_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": ANTHROPIC_API_KEY as string,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-6",
			max_tokens: 300,
			system:
				"You are a liturgical voice for an athlete's training system. Write invocations in the style of classical Roman religious address. British English. No exclamation marks. No emojis. 2-3 sentences maximum per invocation. Return only valid JSON.",
			messages: [{ role: "user", content: prompt }],
		}),
	});

	if (!res.ok) {
		throw new Error(`Anthropic API: ${res.status}`);
	}

	const body = (await res.json()) as {
		content: Array<{ type: string; text: string }>;
	};
	const text = body.content[0]?.text ?? "";
	const parsed = JSON.parse(text) as { opening: string; closing: string };

	return {
		opening: parsed.opening,
		rationale_header: "Rationale \u00b7 Under Minerva\u2019s Counsel",
		closing: parsed.closing,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateInvocations(
	sport: "Run" | "Swim",
	category: WorkoutCategory,
	readinessScore: number,
	warnings: string[],
): Promise<Invocations> {
	const key = cacheKey(sport, category);
	const hit = invocationCache.get(key);
	if (hit) return hit;

	// Clean stale entries (previous days)
	const today = new Date().toISOString().slice(0, 10);
	for (const k of invocationCache.keys()) {
		if (!k.startsWith(today)) invocationCache.delete(k);
	}

	if (!ANTHROPIC_API_KEY) {
		const fallback = staticFallback(sport);
		invocationCache.set(key, fallback);
		return fallback;
	}

	try {
		const result = await generateFromApi(sport, category, readinessScore, warnings);
		invocationCache.set(key, result);
		return result;
	} catch {
		const fallback = staticFallback(sport);
		invocationCache.set(key, fallback);
		return fallback;
	}
}
