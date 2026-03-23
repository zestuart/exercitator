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
