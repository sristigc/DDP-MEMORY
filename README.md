# DDP-MEMORY

Sharing context and memory for smooth development and release processes.

A self-owned Railway deployment of [agentmemory](https://github.com/rohitg00/agentmemory):
one shared memory server that every DDP team member's Claude Code reads from and writes to.
Every fix, refactor, and feature leaves context behind, so the next person (or the next fix)
starts with the history instead of from zero.

```
 Team laptops (Claude Code)                        Railway (24/7)
 ┌──────────────────────────┐                ┌──────────────────────────┐
 │ Claude Code              │  HTTPS +       │ agentmemory server       │
 │  └ @agentmemory/mcp      ├─ Bearer secret ▶  REST API :8080 (public) │
 │  └ agentmemory hooks     │                │  viewer :8083 (private)  │
 └──────────────────────────┘                │  volume  /data           │
                                             └──────────────────────────┘
```

---

## Repo contents

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the server. Pins **agentmemory 0.9.29** and **iii-engine 0.11.2** (build args). |
| `start.sh` | Railway entrypoint: binds to Railway's `PORT`, writes config/env, refuses to start without `AGENTMEMORY_SECRET`. |
| `.gitattributes` | Forces LF line endings on `.sh` / `Dockerfile` (CRLF breaks bash in the container). |
| `.gitignore` | Keeps exports, payloads, and `.env` files out of git. |
| `tools/backfill.sh` | Imports old local Claude Code sessions → redacts → scans → uploads. |
| `tools/redact.mjs` | Masks passwords, keys, tokens, URL credentials, JWTs, PEM keys, and internal IPs in an export. |
| `tools/scan.mjs` | Independent re-scan; fails if anything sensitive remains. |

Based on the [XavTo/agentmemory](https://github.com/XavTo/agentmemory) Railway template, now owned
and pinned here so we don't depend on a third party for updates.

---

## 1. Deploy on Railway

### If the service already exists (switch source to this repo)
1. Railway → **Account Settings → Integrations → GitHub** → grant access to `sristigc/DDP-MEMORY`.
2. Project **DDP-MEMORY** → **agentmemory** service → **Settings → Source Repo** → **Disconnect**
   (from `XavTo/agentmemory`) → **Connect Repo** → `sristigc/DDP-MEMORY`, branch `main`.
3. Railway rebuilds. URL, volume, and variables are kept.

### Fresh deploy
1. Railway → **+ New → Deploy from GitHub repo** → `sristigc/DDP-MEMORY`.
2. Right-click the service → **Attach Volume** → mount path **`/data`**.
3. Set the variables below.
4. **Settings → Networking → Generate Domain** (target port **8080**). Put the URL into `PUBLIC_AGENTMEMORY_URL`.

### Variables

| Variable | Value | Required |
|---|---|---|
| `PORT` | `8080` | yes |
| `NODE_ENV` | `production` | yes |
| `AGENTMEMORY_DATA_DIR` | `/data` (must equal the volume mount path) | yes |
| `AGENTMEMORY_SECRET` | long random string (`openssl rand -hex 32`) | yes — server won't start without it |
| `AGENTMEMORY_REQUIRE_HTTPS` | `1` | yes |
| `PUBLIC_AGENTMEMORY_URL` | `https://<your-domain>.up.railway.app` | yes |
| `AGENTMEMORY_AGENT_SCOPE` | `shared` (everyone sees everyone's memory, tagged by author) | default `shared` |
| `GRAPH_EXTRACTION_ENABLED` | `true` to build the knowledge graph | optional |
| `ANTHROPIC_API_KEY` | needed for LLM summaries / graph extraction | optional |
| `EMBEDDING_PROVIDER` | `local` for free on-device embeddings | optional |

### Current deployment
- URL: `https://agentmemory-production-a279.up.railway.app`
- Volume: `agentmemory-volume` → `/data`

### Verify
```bash
curl -H "Authorization: Bearer $AGENTMEMORY_SECRET" \
  https://agentmemory-production-a279.up.railway.app/agentmemory/health
```
Expect `"status":"healthy"` and `"version":"0.9.29"`.

---

## 2. Connect each team member's machine

1. Get the secret privately from the team lead (never paste it in chat, Jira, or git).
2. PowerShell:
   ```powershell
   setx AGENTMEMORY_URL "https://agentmemory-production-a279.up.railway.app"
   setx AGENTMEMORY_SECRET "<secret>"
   ```
3. Retention — Claude Code deletes transcripts after 30 days by default. Add to `~/.claude/settings.json`:
   ```json
   { "cleanupPeriodDays": 365 }
   ```
4. Install hooks + MCP in Claude Code:
   ```
   /plugin marketplace add rohitg00/agentmemory
   /plugin install agentmemory
   ```
   (Fallback: `npx -y @agentmemory/agentmemory@0.9.29 connect claude-code --with-hooks`)
5. Close **all** terminals and Claude Code, open a new terminal, start Claude Code.
   Env vars are only read at process start.

---

## 3. Backfill old sessions (once per person)

`import-jsonl` only talks to a **local** server and sends a file *path*, so it cannot upload to
Railway directly. The backfill imports locally, then pushes a **redacted** export.

```bash
# Terminal 1 — temporary local server with its own data folder
npx -y @agentmemory/agentmemory@0.9.29 --data-dir ./.local-am

# Terminal 2 — find your DDP folder name (depends on where DDP is cloned)
ls ~/.claude/projects/            # e.g. C--DDP  or  D--work-DDP

# Dry run: import + export + redact + scan, nothing uploaded
DDP_ROOT="C:/DDP" ./tools/backfill.sh ~/.claude/projects/C--DDP

# Upload only if the scan printed "RESULT: clean"
DDP_ROOT="C:/DDP" ./tools/backfill.sh ~/.claude/projects/C--DDP --upload
```

Only the DDP project folder is imported — never the whole `~/.claude` directory.

### What redaction does
- Reads real credential values from `$DDP_ROOT/.claude/skills/*/SKILL.md`, `$DDP_ROOT/.mcp.json`,
  `~/.claude.json` and masks every exact occurrence (values are never printed).
- Pattern rules: `password=`, `-p<pass>`, `secret/token/api_key=`, `Bearer …`, `user:pass@` URLs,
  AWS keys, JWTs, PEM private keys.
- Internal IPs masked to `172.31.x.x` (use `--keep-ips` on `redact.mjs` to keep them).
- Emails are kept (they show who did what).
- Exits non-zero if any known secret survives; `scan.mjs` re-checks independently.

---

## 4. Security rules

- `AGENTMEMORY_SECRET` is shared only privately inside the team. Rotate it if anyone leaves.
- The viewer (port 8083) shows everything — do **not** add a public domain for it.
  Use the password-protected Caddy service or an SSH/Railway private-network tunnel.
- Never commit exports (`exports/` is git-ignored).
- Live sessions are captured by hooks **without** redaction — keep real credentials out of prompts
  where possible.

---

## 5. Upgrading agentmemory

1. Check the new release notes at [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory).
2. Edit `Dockerfile`: `ARG AGENTMEMORY_VERSION=<new>` (and `III_VERSION` if the release requires it).
3. Confirm the new package still ships `dist/iii-config.docker.yaml` with `port: 3111`
   (`start.sh` depends on it), and that the engine/stream ports in that config still match
   `III_ENGINE_PORT` (49134) / `III_STREAM_PORT` (3112) set in `start.sh`.
4. Commit to `main` → Railway redeploys → run the health check.
5. Update the version in this README and in the changelog below.
6. Team members should use the same client version (`@agentmemory/mcp`) — exports from a newer
   client are rejected by an older server.

---

## Changelog

| Date | Change |
|---|---|
| 2026-09-24 | Redaction/scan handle JSON-escaped quotes (`password=\"…\"`): redactor now masks unknown values in that form; scanner no longer flags already-redacted values or code (`$env:SSH_ASKPASS = Join-Path …`, `sshpass: command not found`). Found during the first full DDP dry run (64 sessions, 45 false positives, 0 real leaks). |
| 2026-09-24 | Fix 404 after upgrade: 0.9.29 derives engine/stream ports from `--port` (8080 → engine 54103, streams 8081) but the iii docker config listens on 49134 / 3112, so the worker never connected. `start.sh` now pins `III_ENGINE_PORT=49134` and `III_STREAM_PORT=3112` (override via Railway variables). |
| 2026-09-24 | Own repo created from XavTo template. Pinned agentmemory **0.9.16 → 0.9.29** (server was rejecting 0.9.29 exports). Added `.gitattributes` (LF), secret-required startup check, optional `GRAPH_EXTRACTION_ENABLED` / `ANTHROPIC_API_KEY` / `EMBEDDING_PROVIDER` / `AGENTMEMORY_AGENT_SCOPE` passthrough, and `tools/` backfill + redaction scripts. |
