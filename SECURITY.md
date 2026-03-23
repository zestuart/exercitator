# Security

## Known surfaces

- **intervals.icu API key**: Stored in `.env`, used server-side only. Leaking it grants read/write access to the user's training data.
- **Tailscale funnel exposure**: The MCP server is publicly reachable via the funnel. All endpoints must validate requests.
- **SQLite injection**: All user-supplied parameters must be parameterised in SQL queries.
- **MCP tool input validation**: All tool parameters from Claude must be validated before forwarding to intervals.icu.
- **Docker secrets**: Container environment variables must not be logged or exposed via health/debug endpoints.

## Outstanding

_No outstanding findings._

## Remediated

_No remediated findings yet._
