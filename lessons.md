# Lessons Learned

Chronological log of bugs, failures, surprises, and insights. Claude maintains this
proactively. Entries are append-only — never edit or remove past entries.

## 2026-03-23 — SAST found five vulnerabilities in initial scaffold

**What happened**: First full SAST scan (Gemini 2.5 Pro) flagged 5 findings: open redirect in OAuth (Critical), global auth lockout DoS (High), unbounded request body (Medium), path traversal via date params (Medium), unbounded session storage (Medium).
**Root cause**: OAuth middleware was ported from internuntius (Python) without applying all the hardening that the original accumulated over time. Date parameters weren't validated. Session management had no limits.
**Fix**: (1) Validate redirect_uri against localhost allowlist. (2) Per-IP lockout instead of global. (3) 64 KiB body size limit on readBody(). (4) Regex date validation + encodeURIComponent on all path-interpolated params. (5) Max 100 sessions + 5-minute idle timeout with periodic pruning.
**Prevention**: SAST scan is mandatory before every deploy. Added date regex validation pattern as standard for all date-accepting tools.

## 2026-03-23 — Claude Desktop connector fails with path mismatches

**What happened**: After deploying to Arca Ingens, Claude Desktop could not connect as a connector. Same issues previously hit in the signifer project.
**Root cause**: Two Claude Desktop behaviours differ from the OAuth/MCP specs: (1) It POSTs to `/` after OAuth completes, not `/mcp` where StreamableHTTPServerTransport listens. (2) It constructs OAuth endpoints as `/authorize`, `/token`, `/register` by appending to the server URL, rather than reading the full paths from RFC 8414 metadata (`/oauth/authorize`, etc.).
**Fix**: (1) Match both `/` and `/mcp` in the MCP request handler. (2) Match both `/oauth/authorize` and `/authorize` (and same for `/token`, `/register`) in the OAuth middleware.
**Prevention**: When implementing MCP OAuth for Claude Desktop connectors, always accept both short and prefixed OAuth paths, and handle `/` as an alias for `/mcp`.
