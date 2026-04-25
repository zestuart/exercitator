/**
 * HTTP API listener.
 *
 * Starts a dedicated HTTP server (default port 8643) that serves the REST
 * surface for native clients (Excubitor iOS primarily). Co-resident with
 * the MCP server in the same Node process, sharing IntervalsClient /
 * StrydClient / SQLite state.
 *
 * See phase2/exercitator-http-api-spec.md §1 & §7.
 */

import { createServer } from "node:http";
import { IntervalsClient } from "../intervals.js";
import { StrydClient } from "../stryd/client.js";
import { getUserIds, getUserProfile } from "../users.js";
import { loadApiKeys } from "./auth.js";
import { apiError } from "./errors.js";
import { type ApiContext, handleApiRequest } from "./router.js";

function parseBindAddr(
	raw: string | undefined,
	fallbackHost: string,
): { host: string; port: number } {
	const v = raw ?? `${fallbackHost}:8643`;
	const idx = v.lastIndexOf(":");
	if (idx < 0) {
		return { host: fallbackHost, port: Number.parseInt(v, 10) || 8643 };
	}
	const host = v.slice(0, idx) || fallbackHost;
	const port = Number.parseInt(v.slice(idx + 1), 10) || 8643;
	return { host, port };
}

export interface StartApiOptions {
	/** Default bind host when EXERCITATOR_API_BIND_ADDR is unset. */
	defaultHost: "127.0.0.1" | "0.0.0.0";
	/** Semver-ish string reported by /api/health. */
	version: string;
}

/**
 * Start the HTTP API listener. Returns immediately on failure (logs + noop)
 * so a misconfiguration doesn't take down the MCP server.
 *
 * Silently no-ops if EXERCITATOR_API_KEYS / _FILE is unset.
 */
export function startApiServer(opts: StartApiOptions): void {
	const keys = loadApiKeys();
	if (keys.length === 0) {
		console.error("HTTP API: no keys configured (EXERCITATOR_API_KEYS unset) — listener disabled");
		return;
	}

	const { host, port } = parseBindAddr(process.env.EXERCITATOR_API_BIND_ADDR, opts.defaultHost);

	// Build per-user client maps using the shared registry.
	const intervalsClients = new Map<string, IntervalsClient>();
	for (const id of getUserIds()) {
		const profile = getUserProfile(id);
		if (!profile) continue;
		const apiKey = process.env[profile.apiKeyEnv];
		if (apiKey) {
			intervalsClients.set(profile.id, new IntervalsClient({ apiKey }));
		}
	}

	const strydClients = new Map<string, StrydClient>();
	for (const id of getUserIds()) {
		const profile = getUserProfile(id);
		if (!profile?.stryd || !profile.strydEmailEnv || !profile.strydPasswordEnv) continue;
		const email = process.env[profile.strydEmailEnv];
		const password = process.env[profile.strydPasswordEnv];
		if (email && password) {
			strydClients.set(profile.id, new StrydClient({ email, password }));
		}
	}

	const ctx: ApiContext = {
		auth: { keys },
		intervalsClients,
		strydClients,
		usersConfigured: Array.from(intervalsClients.keys()),
		startedAt: Date.now(),
		version: opts.version,
	};

	const httpServer = createServer(async (req, res) => {
		// 1 MiB body cap — §3
		let bytesRead = 0;
		req.on("data", (chunk: Buffer) => {
			bytesRead += chunk.length;
			if (bytesRead > 1_048_576) {
				req.destroy();
			}
		});

		try {
			await handleApiRequest(req, res, ctx);
		} catch (err) {
			console.error("HTTP API handler error:", err);
			apiError(res, 500, "internal server error");
		}
	});

	httpServer.on("error", (err) => {
		console.error(`HTTP API listen error on ${host}:${port}:`, err);
	});

	httpServer.listen(port, host, () => {
		console.error(`HTTP API listening on ${host}:${port} (${keys.length} keys configured)`);
	});
}
