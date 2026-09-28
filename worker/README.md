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

## Modes
`DDP_WORKER_MODE=analyse` (default) — report only. `DDP_WORKER_MODE=fix` — analyse, then implement and build
in an isolated worktree, then **wait for your approval** before commit / push / draft PR (see below).

### `analyse`
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

### `fix` (approval-gated)
1. Analysis pass as above; its last line names the repo and base branch (`DDP_FIX_TARGET`).
2. The worker (not Claude) fetches and creates a **fresh git worktree** from `origin/<base>` on branch
   `ddp-agent/<KEY>-job<id>` under `C:/DDP/.ddp-worktrees/` — your own working copies are never touched.
3. Fix pass: Claude may **Edit/Write inside that worktree** and run `gradlew build`; it still cannot commit,
   push, pull, switch branches or write to Jira. It follows `CLAUDE.md` and `coding-agent.md`.
4. The diff, build result and summary go to the job; the job waits at
   **`<dashboard>/agent/jobs/<id>/review`** with **Approve** / **Reject** buttons (dashboard login).
5. **Approve** → next worker poll commits, pushes the branch and opens a **draft PR** with `gh`
   (needs push rights; the PR body says it was agent-made and human-approved). **Reject** → worktree removed,
   nothing committed. Either way the job resumes and the runner finishes steps 4–9.

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
| `DDP_WORKER_MODE` | `analyse` | `analyse` or `fix` (approval-gated) |
| `DDP_WORKTREES_DIR` | `<DDP_REPO_ROOT>/.ddp-worktrees` | where fix worktrees are created |
| `CLAUDE_FIX_TIMEOUT_MIN` | 60 | fix pass incl. gradle build |
| `DDP_WORKER_ALLOW_DB` | `0` | read-only DB queries |
| `DDP_POLL_MIN` / `DDP_USAGE_BACKOFF_MIN` | 10 / 30 | |
| `CLAUDE_BIN` / `CLAUDE_TIMEOUT_MIN` | `claude` / 30 | |
