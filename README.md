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
| `viewer-proxy/` | Password-protected Caddy proxy for the dashboard (replaces `XavTo/caddy-zero-trust`). Deployed as a second Railway service with Root Directory `viewer-proxy`. |
| `agent/` | **DDP-AGENT** — jira-poller, agent-runner, notifier + shared job store library (section 8). |
| `galaxy/system/` | Service + group manifests (`.claude`-style `.md` files) that generate the System canvas (section 6b). |
| `galaxy/` | **DDP Galaxy** — live 3D/2D constellation graph (clusters per person, highlighted shared context). Node service, no npm deps. Served at `/galaxy` behind the dashboard login. |
| `hooks/session-owner.mjs` | Claude Code SessionStart hook: records which person owns each session. |
| `tools/tag-sessions.mjs` | Tags backfilled sessions with their owner. |
| `tools/obsidian-sync.mjs` | Writes the same graph into an Obsidian vault as linked notes with per-person colours. |
| `tools/obsidian/ddp-royal.css` | Obsidian CSS snippet with the same royal theme (copied into the vault by the sync). |
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

### Watch paths (avoid needless restarts)
Every push redeploys a service unless watch paths are set. In Railway → service → **Settings → Build → Watch Paths**:
- `agentmemory`: `/Dockerfile`, `/start.sh`
- `agentmemory viewer`: `/viewer-proxy/**`

(Both are already set on the current deployment.)

### Current status (2026-09-24)
- Server: healthy, agentmemory **0.9.29**, both services built from this repo — no third-party repos left.
- Dashboard: live, login working, `forbidden host` fixed.
- Backfill: Sristi's DDP history uploaded — **48 sessions / 9,679 observations**, redacted and scanned clean.
- Pending: the other 4 team members' backfill + laptop setup (sections 2–3); change the default dashboard
  username `user` to something stronger.

---

## 1b. Dashboard (viewer)

URL: `https://agentmemory-viewer-caddy-production-ecfa.up.railway.app` — login from the viewer
service's `AUTH_USER` / `AUTH_PASS` variables (share privately).

```
Browser ─HTTPS─▶ viewer-proxy (Caddy, basic auth, :80)
                   └─▶ agentmemory.railway.internal:8083 (socat) ─▶ viewer 127.0.0.1:8082
                                                                   └─▶ REST API (adds the secret)
```

### Switch the viewer service to this repo
1. Railway → **agentmemory viewer → Settings → Source Repo** → **Disconnect**
   (`XavTo/caddy-zero-trust`) → **Connect Repo** → `sristigc/DDP-MEMORY`, branch `main`.
2. **Settings → Source → Add Root Directory** → `/viewer-proxy`. **Required** — without it Railway
   builds the server `Dockerfile` at the repo root, which crashes with
   `AGENTMEMORY_SECRET is not set`. Then click **Deploy** so it rebuilds (a plain redeploy reuses the old build).
3. Variables (keep the existing ones):

| Variable | Value |
|---|---|
| `AUTH_USER` | dashboard username |
| `AUTH_PASS` | dashboard password (plain; hashed with bcrypt at boot) |
| `UPSTREAM_URL` | `http://agentmemory.railway.internal:8083` |
| `VIEWER_HOST_HEADER` | optional, default `localhost:8082` (the viewer's internal port) |

4. Public domain stays on port **80**.

### "forbidden host"
The agentmemory viewer rejects any `Host` header except loopback on its own port. The proxy
rewrites `Host` to `localhost:8082` (`VIEWER_HOST_HEADER`). If the viewer port ever changes
(it is REST `PORT` + 2), update that variable.

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
5. **Galaxy owner hook** — tells the 3D Galaxy which globe your sessions belong to (uses your
   `git config user.email`; override with a `DDP_PERSON` env var). Clone this repo, then add to
   `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "SessionStart": [
         { "hooks": [ { "type": "command", "command": "node C:/DDP-MEMORY/hooks/session-owner.mjs" } ] }
       ]
     }
   }
   ```
   It posts one small record per session (session id, email, service, branch), prints nothing,
   and never blocks Claude (4s cap, always exits 0).
6. Close **all** terminals and Claude Code, open a new terminal, start Claude Code.
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

After the upload, tag the imported sessions with your email so they land in your globe
(sends only session ids + your email):
```bash
node tools/tag-sessions.mjs exports/redacted.export.json --dry-run   # shows count + email
node tools/tag-sessions.mjs exports/redacted.export.json
```

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

## 6. DDP Galaxy (live 3D graph)

`https://agentmemory-viewer-caddy-production-ecfa.up.railway.app/galaxy/` (same login as the dashboard). Page title: **DDP MEMORY Graph**.

- **Obsidian-style constellation**: every ticket/service/file is a glowing dot sized by activity,
  thin grey edges, clusters form from forces (each person's work pulls toward that person), loose
  items drift to the rim. **DDP** sits at the centre with every person linked to it.
- **White** = context shared by 2+ people; the arcs between people are weighted by how much they share.
- **Panel** (like Obsidian's graph settings):
  - *Views* — 3D / 2D.
  - *Filters* — search, tickets / services / files / sessions, shared-only.
  - *Groups* — **role** (default, greyscale): DDP parent white, people light grey, their own tickets/files dark grey, anything shared by 2+ people a lighter mid-grey. Or colour by **person**, **service**, **type**, **mono**. Click a group to fly to it.
  - *Display* — node size, link thickness/opacity, labels (people / + tickets / none), optional person globes, glow.
  - *Forces* — center, repel, link force, link distance, group pull, re-settle.
- **Theme**: black background (#000), soft-black panels, greyscale, matte (Space Grotesk + Inter). Threads are grey and white — work threads dark grey, person↔DDP mid grey, shared-context threads near white; **only live threads (and DDP) glow** — the glow threshold is set so nothing else crosses it.
- **Person globes** (on by default): a small, faint wireframe globe around each person, following them as the layout moves; pulses while that person is live.
- **Zoom**: wheel zooms toward the mouse pointer (down to a single file); **+ / − / FIT** buttons, or keys `+`, `-`, `f`.
- **Live**: every ~5s the server checks agentmemory. While someone works, their globe pulses, their
  DDP thread brightens, and the session → file/ticket threads they touch **light up** (bright
  white, no animation) for 90s. If the context also belongs to someone else, the thread between
  the two globes lights up too. The **LIVE** button (bottom right, with unseen-count badge) opens the
  event feed.
- Camera: orbit controls (drag rotate, right-drag pan, wheel zoom), plus **+ / − / FIT** buttons.
- Filters (tickets / services / files / sessions / shared-only), search, click any node for details.

```
Browser ─▶ viewer-proxy (basic auth) ── /galaxy* ─▶ galaxy.railway.internal:8080 ─▶ agentmemory (private, secret server-side)
                                    └─ everything else ─▶ agentmemory viewer
```

### Deploy (third Railway service)
1. Railway → project → **+ New → GitHub Repo** → `sristigc/DDP-MEMORY`; rename the service to **`galaxy`**
   (the private hostname `galaxy.railway.internal` comes from this name).
2. **Settings → Root Directory** `/galaxy`, **Watch Paths** `/galaxy/**`. No public domain needed.
3. Variables:

| Variable | Value |
|---|---|
| `AGENTMEMORY_URL` | `http://agentmemory.railway.internal:8080` |
| `AGENTMEMORY_SECRET` | `${{agentmemory.AGENTMEMORY_SECRET}}` (reference, not a copy) |
| `PORT` | `8080` |
| `JIRA_PREFIXES` | `HDP,DPB,DDP` (Jira project keys to recognise) |
| `ACTIVE_WINDOW_MIN` | `10` — minutes since last activity that still count as "live" |
| `MAX_FILES_PER_PERSON` | `120` — cap on private files per globe (shared files are always shown) |
| `DEFAULT_PERSON` | optional — globe for sessions with no owner record (otherwise "unassigned") |

4. The viewer-proxy already routes `/galaxy*` to it (override with `GALAXY_URL`).

### Local development (dummy 5-person team, live simulator)
```bash
cd galaxy
npm test                                   # model unit tests
DUMMY=1 PORT=4000 node server.mjs          # open http://localhost:4000/galaxy/
```

---

## 6b. DDP System canvas (`/galaxy/system.html`)

A live map of every service, grouped by layer: Team laptops → Edge → Memory → Graph, and
Workers → Data → Integrations. Each service shows its description and live status; each group shows
"N of N services operational". Connections animate only while traffic flows:

| Line | Meaning |
|---|---|
| bright white, fast dashes | traffic right now (e.g. runner processed a job, notifier sent a message, new observations reached memory, a job was queued) — lasts 2 minutes |
| grey, slow dashes | heartbeat: the caller polls continuously (galaxy → agentmemory, agent-runner → Postgres) |
| faint, static | idle |

Click a service for status detail, what it calls and what calls it.

**Manifests** — the canvas is generated from `galaxy/system/`, organised like `.claude/`:
```
galaxy/system/
  groups/<group>.md      name, title, order, description
  services/<service>.md  name, title, group, icon, description, railway, health, auth, calls, cron + notes body
```
To add a service: add one `.md` in `services/` (and a group if needed). `health` URLs use `${RUNNER_URL}`,
`${NOTIFIER_URL}`, `${VIEWER_URL}`, `${AGENTMEMORY_URL}` from the galaxy service's env; defaults are the
Railway private hostnames, so no extra variables are required. Health checks run every 10s
(`SYSTEM_POLL_MS`) over the private network; nothing is exposed publicly.

---

## 7. Obsidian

The same graph as Obsidian notes: `DDP-Galaxy/People|Tickets|Services|Files`, linked with `[[...]]`,
tagged `person/<name>` and `shared`, with greyscale graph colour groups per person (white for shared).

```bash
# once, real data (needs AGENTMEMORY_URL + AGENTMEMORY_SECRET)
node tools/obsidian-sync.mjs "C:/DDP-MEMORY-VAULT"
# keep it fresh every 60s while Obsidian is open
node tools/obsidian-sync.mjs "C:/DDP-MEMORY-VAULT" --watch
# try it with the dummy team
node tools/obsidian-sync.mjs "C:/DDP-MEMORY-VAULT" --dummy
```
Open the vault in Obsidian → **Graph view**. For the matching royal look, enable
**Settings → Appearance → CSS snippets → `ddp-royal`** (the sync copies it into the vault). Only notes marked `generated: ddp-galaxy` inside
`DDP-Galaxy/` are ever written or deleted — your own notes are untouched. Obsidian's graph is 2D and
refreshes on file change; use the Galaxy for true 3D and live pulses.

---

## 8. DDP-AGENT (Phase 1 automation)

Runs the Phase 1 flow (Jira ticket → context → dev subtask → logs → pull → build → commit → push →
PR → review) as four services in their own Railway group. Agents, commands and skills stay as
versioned `.md` files that the runner loads; they are configuration, not services.

```
┌─ DDP-AGENT ─────────────────────────────────────────────────────────────┐
│ jira-poller   cron 0 */5 * * *  fetch tickets assigned to me → queue    │
│ job-store     Postgres: jobs + job_events (one open job per ticket)     │
│ agent-runner  worker: claims jobs, runs steps 1–9, /agent/* API         │
│ notifier      POST /notify → my Google Chat (private network, token)    │
└─────────────────────────────────────────────────────────────────────────┘
agent-runner → agentmemory (recall in step 1, saves outcomes) → shows on the Graph
```

- **Step 3 (logs) runs locally**: QA/UAT servers are on 172.31.x.x, which Railway cannot reach. The
  runner pauses the job as `awaiting_local` and messages Google Chat. After checking logs from the
  office network, resume it: `POST https://<dashboard>/agent/jobs/<id>/resume {"note":"what the logs showed"}`
  (dashboard login). `GET /agent/jobs` lists jobs, `GET /agent/jobs/<id>` shows one with its step events.
- **Dry-run first**: `AGENT_MODE=dry-run` (default) records what each step would do, recalls past
  context from agentmemory, notifies and saves outcomes, without touching Jira or git. `live` fails
  loudly until the Claude Agent SDK executor and credentials are added.
- **RL (reinforcement learning)** is on hold; it will read outcomes from `job_events`.

### Code layout (`agent/`: one package, one image per service)
| Path | Role |
|---|---|
| `shared/config.mjs`, `shared/log.mjs` | env helpers; JSON logs with credential fields masked |
| `shared/store/` | job store contract; `postgres.mjs` (FOR UPDATE SKIP LOCKED queue), `memory.mjs` (tests/local), `schema.sql` |
| `shared/clients.mjs` | notifier + agentmemory clients (best-effort, with timeouts) |
| `jira-poller/` | `jira.mjs` (Jira Cloud search, paginated), `poll.mjs`, `main.mjs` |
| `agent-runner/` | `pipeline.mjs` (steps as data), `executors.mjs` (dry-run / live), `worker.mjs`, `api.mjs`, `main.mjs` |
| `notifier/` | `gchat.mjs` (Google Chat webhook), `server.mjs`, `main.mjs` |
| `test/agent.test.mjs` | store, poller, pipeline, worker, API, notifier, logger (`cd agent && npm test`) |

### Railway setup
Each code service: **Root Directory** `/agent`, **Dockerfile path** `<service>/Dockerfile`, **Watch paths**
`/agent/shared/**`, `/agent/package*.json`, `/agent/<service>/**`.

| Service | Variables |
|---|---|
| `job-store` | Railway Postgres (provides `DATABASE_URL`) |
| `jira-poller` | `DATABASE_URL`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, optional `JIRA_JQL`, `NOTIFIER_URL`, `NOTIFIER_TOKEN`; **Cron** `0 */5 * * *` |
| `agent-runner` | `DATABASE_URL`, `AGENT_MODE=dry-run`, `AGENTMEMORY_URL=http://agentmemory.railway.internal:8080`, `AGENTMEMORY_SECRET=${{agentmemory.AGENTMEMORY_SECRET}}`, `NOTIFIER_URL=http://notifier.railway.internal:8080`, `NOTIFIER_TOKEN`, `PORT=8080` |
| `notifier` | `NOTIFIER_TOKEN` (random), `GCHAT_WEBHOOK_URL` (your personal Google Chat space webhook), `PORT=8080` |

Without Jira credentials the poller logs a warning and exits; without a webhook the notifier logs
messages instead of sending them, so the services can be deployed before the secrets are ready.

---

## Changelog

| Date | Change |
|---|---|
| 2026-09-24 | Mirror: every push now also goes to the private github.com/sristtiii/DDP-MEMORY (second push URL on `origin`). |
| 2026-09-24 | **System canvas** at `/galaxy/system.html`: services grouped by layer from `galaxy/system/**/*.md` manifests (same convention as `.claude/`), live health over the private network, connections animate when busy (white, fast) or polling (grey, slow). Linked from the graph header. 6 new tests. |
| 2026-09-24 | Person globes smaller (radius 16 + 3·√items) and fainter (opacity 0.025). |
| 2026-09-24 | **DDP-AGENT** (`agent/`): jira-poller (5-hourly cron), agent-runner (dry-run pipeline of the 9 Phase 1 steps, local hand-off for logs, resume API), notifier (Google Chat), Postgres job store; shared library; 10 tests. viewer-proxy routes `/agent/*` to the runner. |
| 2026-09-24 | Person ↔ work threads restored: the model adds direct `works` links (person → ticket/service/file, sessions collapsed) shown whenever sessions are hidden, so shared items visibly connect to every owner. Brighter threads (works #8e8e96, DDP #a6a6ac, shared #e6e6ea, opacity 0.5). |
| 2026-09-24 | Removed the magnetic field loops; person globes are the wireframe sphere only. |
| 2026-09-24 | Background set to pure black (#000); panels unchanged. |
| 2026-09-24 | Review: restored the earlier soft-black theme (#0a0a0c, original panels) and grey/white threads (work #4a4a50, DDP #8a8a90, shared #cfcfd4, opacity 0.4); live threads still glow white. |
| 2026-09-24 | Back to black (review): pure black background and panels; Role colours now greyscale (white / light grey / dark grey / mid-grey for shared); no rings. |
| 2026-09-24 | Review round 5: title "DDP MEMORY Graph"; fonts Space Grotesk + Inter; Role colouring (parent white, people blue, own work grey, shared amber); threads uniform dim white, live threads bright + glow (bloom threshold 0.9 so only white glows); magnetic globes on by default (wireframe + dipole field loops); zoom-to-cursor, wider zoom range, stronger buttons, keyboard zoom. Obsidian snippet fonts updated. |
| 2026-09-24 | Review: "too tight, just threads": links are 1px threads (no particles, no curves); live = brighter thread only; layout spread out (repel 90, link distance 90, group pull 0.04, weaker centre, DDP↔person distance 600). |
| 2026-09-24 | Monochrome by default (review: "too glowing"): greys/white only, glow off by default (toggle in Display), grey edges; colour modes still available under Groups. Obsidian colour groups and `ddp-royal.css` snippet also greyscale. |
| 2026-09-24 | Galaxy v3 — Obsidian graph look from review: dots instead of shapes, organic force clusters (group pull toward each person) instead of fixed globes (globes now optional), Obsidian-style Views/Filters/Groups/Display/Forces panel with live sliders, 2D/3D switch, colour by person/service/type/mono, labels only for people/DDP (tickets optional), details on hover. |
| 2026-09-24 | Galaxy v2 from review: DDP parent hub with globes around it; monochrome royal theme + fonts; colour-group toggle; orbit controls with damping + zoom/fit buttons (wheel zoom was too jumpy); live sessions light up their edges instead of an always-open feed (feed behind LIVE button with badge). Obsidian: DDP hub note + `ddp-royal.css` snippet. |
| 2026-09-24 | **DDP Galaxy**: `galaxy/` live 3D graph service (globe per person, shared-context arcs, SSE live pulses, filters/search), `hooks/session-owner.mjs` (git-email ownership), `tools/tag-sessions.mjs`, `tools/obsidian-sync.mjs`. viewer-proxy routes `/galaxy*` to the galaxy service. Tested locally with a dummy 5-person team (8 unit tests). |
| 2026-09-24 | Dashboard live. Viewer service renamed `agentmemory viewer`; Root Directory `/viewer-proxy` and watch paths set on both services. First full backfill: 48 sessions / 9,679 observations. Documented the root-directory crash. `DOMAIN_NAME` variable on the viewer is unused and can be deleted. |
| 2026-09-24 | Added `viewer-proxy/` (own Caddy basic-auth proxy, replaces `XavTo/caddy-zero-trust`). Fixes dashboard "forbidden host" by rewriting `Host` to `localhost:8082`. Password hashed with `caddy hash-password` instead of interpolating it into Python. Documented watch paths. |
| 2026-09-24 | Redaction/scan handle JSON-escaped quotes (`password=\"…\"`): redactor now masks unknown values in that form; scanner no longer flags already-redacted values or code (`$env:SSH_ASKPASS = Join-Path …`, `sshpass: command not found`). Found during the first full DDP dry run (64 sessions, 45 false positives, 0 real leaks). |
| 2026-09-24 | Fix 404 after upgrade: 0.9.29 derives engine/stream ports from `--port` (8080 → engine 54103, streams 8081) but the iii docker config listens on 49134 / 3112, so the worker never connected. `start.sh` now pins `III_ENGINE_PORT=49134` and `III_STREAM_PORT=3112` (override via Railway variables). |
| 2026-09-24 | Own repo created from XavTo template. Pinned agentmemory **0.9.16 → 0.9.29** (server was rejecting 0.9.29 exports). Added `.gitattributes` (LF), secret-required startup check, optional `GRAPH_EXTRACTION_ENABLED` / `ANTHROPIC_API_KEY` / `EMBEDDING_PROVIDER` / `AGENTMEMORY_AGENT_SCOPE` passthrough, and `tools/` backfill + redaction scripts. |
