/**
 * Exercitator — MCP bridge for intervals.icu
 *
 * Supports two transports (selected via MCP_TRANSPORT env var):
 *   - "stdio"            — local IPC for development / claude mcp add
 *   - "streamable-http"  — HTTP with OAuth, for Tailscale funnel deployment
 */

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authEnabled, createOAuthHandler, validateBearer } from "./auth.js";
import { IntervalsClient } from "./intervals.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerAthleteTools } from "./tools/athlete.js";
import { registerEventTools } from "./tools/events.js";
import { registerWellnessTools } from "./tools/wellness.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRANSPORT = process.env.MCP_TRANSPORT ?? "stdio";
const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.MCP_PORT ?? "8642", 10);
const SERVER_URL = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}`;

const API_KEY = process.env.INTERVALS_ICU_API_KEY;
if (!API_KEY) {
	console.error("INTERVALS_ICU_API_KEY is required");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
	name: "exercitator",
	version: "0.1.0",
});

const client = new IntervalsClient({ apiKey: API_KEY });

registerAthleteTools(server, client);
registerActivityTools(server, client);
registerWellnessTools(server, client);
registerEventTools(server, client);

// ---------------------------------------------------------------------------
// Transport: stdio
// ---------------------------------------------------------------------------

if (TRANSPORT === "stdio") {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Exercitator MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: streamable-http
// ---------------------------------------------------------------------------

if (TRANSPORT === "streamable-http") {
	const useAuth = authEnabled();
	const oauthHandler = useAuth
		? createOAuthHandler(SERVER_URL.startsWith("http") ? SERVER_URL : `https://${SERVER_URL}`)
		: null;

	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

		// Health check
		if (url.pathname === "/health" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}

		// OAuth endpoints
		if (oauthHandler?.(req, res, url)) return;

		// MCP endpoint — require auth if enabled
		if (url.pathname === "/mcp") {
			if (useAuth && !validateBearer(req)) {
				const resourceUrl = SERVER_URL.startsWith("http") ? SERVER_URL : `https://${SERVER_URL}`;
				res.writeHead(401, {
					"WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource"`,
				});
				res.end();
				return;
			}

			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			await server.connect(transport);
			await transport.handleRequest(req, res);
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	});

	httpServer.listen(PORT, HOST, () => {
		console.error(
			`Exercitator MCP server listening on ${HOST}:${PORT} (auth: ${useAuth ? "on" : "off"})`,
		);
	});
}
