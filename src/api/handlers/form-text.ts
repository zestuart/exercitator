/**
 * GET /api/users/:userId/form-text
 *
 * Returns today's swim prescription as FORM-goggles Script plain text.
 * Mirrors Praescriptor's "Copy FORM Text" button by piping the swim suggestion
 * through `buildFormDescription` (src/web/form-format.ts).
 *
 * See phase3/exercitator-http-api-v0.3-delta.md §2.3.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { buildFormDescription } from "../../web/form-format.js";
import { generatePrescriptions } from "../../web/prescriptions.js";
import { apiError } from "../errors.js";
import type { UserContext } from "../router.js";
import { resolveTz } from "../tz.js";

export async function handleFormText(
	_req: IncomingMessage,
	res: ServerResponse,
	user: UserContext,
	url: URL,
): Promise<void> {
	if (!user.profile.sports.includes("Swim")) {
		apiError(res, 400, `${user.profile.displayName} does not have swim prescriptions`);
		return;
	}

	// `tz` reaches `localDateStr` inside generatePrescriptions → must be
	// IANA-validated at the boundary (DoS via RangeError otherwise).
	const tz = await resolveTz(user, url);

	let prescriptions: Awaited<ReturnType<typeof generatePrescriptions>>;
	try {
		prescriptions = await generatePrescriptions(user.intervals, user.profile, user.stryd, tz);
	} catch (err) {
		console.error("generatePrescriptions failed in form-text handler:", err);
		apiError(res, 502, "upstream error");
		return;
	}

	if (!prescriptions.swim) {
		apiError(res, 404, "no swim suggestion for today");
		return;
	}

	const text = buildFormDescription(prescriptions.swim);
	res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(text);
}
