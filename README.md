# Exercitator

MCP bridge for Claude to access the [intervals.icu](https://intervals.icu) API.

Exercitator exposes intervals.icu data — activities, wellness, calendar events,
athlete profile — as MCP tools that Claude can call directly. Deployed on Arca
Ingens via Docker Compose with a Tailscale funnel for public HTTPS access.

## MCP tools

| Tool | Description |
|------|-------------|
| `get_athlete_profile` | Athlete profile, sport settings, training zones |
| `get_sport_settings` | Per-sport zones, FTP, LTHR, threshold pace |
| `list_activities` | Recent activities with date range and sport filter |
| `get_activity` | Full details of a specific activity |
| `get_activity_streams` | Raw data streams (power, HR, cadence, etc.) |
| `get_power_curve` | Power duration curve for an activity |
| `get_wellness` | Wellness data (weight, resting HR, HRV, sleep, mood) |
| `update_wellness` | Update wellness data for a date |
| `list_events` | Calendar events (planned workouts, notes, races) |
| `create_event` | Create a calendar event |

## Quick start

### Local development (stdio)

```bash
cp .env.example .env    # fill in INTERVALS_ICU_API_KEY
npm install
npm run dev             # runs via tsx on stdio transport
```

Add to Claude Code:
```bash
claude mcp add --transport stdio exercitator -- npm run dev
```

### Production (Docker + Tailscale funnel)

```bash
cp .env.example .env    # fill in all credentials
docker volume create exercitator-tailscale-state
docker compose up -d --build
```

Then add `https://exercitator.tail7ab379.ts.net` as a connector in Claude Desktop.

## Authentication

In **stdio** mode (local dev), no authentication is required.

In **streamable-http** mode (production), OAuth is enabled when `MCP_OAUTH_CLIENT_SECRET` and `MCP_OAUTH_AUTHORIZE_PASSPHRASE` are set. The middleware implements:

- PKCE S256 + client_credentials grant types
- Passphrase-gated authorisation (human-memorable, entered via browser)
- Self-validating HMAC-SHA256 signed tokens (72-hour TTL)
- Version-based token revocation (increment `MCP_TOKEN_VERSION`)
- Per-IP rate limiting and lockout

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INTERVALS_ICU_API_KEY` | Yes | intervals.icu API key (Settings > Developer Settings) |
| `MCP_TRANSPORT` | No | `stdio` (default) or `streamable-http` |
| `MCP_HOST` | No | Bind address (default `127.0.0.1`) |
| `MCP_PORT` | No | Listen port (default `8642`) |
| `MCP_SERVER_URL` | No | Public URL for OAuth metadata (default `http://localhost:8642`) |
| `MCP_OAUTH_CLIENT_ID` | No | OAuth client ID (default `exercitator`) |
| `MCP_OAUTH_CLIENT_SECRET` | Prod | OAuth signing secret — `openssl rand -hex 32` |
| `MCP_OAUTH_AUTHORIZE_PASSPHRASE` | Prod | Human-memorable passphrase for auth gate |
| `MCP_TOKEN_VERSION` | No | Increment to revoke all tokens (default `1`) |
| `TAILSCALE_AUTH_KEY` | Prod | Tailscale auth key for funnel sidecar |
| `GEMINI_API_KEY` | Deploy | Gemini API key for SAST scanner |

## Requirements

- Node.js 20+
- Python 3.8+ (for the SAST scanner)
- A Gemini API key (free at https://aistudio.google.com/apikey)
- An intervals.icu API key (Settings > Developer Settings)
- Docker + Docker Compose (for production deployment)

## The name

Latin: *exercitator* — a trainer, one who exercises. From *exercitare*, to train
vigorously. The bridge that lets Claude become your training data analyst.

## Licence

MIT
