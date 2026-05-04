# Praescriptor — Implementation Specification

## Overview

Add a web UI to Exercitator that generates daily workout prescriptions for running
and swimming, rendered in the same ritualistic visual style as the existing HTML
prescriptions. The web app runs as a new HTTP entrypoint within the Exercitator
codebase, imports the DSW engine directly (no network calls), and is served
tailnet-only via a dedicated Tailscale `serve` sidecar container.

**Name**: Praescriptor (Latin: "one who prescribes" — the prescription
made manifest)

**Access**: `https://praescriptor.tail7ab379.ts.net` — tailnet only, no funnel, no
public internet exposure.

---

## 1. Architecture

### 1.1 Deployment topology

```
┌─────────────────────────────────────────────────────────────┐
│  Arca Ingens (Docker Compose — exercitator/docker-compose.yml) │
│                                                               │
│  ┌──────────────────┐   ┌──────────────────────────────────┐ │
│  │ exercitator-mcp  │   │ praescriptor                        │ │
│  │ (MCP server)     │   │ (web UI — port 3847)             │ │
│  │ port 8642        │   │ imports engine/ + intervals.ts   │ │
│  └──────────────────┘   └──────────────────────────────────┘ │
│  ┌──────────────────┐   ┌──────────────────────────────────┐ │
│  │ tailscale-       │   │ tailscale-praescriptor              │ │
│  │ exercitator      │   │ hostname: praescriptor              │ │
│  │ (funnel → 8642)  │   │ (serve → praescriptor:3847)         │ │
│  └──────────────────┘   └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

Key points:

- `praescriptor` is a **new container** built from the same Dockerfile as
  `exercitator-mcp`, but with a different entrypoint (`dist/web/server.js`).
  The Dockerfile compiles TypeScript to `dist/` — the production image has
  no `.ts` files or `tsx` runtime.
- It shares the same `INTERVALS_ICU_API_KEY` environment variable.
- It imports the engine directly: `suggestWorkoutForSport()` from
  `src/engine/suggest.ts`, and uses `IntervalsClient` from `src/intervals.ts`.
  Athlete ID defaults to `"0"` (the API key owner) — no configuration needed.
- The Tailscale sidecar uses `tailscale serve` (NOT funnel) so the web UI is
  accessible only within the tailnet.

### 1.2 Why a separate container (not a route on exercitator-mcp)

The existing MCP server handles OAuth, per-session McpServer instantiation, and
MCP-specific HTTP routing. Bolting a web UI onto it would conflate concerns and
risk breaking the MCP protocol handling. A separate container with a simple HTTP
server is cleaner and independently deployable.

### 1.3 Why not a Tailscale Service

Tailscale Services (admin-console-defined, virtual-IP) are designed for
multi-host load balancing and service identity. This is a single-host personal
dashboard. A simple `tailscale serve` sidecar is the correct weight.

---

## 2. New files

### 2.1 `src/web/server.ts`

HTTP server entrypoint for the web UI.

```typescript
// Simple Node.js http server — no Express, no framework dependencies
import { createServer } from "node:http";
import { IntervalsClient } from "../intervals.js";
import { handleRoutes } from "./routes.js";

const PORT = Number.parseInt(process.env.PRAESCRIPTOR_PORT ?? "3847", 10);
const API_KEY = process.env.INTERVALS_ICU_API_KEY;

if (!API_KEY) {
  console.error("INTERVALS_ICU_API_KEY is required");
  process.exit(1);
}

const client = new IntervalsClient({ apiKey: API_KEY });
const server = createServer((req, res) => handleRoutes(req, res, client));
server.listen(PORT, "0.0.0.0", () => {
  console.error(`Praescriptor web UI listening on port ${PORT}`);
});
```

### 2.2 `src/web/routes.ts`

Route handler. Four routes:

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/`  | Serve the prescription page (SSR HTML) |
| `GET`  | `/api/prescriptions` | Return both prescriptions as JSON |
| `POST` | `/api/send/:sport` | Push the specified workout to intervals.icu as a planned event |
| `GET`  | `/health` | Health check — returns 200 |

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntervalsClient } from "../intervals.js";
import { generatePrescriptions } from "./prescriptions.js";
import { sendToIntervals } from "./send.js";
import { renderPage } from "./render.js";

export async function handleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  client: IntervalsClient,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    const prescriptions = await generatePrescriptions(client);
    const html = renderPage(prescriptions);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/prescriptions") {
    const prescriptions = await generatePrescriptions(client);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(prescriptions));
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/send/")) {
    const sport = url.pathname.split("/").pop(); // "run" or "swim"
    const force = url.searchParams.get("force") === "true";
    await sendToIntervals(client, sport as "run" | "swim", res, force);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}
```

### 2.3 `src/web/prescriptions.ts`

Generates both prescriptions by calling the engine twice — once forced to Run,
once forced to Swim — using `suggestWorkoutForSport()` (see §9 for the engine
refactoring that exposes this function).

Results are cached in-memory keyed by date + prescription hash, so the
`/api/send/:sport` endpoint doesn't re-fetch 4 API endpoints on every click.

```typescript
import type { IntervalsClient } from "../intervals.js";
import type { WorkoutSuggestion } from "../engine/types.js";
import { suggestWorkoutForSport } from "../engine/suggest.js";

export interface DualPrescription {
  run: WorkoutSuggestion;
  swim: WorkoutSuggestion;
  generated_at: string; // ISO 8601
}

// In-memory cache: regenerated once per day or when training data changes
let cached: { date: string; prescription: DualPrescription } | null = null;

export async function generatePrescriptions(
  client: IntervalsClient,
): Promise<DualPrescription> {
  const today = new Date().toISOString().slice(0, 10);
  if (cached && cached.date === today) {
    return cached.prescription;
  }

  const [run, swim] = await Promise.all([
    suggestWorkoutForSport(client, "Run"),
    suggestWorkoutForSport(client, "Swim"),
  ]);

  const prescription: DualPrescription = {
    run,
    swim,
    generated_at: new Date().toISOString(),
  };

  cached = { date: today, prescription };
  return prescription;
}

/** Invalidate cache (called after successful send, so a re-check
 *  after training data changes picks up the new state). */
export function invalidateCache(): void {
  cached = null;
}
```

This approach avoids duplicating the pipeline — both `suggestWorkout()` (MCP
tool) and `suggestWorkoutForSport()` (web UI) share the same data-fetching
helper and pipeline steps (see §9).

### 2.4 `src/web/send.ts`

Pushes a workout to intervals.icu as a planned calendar event.

```typescript
import type { IntervalsClient } from "../intervals.js";
import type { ServerResponse } from "node:http";
import { generatePrescriptions, invalidateCache } from "./prescriptions.js";
import type { WorkoutSuggestion, WorkoutSegment } from "../engine/types.js";

// Server-side dedup: track sends per date+sport to prevent duplicate events
const sentToday = new Map<string, string>(); // key: "YYYY-MM-DD-run" → event_id

export async function sendToIntervals(
  client: IntervalsClient,
  sport: "run" | "swim",
  res: ServerResponse,
  force = false,
): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dedupKey = `${today}-${sport}`;

    // Check for duplicate send (unless force=true from confirm dialog)
    if (!force && sentToday.has(dedupKey)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: false,
        duplicate: true,
        event_id: sentToday.get(dedupKey),
        message: "Already sent today — send again?",
      }));
      return;
    }

    const prescriptions = await generatePrescriptions(client);
    const suggestion = sport === "run" ? prescriptions.run : prescriptions.swim;

    const event = {
      category: "WORKOUT",
      start_date_local: `${today}T00:00:00`,
      name: suggestion.title,
      description: buildIntervalsDescription(suggestion),
      type: suggestion.sport,
    };

    const result = await client.post(
      `/athlete/${client.athleteId}/events`,
      event,
    );

    sentToday.set(dedupKey, (result as { id: string }).id);

    // Clear stale dedup entries (previous days)
    for (const key of sentToday.keys()) {
      if (!key.startsWith(today)) sentToday.delete(key);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, event_id: (result as { id: string }).id }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: String(err) }));
  }
}
```

#### `buildIntervalsDescription(suggestion)` — intervals.icu workout text

Convert `WorkoutSegment[]` to intervals.icu workout description syntax.

**Rules for generating intervals.icu workout text:**

- Each step is a line starting with `- `
- Duration: use `m` for minutes, `s` for seconds (e.g. `5m`, `30s`, `5m30s`)
- Power targets: percentage of FTP (e.g. `55-75%`) or watts (e.g. `160-219W`)
- HR targets: percentage with `HR` suffix (e.g. `70% HR`)
- Pace targets: `mm:ss/km Pace` for running, `mm:ss/100m Pace` for swimming
- Repeats: `Nx` on its own line, followed by indented steps
- Free text is allowed before targets (becomes the step name/cue)

**Example output for a Z2 base run:**
```
Warm-up
- 5m 50%
- 5m ramp 50-55%
Main set
- 30m 55-75%
Cool-down
- 5m 50%
- 5m 40%
```

**Example output for swim intervals:**
```
Warm-up
- 300mtr 80% Pace
Main set
8x
- 100mtr 110% Pace
- 15s rest
Easy
- 200mtr 80% Pace
Speed
4x
- 50mtr 120% Pace
- 30s rest
Cool-down
- 200mtr 75% Pace
```

**Implementation strategy:**

For each `WorkoutSegment`:
1. If `repeats` is set, emit `{repeats}x` then the work and rest steps
2. Otherwise emit a single step with duration and target
3. Use power targets (as % of FTP or W) for running when power context is available
4. Use pace targets (as % of threshold) for swimming
5. Fall back to HR zone targets when neither power nor pace is available
6. Prepend the segment `name` as a section header (plain text line, no `-`)

**Validation:** After generating the description text, verify it could be
pasted into the intervals.icu workout builder and parsed correctly. The
format is well-documented at
https://forum.intervals.icu/t/workout-builder-syntax-quick-guide/123701

### 2.5 `src/web/render.ts`

Server-side HTML rendering. Produces a single self-contained HTML page with:
- Inlined CSS (same design system as the existing prescription)
- Inlined JavaScript for the "Send to intervals.icu" button interactions
- No external JS dependencies (vanilla JS, fetch API)

See §3 for the complete UI specification.

### 2.6 `src/web/invocations.ts`

Deity invocation text generator. Each prescription includes an opening
invocation and closing blessing, matched to sport and workout category.

**Deity assignments:**

| Role | Deity | Domain |
|------|-------|--------|
| Running patron | **Diana** | Goddess of the body in motion |
| Swimming patron | **Amphitrite** | Queen of the sea, calm waters, rhythmic flow |
| Data & measurement | **Apollo** | Closing blessing — let the data confirm |
| Strategy & rationale | **Minerva** | Rationale section header |

**Invocation generation:**

Each invocation should be contextual — referencing the workout category, the
readiness state, and any warnings. The invocations follow the style established
in the existing prescription:

- Opening: italic, Cormorant Garamond, gold on dark, left-bordered block
- Deity names: bold, non-italic, slightly letter-spaced
- Tone: classical, measured, never ironic, never performative piety
- Content: always relevant to the actual prescription (not generic)

```typescript
interface Invocations {
  opening: string;   // Before Diana/Amphitrite...
  rationale_header: string; // "Rationale · Under Minerva's Counsel"
  closing: string;   // Measured by Apollo...
}

function generateInvocations(
  sport: "Run" | "Swim",
  category: WorkoutCategory,
  readinessScore: number,
  warnings: string[],
): Invocations;
```

**The invocation text should be generated by the Anthropic API** via a
`fetch` call from the server to `https://api.anthropic.com/v1/messages`.
This keeps the invocations fresh and contextually relevant rather than
using a static template bank.

**Prompt structure for invocation generation:**
- System: "You are a liturgical voice for an athlete's training system. Write
  invocations in the style of classical Roman religious address. British English.
  No exclamation marks. No emojis. 2-3 sentences maximum per invocation."
- User: Provide the sport, category, readiness score, warnings, and which
  invocation slot (opening/closing) to generate.
- Model: `claude-sonnet-4-6`
- Max tokens: 200

**Fallback:** If the API call fails (network error, rate limit), use a static
fallback invocation per sport. Never block page rendering on invocation
generation — generate invocations in parallel with the page and fall back if
they're not ready.

**Caching:** Cache invocations for the current day + prescription hash.
If the same prescription would be generated again (same readiness state,
same category), serve the cached invocations. Store in-memory (Map) — no
persistence needed, the container restarts daily anyway.

---

## 3. UI specification

### 3.1 Page structure

The page displays two prescription cards side-by-side (stacked on mobile),
each containing the full prescription layout from the existing HTML template.

```
┌─────────────────────────────────────────────────────────────┐
│  PRAESCRIPTOR · YYYY-MM-DD · DAY_NAME                         │
│                                                             │
│  ┌──────────────────────┐  ┌──────────────────────────────┐ │
│  │  RUN PRESCRIPTION    │  │  SWIM PRESCRIPTION           │ │
│  │                      │  │                              │ │
│  │  [Sport tag]         │  │  [Sport tag]                 │ │
│  │  Title               │  │  Title                       │ │
│  │  Subtitle            │  │  Subtitle                    │ │
│  │                      │  │                              │ │
│  │  [Invocation]        │  │  [Invocation]                │ │
│  │                      │  │                              │ │
│  │  [Readiness context] │  │  [Readiness context]         │ │
│  │                      │  │                              │ │
│  │  [Segments]          │  │  [Segments]                  │ │
│  │                      │  │                              │ │
│  │  [Targets summary]   │  │  [Targets summary]           │ │
│  │                      │  │                              │ │
│  │  [Rationale]         │  │  [Rationale]                 │ │
│  │                      │  │                              │ │
│  │  [Closing blessing]  │  │  [Closing blessing]          │ │
│  │                      │  │                              │ │
│  │  [Send to i.icu btn] │  │  [Send to i.icu btn]        │ │
│  └──────────────────────┘  └──────────────────────────────┘ │
│                                                             │
│  ◇                                                          │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Design system

Inherit the complete CSS design system from the existing prescription HTML:

```css
:root {
  --bg: #0a0a0c;
  --surface: #111114;
  --border: #1e1e24;
  --gold: #c9a84c;
  --gold-dim: #8a7234;
  --gold-glow: rgba(201, 168, 76, 0.12);
  --silver: #a8a8b0;
  --text: #d4d4d8;
  --text-dim: #71717a;
  --z2: #2d8a4e;          /* Green for Z2/base */
  --z2-glow: rgba(45, 138, 78, 0.15);
  --warn: #b45309;
  --font-display: 'Cormorant Garamond', serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```

**Sport-specific accent colours:**

- Running: `--z2` green (existing)
- Swimming: introduce `--swim: #2d6e8a` (a teal-blue) and
  `--swim-glow: rgba(45, 110, 138, 0.15)` for the swim card's accent.
  This differentiates the two cards visually while maintaining the same
  dark palette.

**Fonts:** Load from Google Fonts (already used in existing prescription):
- Cormorant Garamond (display, invocations, deity names)
- JetBrains Mono (data, metrics, targets, body)

### 3.3 "Send to intervals.icu" button

Each card has a button at the bottom:

```
┌────────────────────────────────────┐
│  ↗  Send to intervals.icu         │
└────────────────────────────────────┘
```

**Visual states:**
- Default: outlined, `--border` border, `--text-dim` text
- Hover: `--gold-dim` border, `--gold` text
- Loading: text changes to "Sending…", button disabled
- Success: text changes to "✓ Sent", `--z2` border and text, stays for 3s
  then resets to "↗ Send to intervals.icu"
- Error: text changes to "✗ Failed — try again", `--warn` border and text,
  stays for 5s then resets

**Behaviour:**
1. On click, `POST /api/send/run` or `POST /api/send/swim`
2. The server generates the prescription fresh (not cached), converts to
   intervals.icu workout text, and pushes via the `create_event` API
3. Response indicates success/failure

**Duplicate prevention:** Server-side dedup returns HTTP 409 if the same
sport has already been sent today. The client JS handles 409 by showing a
confirm dialog ("Already sent — send again?"). If confirmed, re-sends with
`?force=true` to bypass the dedup check. After a successful send, the button
text becomes "✓ Sent to calendar" and remains in that state.

### 3.4 Readiness context block

Shared between both cards (readiness is athlete-level, not sport-specific).
Display once at the top of the page, above the two cards, or duplicated in
each card with identical data.

**Decision:** Duplicate in each card. This makes each card self-contained
for screenshots/sharing and avoids layout complexity.

### 3.5 Responsive layout

- **Desktop (>960px):** Two cards side-by-side, `max-width: 1400px`
- **Tablet (520–960px):** Two cards stacked vertically, full width
- **Mobile (<520px):** Single column, same as existing prescription mobile

### 3.6 Loading state

The page is server-side rendered — the HTML arrives fully populated.
No client-side loading spinners needed for initial render. The only
client-side interaction is the "Send" button.

---

## 4. Docker Compose additions

Add to `docker-compose.yml`:

```yaml
  praescriptor:
    build: .
    container_name: praescriptor
    restart: unless-stopped
    entrypoint: ["node", "dist/web/server.js"]
    expose:
      - "3847"
    environment:
      - INTERVALS_ICU_API_KEY=${INTERVALS_ICU_API_KEY:?required}
      - PRAESCRIPTOR_PORT=3847
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
    healthcheck:
      test: ["CMD", "node", "-e", "const s=require('net').createConnection(3847,'localhost');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"]
      interval: 60s
      timeout: 3s
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 256m
          cpus: "0.5"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  tailscale-praescriptor:
    container_name: tailscale-praescriptor
    image: tailscale/tailscale:latest
    hostname: praescriptor
    restart: unless-stopped
    volumes:
      - praescriptor-tailscale-state:/var/lib/tailscale
      - ./tailscale-config-praescriptor:/config:ro
    environment:
      - TS_AUTHKEY=${TAILSCALE_AUTH_KEY}
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_USERSPACE=true
      - TS_SERVE_CONFIG=/config/serve.json
```

Add to volumes section:

```yaml
  praescriptor-tailscale-state:
    name: praescriptor-tailscale-state
    external: true
```

**Note:** The volume must be created before first deploy:
```bash
docker volume create praescriptor-tailscale-state
```

### 4.1 Tailscale serve config

Create `tailscale-config-praescriptor/serve.json`:

```json
{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "praescriptor.tail7ab379.ts.net:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://praescriptor:3847"
        }
      }
    }
  }
}
```

**Critical:** No `AllowFunnel` key. This keeps the service tailnet-only.
The existing `exercitator` sidecar uses `AllowFunnel: true` because it needs
public access for Claude MCP connectors. Praescriptor does not.

### 4.2 Networking

Both `praescriptor` and `tailscale-praescriptor` must be on the same Docker network
so the Tailscale sidecar can proxy to the web server. Docker Compose's default
network handles this — all services in the same compose file share a network.

The `tailscale-praescriptor` sidecar needs `network_mode: service:praescriptor` OR
must be able to resolve `praescriptor` by container name. The existing exercitator
pattern uses container name resolution (not network_mode), so follow that
pattern.

---

## 5. Environment variables

Add to `.env.example`:

```bash
# Optional: Anthropic API key for dynamic deity invocations
# If not set, static fallback invocations are used
ANTHROPIC_API_KEY=your-anthropic-api-key-here
```

The `ANTHROPIC_API_KEY` is optional. Without it, invocations fall back to
static text. This keeps the deployment functional even without it.

---

## 6. Tests

### 6.1 `tests/web/prescriptions.test.ts`

1. Mock `IntervalsClient` with existing fixture data.
2. Verify `generatePrescriptions()` returns both `run` and `swim` suggestions.
3. Verify both have non-empty segments (unless category is `rest`).
4. Verify `generated_at` is a valid ISO 8601 timestamp.

### 6.2 `tests/web/send.test.ts`

1. Mock `IntervalsClient` — verify `client.post()` is called with correct
   path and body shape.
2. Verify the `description` field contains valid intervals.icu workout text.
3. Verify the `type` field is `"Run"` or `"Swim"`.
4. Verify the `category` is `"WORKOUT"`.

### 6.3 `tests/web/intervals-format.test.ts`

1. Given a `WorkoutSuggestion` with power targets, verify the generated
   intervals.icu text contains `W` or `%` targets.
2. Given a swim `WorkoutSuggestion`, verify the text contains `/100m Pace`
   or `% Pace` targets.
3. Given a recovery run, verify the output is parseable (no syntax errors).
4. Given interval repeats, verify the `Nx` format is correct.
5. Verify no line exceeds reasonable length.

### 6.4 `tests/web/invocations.test.ts`

1. Verify static fallback invocations are returned when no API key is set.
2. Verify invocations reference the correct deity for each sport.
3. Verify invocations are non-empty strings.

---

## 7. Implementation sequence

Execute in this order. Run `/test` after each step.

1. Create `src/web/server.ts` — minimal HTTP server, health endpoint only.
2. Create `src/web/prescriptions.ts` — extract pipeline from `suggestWorkout`
   to support forced sport selection. Refactor `src/engine/suggest.ts` to
   export a `suggestWorkoutForSport(client, sport)` variant, then use it
   from both the MCP tool and the web UI. Avoid code duplication.
3. Create `tests/web/prescriptions.test.ts` — verify dual generation works.
4. Create `src/web/send.ts` + `src/web/intervals-format.ts` — the
   intervals.icu workout text formatter and the send-to-calendar handler.
5. Create `tests/web/send.test.ts` + `tests/web/intervals-format.test.ts`.
6. Create `src/web/invocations.ts` — deity text generator with API + fallback.
7. Create `tests/web/invocations.test.ts`.
8. Create `src/web/render.ts` — SSR HTML renderer using the design system.
9. Wire up `src/web/routes.ts` with all handlers.
10. Create `tailscale-config-praescriptor/serve.json`.
11. Update `docker-compose.yml` with `praescriptor` and `tailscale-praescriptor`.
12. Update `.env.example` with `ANTHROPIC_API_KEY`.
13. Update `README.md` with Praescriptor documentation.
14. Update `CHANGELOG.md`.
15. Run `/test` for final validation.

---

## 8. Design constraints

- **No new runtime dependencies.** The web server uses Node.js `http` module.
  HTML rendering is string concatenation/template literals. No React, no
  Express, no template engines. This matches the zero-dependency philosophy
  of the engine.
- **Follows existing patterns.** File structure mirrors the existing codebase.
  TypeScript strict mode. Biome-clean. British English. ISO 8601 dates.
- **Shared code, not shared process.** The web UI imports engine code at the
  TypeScript level but runs as a separate container/process. The engine must
  remain a pure-function library with no side effects.
- **Tailnet-only.** The serve config must NOT include `AllowFunnel`. The
  web UI is personal and should not be publicly accessible.
- **Graceful degradation.** If the intervals.icu API is down, the page should
  show a clear error state, not crash. If the Anthropic API is unavailable,
  static invocations are used.
- **No client-side framework.** Vanilla JS for the send button. No build step
  for client code.

---

## 9. Engine refactoring

To support forced sport selection without duplicating the pipeline, refactor
`src/engine/suggest.ts` in two steps.

### 9.1 Extract `fetchTrainingData` helper

Both `suggestWorkout` (MCP) and `generatePrescriptions` (web) need the same
4 API calls. Extract them into a shared helper to prevent drift:

```typescript
export interface TrainingData {
  activities: ActivitySummary[];
  wellness: WellnessRecord[];
  runSettings: SportSettings;
  swimSettings: SportSettings;
}

export async function fetchTrainingData(
  client: IntervalsClient,
): Promise<TrainingData> {
  const now = new Date();
  const d14Ago = new Date(now.getTime() - 14 * 86_400_000);
  const d7Ago = new Date(now.getTime() - 7 * 86_400_000);

  const [activities, wellness, runSettings, swimSettings] = await Promise.all([
    client.get<ActivitySummary[]>(`/athlete/${client.athleteId}/activities`, {
      oldest: dateStr(d14Ago), newest: dateStr(now),
    }),
    client.get<WellnessRecord[]>(`/athlete/${client.athleteId}/wellness`, {
      oldest: dateStr(d7Ago), newest: dateStr(now),
    }),
    client.get<SportSettings>(`/athlete/${client.athleteId}/sport-settings/Run`)
      .catch((): SportSettings => ({ type: "Run", ...DEFAULT_SPORT_SETTINGS })),
    client.get<SportSettings>(`/athlete/${client.athleteId}/sport-settings/Swim`)
      .catch((): SportSettings => ({ type: "Swim", ...DEFAULT_SPORT_SETTINGS })),
  ]);

  return { activities, wellness, runSettings, swimSettings };
}
```

### 9.2 Extract `suggestWorkoutForSport`

The core pipeline with a fixed sport:

```typescript
export function suggestWorkoutForSportFromData(
  data: TrainingData,
  sport: "Run" | "Swim",
  now: Date = new Date(),
  sportSelectionReason?: string,
): WorkoutSuggestion {
  const { activities, wellness, runSettings, swimSettings } = data;
  const powerContext = detectPowerSource(activities);
  const readiness = computeReadiness(wellness, activities, now);
  const staleness = computeStaleness(activities, sport, now);
  const readinessCategory = selectWorkoutCategory(
    readiness.score, activities, sport, now, powerContext,
  );
  const category = applyStaleness(readinessCategory, staleness.tier);
  const terrainSelection = selectTerrain(category, activities, now, sport);
  const settings = sport === "Run" ? runSettings : swimSettings;
  const latestCtl = wellness.length > 0
    ? (wellness[wellness.length - 1].ctl ?? 20) : 20;
  const workout = buildWorkout(
    category, sport, settings, readiness.score, latestCtl,
    powerContext, staleness.paceBufferSecs, staleness.hrOnly,
  );
  const warnings = [
    ...readiness.warnings, ...powerContext.warnings, ...staleness.warnings,
  ];
  return {
    ...workout,
    readiness_score: readiness.score,
    sport_selection_reason: sportSelectionReason ?? `Forced: ${sport}`,
    terrain: terrainSelection.terrain,
    terrain_rationale: terrainSelection.rationale,
    power_context: powerContext,
    warnings,
  };
}
```

### 9.3 Convenience wrapper (fetches data then runs pipeline)

```typescript
export async function suggestWorkoutForSport(
  client: IntervalsClient,
  sport: "Run" | "Swim",
): Promise<WorkoutSuggestion> {
  const data = await fetchTrainingData(client);
  return suggestWorkoutForSportFromData(data, sport);
}
```

### 9.4 Rewrite `suggestWorkout` to use the same helpers

```typescript
export async function suggestWorkout(
  client: IntervalsClient,
): Promise<WorkoutSuggestion> {
  const data = await fetchTrainingData(client);
  const now = new Date();
  const powerContext = detectPowerSource(data.activities);
  const readiness = computeReadiness(data.wellness, data.activities, now);
  const sportSelection = selectSport(
    data.activities, readiness.score, now, powerContext,
  );
  return suggestWorkoutForSportFromData(
    data, sportSelection.sport, now, sportSelection.reason,
  );
}
```

This is the **minimal refactor** — it avoids duplicating the pipeline while
keeping the existing `suggestWorkout` MCP tool working unchanged. The
`sport_selection_reason` for auto-selected sport comes from `selectSport`;
for forced sport it says `"Forced: Run"` or `"Forced: Swim"`.

---

## 10. Deployment procedure

After implementation:

```bash
# 1. Create Tailscale state volume (first time only)
docker volume create praescriptor-tailscale-state

# 2. Deploy (same as existing exercitator deploy, but build both services)
tar czf /tmp/exercitator.tar.gz --exclude='.git' --exclude='node_modules' \
  --exclude='dist' --exclude='data' --exclude='.env' --exclude='phase2' \
  --exclude='.claude/settings.local.json' .

sshpass -f /tmp/.qnap_pass scp -P 2022 /tmp/exercitator.tar.gz \
  dominus@192.168.4.180:/share/Container/exercitator/

sshpass -f /tmp/.qnap_pass ssh -p 2022 dominus@192.168.4.180 \
  'cd /share/Container/exercitator && tar xzf exercitator.tar.gz && rm exercitator.tar.gz && \
   export PATH=/share/CE_CACHEDEV1_DATA/.qpkg/container-station/usr/bin/.libs:$PATH && \
   docker compose up -d --build praescriptor tailscale-praescriptor'
```

The `ANTHROPIC_API_KEY` must be added to the `.env` file on Arca Ingens before
deploy. The `TAILSCALE_AUTH_KEY` is shared with the existing exercitator
sidecar.

---

## 11. Security considerations

- **No authentication on the web UI.** Tailscale serve provides tailnet-level
  access control. Only devices on the tailnet can reach `praescriptor.tail7ab379.ts.net`.
  This is a single-user personal tool — no additional auth layer needed.
- **Tailscale identity headers.** When using `tailscale serve`, the proxy adds
  `Tailscale-User-Login`, `Tailscale-User-Name`, and
  `Tailscale-User-Profile-Pic` headers. The web server can log these for
  audit but does not need to validate them for a single-user deployment.
- **intervals.icu API key.** Same key as the MCP server, injected via
  environment variable. Never exposed to the client — all API calls are
  server-side.
- **Anthropic API key.** Optional, server-side only. Never sent to the client.
  Must be added to CLAUDE.md security surfaces section during implementation.
- **Send dedup.** Server-side Map prevents duplicate calendar events. Returns
  HTTP 409 on duplicate with `?force=true` override. Stale entries (previous
  days) are cleaned on each send.
- **CORS.** Not needed — all requests are same-origin (the SSR page makes
  fetch calls to the same host).

---

## 12. Future enhancements (out of scope for v1)

- **Workout history.** Show the last N prescriptions with what was actually
  executed (compare planned vs actual).
- **Manual overrides.** Let the user adjust category or duration before sending.
- **Multi-day view.** Generate a 3–5 day lookahead.
- **Strength prescription.** Add a third card for strength/mobility work.
- **Auto-refresh.** WebSocket or SSE for live readiness updates (e.g. when
  new wellness data syncs from Garmin).
