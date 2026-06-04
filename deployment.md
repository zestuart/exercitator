# Deployment

Subsidiary to `CLAUDE.md`. Operational reference for shipping Exercitator + Praescriptor to Cogitator.

## Target

- **Host**: Cogitator (Mac Mini M4 Pro) — `dominus@cogitator.tail7ab379.ts.net` (tailnet) or `dominus@192.168.4.192` (LAN). Key auth via `~/.ssh/id_ed25519`; password fallback in `.env` as `cogitatorPass`. Services migrated from Arca Ingens 2026-04-04.
- **Path on server**: `~/Container/exercitator/` (i.e. `/Users/dominus/Container/exercitator/`). `.env` lives here and is managed out-of-band.
- **Docker**: Colima VM, `DOCKER_HOST=unix:///Users/dominus/.colima/docker.sock`. Non-interactive SSH does not source `~/.zshrc` — wrap docker commands in `zsh -ic "..."`. Only `$HOME` is mounted into the VM; don't use `/tmp` for bind mounts or build contexts.
- **Method**: Tarball upload + `docker compose up -d --build`. Same pattern as Arca Ingens, different host/port/path.
- **Branch**: `main` — deploy from main only.

## Networking

- `exercitator.tail7ab379.ts.net` (funnel-enabled) → `exercitator-mcp:8642` — MCP, public.
- `praescriptor.tail7ab379.ts.net` (tailnet-only) → `praescriptor-web:3847` — web UI.
- `exercitator-api.tail7ab379.ts.net` (tailnet-only) → `exercitator-mcp:8643` — HTTP API, co-resident with MCP.

## Containers and volumes

- **Containers**: `exercitator-mcp` (MCP server + HTTP API on 8643) + `tailscale-exercitator` (funnel sidecar) + `praescriptor-web` (web UI) + `tailscale-praescriptor` (serve sidecar) + `exercitator-api-ts` (serve sidecar for HTTP API).
- **Volumes**: `exercitator-data` (SQLite), `exercitator-tailscale-state` (external), `praescriptor-tailscale-state` (external), `exercitator-api-tailscale-state` (external). Do not delete external volumes — Tailscale node identity lives in them. Pre-create the API state volume on Cogitator once: `ssh dominus@cogitator.tail7ab379.ts.net 'zsh -ic "docker volume create exercitator-api-tailscale-state"'`.
- **Tailscale auth key**: exercitator family — reusable, preauthorised; works for all three sidecars. The key value lives only in `.env` and `praefectura/docs/tailscale.md` — never echo it (or any prefix of it) into source-controlled docs.
- **Operations reference**: full Cogitator conventions in `github.com/zestuart/praefectura` (`docs/cogitator-operations.md`, `docs/exercitator.md`, `docs/tailscale.md`).

## Deploy procedure

```bash
# 1. Load cogitator password (only needed if key auth fails)
CP=$(grep '^cogitatorPass=' .env | cut -d= -f2-)

# 2. Tarball (exclude git, node_modules, .env, data, dist, phase2)
tar czf /tmp/exercitator.tar.gz --exclude='.git' --exclude='node_modules' \
  --exclude='dist' --exclude='data' --exclude='.env' --exclude='phase2' \
  --exclude='.claude/settings.local.json' .

# 3. Upload and extract (key auth)
scp /tmp/exercitator.tar.gz dominus@cogitator.tail7ab379.ts.net:~/Container/exercitator/
ssh dominus@cogitator.tail7ab379.ts.net \
  'cd ~/Container/exercitator && tar xzf exercitator.tar.gz && rm exercitator.tar.gz'

# 4. Unlock keychain, then rebuild (non-interactive SSH needs zsh -ic for docker)
ssh dominus@cogitator.tail7ab379.ts.net "security unlock-keychain -p '$CP' ~/Library/Keychains/login.keychain-db && \
  cd ~/Container/exercitator && zsh -ic 'docker compose up -d --build exercitator praescriptor'"

# 5. Verify services
curl -s https://exercitator.tail7ab379.ts.net/health
curl -s https://praescriptor.tail7ab379.ts.net/health
curl -s https://exercitator-api.tail7ab379.ts.net/api/health

# 6. Clean up
rm -f /tmp/exercitator.tar.gz
```

## Pre-flight sequence (enforced by `/deploy`)

1. **Lint + type check** — language-appropriate static analysis
2. **Test suite** — all tests must pass
3. **Secret scan** — verify no credentials in staged files
4. **SAST scan** — Gemini security review of changed files (diff mode against current `sast-baseline-*` tag)
5. **Documentation check** — `CHANGELOG.md` updated, docs current
6. **Env forwarding check** — every new `process.env.X` read must have a paired entry in **every consuming service's `docker-compose.yml environment:` block**. The FORM-deploy missed this on 2026-05-26 (FORM_EMAIL/PASSWORD set in `.env` but unread by the container); see `lessons.md` 2026-05-26 entry.
7. **Commit** — descriptive message with co-author attribution
8. **Push** — to configured branch/remote
9. **Monitor** — verify deployment status; tail container logs for the new code path's startup line ("X client ready" / "X credentials not set") before declaring victory.

## Environment variables forwarded into containers

`docker-compose.yml` declares each env var explicitly in the `environment:` block of every consuming service. Both `exercitator` (MCP + HTTP API) and `praescriptor` (web UI) consume the user-facing creds; sidecars consume only Tailscale auth. Source of truth is Cogitator's `~/Container/exercitator/.env` (gitignored).

| Var | Required? | Consumer(s) | Purpose |
|---|---|---|---|
| `INTERVALS_ICU_API_KEY` | yes | exercitator, praescriptor | ze's intervals.icu API key |
| `INTERVALS_ICU_API_KEY_PAM` | optional | exercitator, praescriptor | pam's intervals.icu API key (route returns 503 if unset) |
| `STRYD_EMAIL` / `STRYD_PASSWORD` | optional | exercitator, praescriptor | ze's Stryd PowerCenter creds — drives Stryd enrichment + Stryd swap |
| `STRYD_EMAIL_PAM` / `STRYD_PASSWORD_PAM` | optional | exercitator, praescriptor | pam's Stryd PowerCenter creds |
| `FORM_EMAIL` / `FORM_PASSWORD` | optional | exercitator, praescriptor | ze's FORM Athletica creds — drives FORM swim swap |
| `FORM_CACHE_PATH` | optional | exercitator, praescriptor | OAuth cache path; defaults to `/app/data/form-oauth.json` (in the `exercitator-data` volume so it survives restarts) |
| `MCP_OAUTH_*` | yes (production) | exercitator | streamable-http OAuth client + passphrase |
| `EXERCITATOR_API_KEYS` | optional | exercitator | HTTP API bearer keys; unset → listener disabled |
| `TAILSCALE_AUTH_KEY` | yes | tailscale-* sidecars | reusable preauth key (in praefectura/docs/tailscale.md) |
| `ANTHROPIC_API_KEY` | optional | praescriptor | dynamic deity invocations; static fallback if unset |
| `PROMUS_API` / `PROMUS_URL` | optional | exercitator, praescriptor | DSW emission bearer + base URL (default `https://promus.tail7ab379.ts.net`); also reused as the bearer for the WHOOP health-telemetry reads |
| `WHOOP_SERIAL` | required for ze | exercitator, praescriptor | WHOOP strap serial (Maverick) for the Promus health source. With `healthSource: "promus-whoop"`, ze's Sleep + HRV come from this strap; unset → ze's suggestions hard-fail with `health_unavailable` |
| `PROMUS_FORM_DSW_ENABLED` | optional | exercitator, praescriptor | `"1"` or `"true"` enables FORM-side DSW emission. Stays off until Promus accepts `vendor_recommendation_set` (Promus #168, shipped 2026-05-26). Currently **set to `1` on Cogitator**. |

**Rule**: when a code change reads a new env var, this table + the relevant `environment:` blocks in `docker-compose.yml` must be updated in the same commit. A grep for the var name in `docker-compose.yml` is the cheapest pre-commit check.
