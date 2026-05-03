/**
 * POST /api/users/:userId/push-to-stryd
 *
 * Bearer-scoped wrapper around `sendToStryd` (src/web/send-stryd.ts) — the
 * same function Praescriptor's "Push to Stryd" button calls. Stryd workouts
 * are run-only, so there is no sport parameter.
 *
 * See phase3/exercitator-http-api-v0.3-delta.md §2.1.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendToStryd } from "../../web/send-stryd.js";
import { apiError } from "../errors.js";
import type { UserContext } from "../router.js";
import { resolveTz } from "../tz.js";

export async function handlePushToStryd(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
	url: URL,
): Promise<void> {
	if (!user.profile.sports.includes("Run")) {
		apiError(res, 400, `${user.profile.displayName} does not have run prescriptions`);
		return;
	}
	if (!user.profile.stryd || !user.stryd) {
		apiError(res, 400, "Stryd not configured for this user");
		return;
	}
	const force = url.searchParams.get("force") === "true";
	// `tz` reaches `localDateStr` inside sendToStryd → must be IANA-validated
	// at the boundary or a crafted value DoSes the listener (RangeError).
	const tz = await resolveTz(user, url);
	await sendToStryd(user.intervals, user.profile, user.stryd, res, force, tz);
}
