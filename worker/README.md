# ddp-worker

Runs the **local steps** of DDP-AGENT jobs on a machine inside the office network, using the
machine's own **Claude Code login** (your subscription — no API key). Railway stays the
orchestrator; code, logs, DB access and credentials never leave the office machine.

```
Railway: jira-poller → job store → agent-runner (steps 1–2) ─ pauses at step 3 ─┐
                                                                                 ▼
This machine: ddp-worker ── lease job ── claude -p (in C:\DDP, read-only) ── report
                                                                                 │
Railway: job resumed with the summary → runner steps 4–9 → memory → learner ◀────┘
```

## Mode: `analyse` (the only mode for now)
Headless Claude Code follows `C:\DDP\CLAUDE.md` and `.claude/` (jira-ticket command, fullstack-agent,
skills) with a **read-only tool allowlist**:

| Allowed | Never allowed |
|---|---|
| Read, Grep, Glob, sub-agents | Edit, Write, NotebookEdit |
| `git fetch / status / log / diff / show / branch / rev-list / remote` | `git pull / checkout / reset / commit / push` |
| Jira read (issue, search, links) | Jira writes |
| agentmemory recall | — |
| Elasticsearch log search (list_indices, mappings, search) | — |
| QA/UAT DB via `mysqlsh` **only if** `DDP_WORKER_ALLOW_DB=1` (prompt restricts to SELECT/DESCRIBE) | UPDATE/DELETE/DROP/ALTER (CLAUDE.md) |

Output per job: a markdown report (Summary, Root cause, Evidence, Branch state, Plan, Risks) saved to
`worker/reports/` (git-ignored), posted to the job as a step event, and its **Summary** sent back as the
resume note — which the learner turns into a lesson.

If your Claude usage limit is reached, the job is **released untouched** and retried after
`DDP_USAGE_BACKOFF_MIN` (30). Nothing fails.

## Setup (once)
```powershell
setx DDP_API_USER "<dashboard AUTH_USER>"
setx DDP_API_PASS "<dashboard AUTH_PASS>"
# optional
setx DDP_REPO_ROOT "C:/DDP"
setx DDP_WORKER_ALLOW_DB "0"        # 1 = allow read-only mysqlsh queries (needs mysqlsh on PATH)
```
Open a new terminal afterwards. Claude Code must be installed and logged in (`claude --version`).
The Jira, agentmemory and Elasticsearch tools come from the same MCP setup your interactive
sessions use.

## Run
```bash
cd C:/DDP-MEMORY/worker
node main.mjs --once     # one job (or "no paused jobs"), then exit — use this for the first trial
node main.mjs            # keep polling every DDP_POLL_MIN (10) minutes
npm test                 # unit tests (no network, no Claude)
```
To run it in the background at logon: Windows Task Scheduler → *Create Basic Task* → trigger
"At log on" → action `node C:\DDP-MEMORY\worker\main.mjs`.

## Environment
| Variable | Default | |
|---|---|---|
| `DDP_API_URL` | `https://agentmemory-viewer-caddy-production-ecfa.up.railway.app/agent` | jobs API (behind the dashboard login) |
| `DDP_API_USER` / `DDP_API_PASS` | — (required) | dashboard login |
| `DDP_REPO_ROOT` | `C:/DDP` | where Claude runs (CLAUDE.md + .claude/) |
| `DDP_WORKER_ID` | `<hostname>-<user>` | shown on the job |
| `DDP_WORKER_MODE` | `analyse` | only mode available |
| `DDP_WORKER_ALLOW_DB` | `0` | read-only DB queries |
| `DDP_POLL_MIN` / `DDP_USAGE_BACKOFF_MIN` | 10 / 30 | |
| `CLAUDE_BIN` / `CLAUDE_TIMEOUT_MIN` | `claude` / 30 | |
