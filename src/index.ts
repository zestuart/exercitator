/**
 * Exercitator — MCP bridge for intervals.icu
 *
 * Supports two transports (selected via MCP_TRANSPORT env var):
 *   - "stdio"            — local IPC for development / claude mcp add
 *   - "streamable-http"  — HTTP with OAuth, for Tailscale funnel deployment
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authEnabled, createOAuthHandler, validateBearer } from "./auth.js";
import { IntervalsClient } from "./intervals.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerAthleteTools } from "./tools/athlete.js";
import { registerEventTools } from "./tools/events.js";
import { registerSuggestTools } from "./tools/suggest.js";
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

const intervalsClient = new IntervalsClient({ apiKey: API_KEY });

// ---------------------------------------------------------------------------
// Server factory — each connection gets its own McpServer instance
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
	const server = new McpServer({
		name: "exercitator",
		version: "0.1.0",
	});

	registerAthleteTools(server, intervalsClient);
	registerActivityTools(server, intervalsClient);
	registerWellnessTools(server, intervalsClient);
	registerEventTools(server, intervalsClient);
	registerSuggestTools(server, intervalsClient);

	return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio
// ---------------------------------------------------------------------------

if (TRANSPORT === "stdio") {
	const server = createMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Exercitator MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: streamable-http
// ---------------------------------------------------------------------------

if (TRANSPORT === "streamable-http") {
	const useAuth = authEnabled();
	const serverUrl = SERVER_URL.startsWith("http") ? SERVER_URL : `https://${SERVER_URL}`;
	const oauthHandler = useAuth ? createOAuthHandler(serverUrl) : null;

	// Track active sessions: sessionId -> { transport, lastActivity }
	const MAX_SESSIONS = 100;
	const SESSION_IDLE_MS = 5 * 60_000; // 5 minutes

	interface Session {
		transport: StreamableHTTPServerTransport;
		lastActivity: number;
	}

	const sessions = new Map<string, Session>();

	// Prune idle sessions every 60 seconds
	setInterval(() => {
		const now = Date.now();
		for (const [id, session] of sessions) {
			if (now - session.lastActivity > SESSION_IDLE_MS) {
				session.transport.close?.();
				sessions.delete(id);
			}
		}
	}, 60_000).unref();

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

		// MCP endpoint
		if (url.pathname === "/mcp") {
			if (useAuth && !validateBearer(req)) {
				res.writeHead(401, {
					"WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${serverUrl}/.well-known/oauth-protected-resource"`,
				});
				res.end();
				return;
			}

			// Check for existing session
			const sessionId = req.headers["mcp-session-id"] as string | undefined;
			const existing = sessionId ? sessions.get(sessionId) : undefined;
			if (existing) {
				existing.lastActivity = Date.now();
				await existing.transport.handleRequest(req, res);
				return;
			}

			// New session — create fresh server + transport
			if (req.method === "POST") {
				if (sessions.size >= MAX_SESSIONS) {
					res.writeHead(503, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Too many active sessions. Try again later." }));
					return;
				}

				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (id) => {
						sessions.set(id, { transport, lastActivity: Date.now() });
					},
				});

				transport.onclose = () => {
					const id = transport.sessionId;
					if (id) sessions.delete(id);
				};

				const server = createMcpServer();
				await server.connect(transport);
				await transport.handleRequest(req, res);
				return;
			}

			// GET/DELETE without valid session
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No valid session. Send an initialize request first." }));
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
