# Exercitator

Three surfaces over the [intervals.icu](https://intervals.icu) API, sharing one engine and one SQLite cache:

- **MCP server** — exposes intervals.icu data and a daily-suggested-workout engine to Claude. Public via Tailscale funnel.
- **Praescriptor** — web UI rendering daily Run + Swim prescriptions with deity invocations and traffic-light compliance dots. Tailnet-only.
- **HTTP API** — JSON REST surface for native clients (Excubitor iOS / watchOS). Tailnet-only, bearer-scoped per user.

Deployed on Cogitator (Mac Mini M4 Pro) via Docker Compose; see `CLAUDE.md` § Deployment for the full operational reference.

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
| `suggest_workout` | Daily personalised workout (Run or Swim) with power source detection, terrain guidance, and dual-target prescription (power + HR cap) |
| `submit_cross_training_rpe` | Submit RPE (1–10) for a cross-training activity to unblock prescription gating |
| `get_compliance_summary` | Completion rate, compliance rate, category breakdown, weekly trends |
| `get_compliance_detail` | Per-segment pass/fail with actuals vs targets |

## HTTP API endpoints

Tailnet-only at `https://exercitator-api.tail7ab379.ts.net`. Pass `Authorization: Bearer <client>:<userId>:<token>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service + upstream reachability (unauthenticated) |
| `GET` | `/api/users/:userId/status` | Readiness, CP, fitness/fatigue/form, last workout, injury warning |
| `GET` | `/api/users/:userId/workouts/today` | Today's scheduled + completed workouts |
| `GET` | `/api/users/:userId/workouts/suggested` | Engine-generated prescription (`?sport=Run\|Swim\|auto`) |
| `GET` | `/api/users/:userId/workouts/:id` | Workout detail |
| `GET` | `/api/users/:userId/dashboard` | `/status` + `/workouts/today` + `/workouts/suggested` aggregate |
| `GET` | `/api/users/:userId/compliance/summary` | Weekly + monthly compliance trends |
| `GET` | `/api/users/:userId/compliance/detail` | Per-prescription detail for a date range |
| `POST` | `/api/users/:userId/cross-training/:activityId/rpe` | Submit RPE to unblock 409 awaiting_input |

Full wire contract: `phase2/exercitator-http-api-spec.md`.

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

### Production (Docker + Tailscale on Cogitator)

```bash
cp .env.example .env    # fill in all credentials including EXERCITATOR_API_KEYS
docker volume create exercitator-data
docker volume create exercitator-tailscale-state
docker volume create praescriptor-tailscale-state
docker volume create exercitator-api-tailscale-state
docker compose up -d --build
```

Then add `https://exercitator.tail7ab379.ts.net` as a connector in Claude Desktop and enter the shared passphrase when prompted. The HTTP API and Praescriptor become reachable at `https://exercitator-api.tail7ab379.ts.net` and `https://praescriptor.tail7ab379.ts.net` respectively.

### Deploying updates to Cogitator

```bash
# Tarball → upload → rebuild (key auth via ~/.ssh/id_ed25519)
tar czf /tmp/exercitator.tar.gz --exclude='.git' --exclude='node_modules' \
  --exclude='dist' --exclude='data' --exclude='.env' --exclude='phase2' .
scp /tmp/exercitator.tar.gz dominus@cogitator.tail7ab379.ts.net:~/Container/exercitator/
ssh dominus@cogitator.tail7ab379.ts.net \
  'cd ~/Container/exercitator && tar xzf exercitator.tar.gz && rm exercitator.tar.gz && \
   zsh -ic "docker compose up -d --build exercitator praescriptor"'
```

See CLAUDE.md § Deployment for the full procedure (incl. keychain unlock for non-interactive SSH).

## Authentication

In **stdio** mode (local dev), no authentication is required.

In **streamable-http** mode (production MCP), OAuth is enabled when `MCP_OAUTH_CLIENT_SECRET` and `MCP_OAUTH_AUTHORIZE_PASSPHRASE` are set. The middleware implements:

- PKCE S256 for browser-based flow (Claude Desktop, claude.ai connectors)
- client_credentials grant for programmatic access (Claude Code)
- Passphrase-gated authorisation (human-memorable, entered via browser)
- Self-validating HMAC-SHA256 signed tokens (72-hour TTL)
- Version-based token revocation (increment `MCP_TOKEN_VERSION`)
- Per-IP rate limiting and lockout
- Redirect URIs: `https://claude.ai/api/mcp/auth_callback`, `http://localhost`, `http://127.0.0.1`

The **HTTP API** uses bearer tokens scoped `<client>:<userId>:<token>` instead — constant-time compare, cross-user reads return 403. Tailnet membership is the outer access gate.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INTERVALS_ICU_API_KEY` | Yes | intervals.icu API key for Ze (Settings > Developer Settings) |
| `INTERVALS_ICU_API_KEY_PAM` | No | Secondary athlete API key for Pam |
| `STRYD_EMAIL` / `STRYD_PASSWORD` | No | Stryd PowerCenter credentials (Ze) — enables FIT enrichment + Vigil + direct CP |
| `STRYD_EMAIL_PAM` / `STRYD_PASSWORD_PAM` | No | Stryd credentials (Pam) |
| `ANTHROPIC_API_KEY` | No | Claude API for deity invocations in Praescriptor |
| `EXERCITATOR_API_KEYS` | No | Comma-separated `<client>:<userId>:<token>` triples; if unset, HTTP API listener stays disabled |
| `EXERCITATOR_API_BIND_ADDR` | No | Default `0.0.0.0:8643` |
| `MCP_TRANSPORT` | No | `stdio` (default) or `streamable-http` |
| `MCP_HOST` / `MCP_PORT` | No | Bind address / port for MCP (defaults `127.0.0.1` / `8642`) |
| `MCP_SERVER_URL` | No | Public URL for OAuth metadata |
| `MCP_OAUTH_CLIENT_ID` | No | OAuth client ID (default `exercitator`) |
| `MCP_OAUTH_CLIENT_SECRET` | Prod | OAuth signing secret — `openssl rand -hex 32` |
| `MCP_OAUTH_AUTHORIZE_PASSPHRASE` | Prod | Human-memorable passphrase for auth gate |
| `MCP_TOKEN_VERSION` | No | Increment to revoke all tokens (default `1`) |
| `TAILSCALE_AUTH_KEY` | Prod | Tailscale auth key (reusable, preauthorised) — works for all three sidecars |
| `cogitatorPass` | Deploy | Cogitator login password (also unlocks login keychain for `docker compose build` over non-interactive SSH); key auth is preferred |
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
