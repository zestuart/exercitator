/**
 * Deity invocation text generator for prescription cards.
 *
 * Deity assignments:
 *   Diana      — Running patron (goddess of the body in motion)
 *   Amphitrite — Swimming patron (queen of the sea, rhythmic flow)
 *   Minerva    — Strategy & rationale section header
 *   Apollo     — Closing blessing (let the data confirm)
 *   Quies      — Goddess of repose; speaks the suppression card when the
 *                requested sport has already been trained today (cross-sport
 *                voice — Quies addresses you regardless of which sport).
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

function cacheKey(sport: "Run" | "Swim", category: WorkoutCategory, today: string): string {
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
		rationale_header: "Under Minerva\u2019s Counsel",
		closing: STATIC_CLOSING[sport],
	};
}

/** Non-deity invocations for users who don't use the Roman liturgical style. */
export function plainInvocations(sport: "Run" | "Swim"): Invocations {
	const sportName = sport === "Run" ? "running" : "swimming";
	return {
		opening: `Today\u2019s ${sportName} prescription, built from your recent training data and current readiness.`,
		rationale_header: "Rationale",
		closing: "Trust the process. The work is prescribed; the execution is yours.",
	};
}

// ---------------------------------------------------------------------------
// Quies \u2014 suppression card when the requested sport is already trained today
// ---------------------------------------------------------------------------

const SPORT_PATRON: Record<"Run" | "Swim", string> = {
	Run: "Diana",
	Swim: "Amphitrite",
};

function quiesStaticFallback(
	trainedSport: "Run" | "Swim",
	alternateSport: "Run" | "Swim" | null,
): Invocations {
	const releasing = SPORT_PATRON[trainedSport];
	if (alternateSport === null) {
		return {
			opening: `Before Quies, goddess of repose, the day's work is set down. ${releasing} releases you; ${SPORT_PATRON[trainedSport === "Run" ? "Swim" : "Run"]} keeps her own counsel today. Rest is the prescription.`,
			rationale_header: "Under Quies\u2019 Counsel",
			closing:
				"The body has spoken through the data. Let Apollo confirm in tomorrow's reckoning what today's restraint preserves.",
		};
	}
	const beckoning = SPORT_PATRON[alternateSport];
	return {
		opening: `Before Quies, goddess of repose, the day's work is set down. ${releasing} releases you. Seek ${beckoning}, or seek nothing at all.`,
		rationale_header: "Under Quies\u2019 Counsel",
		closing:
			"The body has spoken through the data. Let Apollo confirm in tomorrow's reckoning what today's restraint preserves.",
	};
}

function plainQuiesFallback(
	trainedSport: "Run" | "Swim",
	alternateSport: "Run" | "Swim" | null,
): Invocations {
	const trainedNoun = trainedSport === "Run" ? "run" : "swum";
	const trainedActivity = trainedSport === "Run" ? "running" : "swimming";
	if (alternateSport === null) {
		return {
			opening: `You have already ${trainedNoun} today, and the alternate sport is also done. Rest is the prescription.`,
			rationale_header: "Rationale",
			closing: "Recovery is part of the training. Tomorrow's data will confirm.",
		};
	}
	const alt = alternateSport === "Run" ? "run" : "swim";
	return {
		opening: `You have already ${trainedNoun} today. Rest, or swap to a ${alt}.`,
		rationale_header: "Rationale",
		closing: `${trainedActivity[0].toUpperCase() + trainedActivity.slice(1)} again today would add stress without proportional gain.`,
	};
}

async function generateQuiesFromApi(
	trainedSport: "Run" | "Swim",
	alternateSport: "Run" | "Swim" | null,
): Promise<Invocations> {
	const releasing = SPORT_PATRON[trainedSport];
	const altLine =
		alternateSport === null
			? `The other sport (${trainedSport === "Run" ? "swim" : "run"}) has also been completed today, so the message is rest-only.`
			: `The alternate sport (${alternateSport}, patron ${SPORT_PATRON[alternateSport]}) remains available.`;

	const prompt = `Generate two short invocations for an athlete whose ${trainedSport.toLowerCase()} training for today is already complete.

Speaker: Quies, Roman goddess of repose.
Trained sport today: ${trainedSport} (patron ${releasing})
${altLine}

Generate exactly two invocations as JSON:
1. "opening" \u2014 2-3 sentences. Quies addresses the athlete. ${releasing} releases them from further ${trainedSport.toLowerCase()} work. ${alternateSport ? `Mention seeking ${SPORT_PATRON[alternateSport]} as an alternative.` : "Rest is the only counsel."} Classical Roman religious tone.
2. "closing" \u2014 1-2 sentences invoking Apollo (keeper of measure and truth) to confirm through tomorrow's data that today's restraint was correct.

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
		rationale_header: "Under Quies\u2019 Counsel",
		closing: parsed.closing,
	};
}

function quiesCacheKey(
	trainedSport: "Run" | "Swim",
	alternateSport: "Run" | "Swim" | null,
	today: string,
): string {
	return `${today}-quies-${trainedSport}-${alternateSport ?? "none"}`;
}

/**
 * Quies invocation for the suppression card. Uses the same per-day cache as
 * generateInvocations. Falls back to a static string when the Anthropic API
 * is unavailable or unset.
 */
export async function quiesInvocation(
	trainedSport: "Run" | "Swim",
	alternateSport: "Run" | "Swim" | null,
	today?: string,
): Promise<Invocations> {
	const todayStr = today ?? new Date().toISOString().slice(0, 10);
	const key = quiesCacheKey(trainedSport, alternateSport, todayStr);
	const hit = invocationCache.get(key);
	if (hit) return hit;

	if (!ANTHROPIC_API_KEY) {
		const fallback = quiesStaticFallback(trainedSport, alternateSport);
		invocationCache.set(key, fallback);
		return fallback;
	}

	try {
		const result = await generateQuiesFromApi(trainedSport, alternateSport);
		invocationCache.set(key, result);
		return result;
	} catch {
		const fallback = quiesStaticFallback(trainedSport, alternateSport);
		invocationCache.set(key, fallback);
		return fallback;
	}
}

/** Plain (no-deity) Quies-equivalent for users with deities: false (e.g. Pam). */
export function plainQuiesMessage(
	trainedSport: "Run" | "Swim",
	alternateSport: "Run" | "Swim" | null,
): Invocations {
	return plainQuiesFallback(trainedSport, alternateSport);
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
		rationale_header: "Under Minerva\u2019s Counsel",
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
	today?: string,
): Promise<Invocations> {
	const todayStr = today ?? new Date().toISOString().slice(0, 10);
	const key = cacheKey(sport, category, todayStr);
	const hit = invocationCache.get(key);
	if (hit) return hit;

	// Clean stale entries (previous days)
	for (const k of invocationCache.keys()) {
		if (!k.startsWith(todayStr)) invocationCache.delete(k);
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
