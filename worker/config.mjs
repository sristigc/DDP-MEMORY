// ddp-worker configuration, from environment variables (set once with `setx` on the office machine).
import os from "node:os";

export function loadConfig(env = process.env) {
  const get = (k, d) => (env[k] === undefined || env[k] === "" ? d : env[k]);
  return {
    apiUrl: get("DDP_API_URL", "https://agentmemory-viewer-caddy-production-ecfa.up.railway.app/agent").replace(/\/+$/, ""),
    apiUser: get("DDP_API_USER", ""),
    apiPass: get("DDP_API_PASS", ""),
    repoRoot: get("DDP_REPO_ROOT", "C:/DDP"),
    workerId: get("DDP_WORKER_ID", `${os.hostname()}-${os.userInfo().username}`).replace(/[^\w.@-]/g, "-").slice(0, 120),
    mode: get("DDP_WORKER_MODE", "analyse"),
    claudeBin: get("CLAUDE_BIN", "claude"),
    claudeTimeoutMs: Number(get("CLAUDE_TIMEOUT_MIN", "30")) * 60e3,
    pollMs: Number(get("DDP_POLL_MIN", "10")) * 60e3,
    usageBackoffMs: Number(get("DDP_USAGE_BACKOFF_MIN", "30")) * 60e3,
    allowDb: get("DDP_WORKER_ALLOW_DB", "0") === "1",
    worktreesDir: get("DDP_WORKTREES_DIR", `${get("DDP_REPO_ROOT", "C:/DDP")}/.ddp-worktrees`),
    fixTimeoutMs: Number(get("CLAUDE_FIX_TIMEOUT_MIN", "60")) * 60e3,
    reportsDir: get("DDP_REPORTS_DIR", new URL("./reports/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
  };
}

export function assertConfig(cfg) {
  const missing = [];
  if (!cfg.apiUser) missing.push("DDP_API_USER");
  if (!cfg.apiPass) missing.push("DDP_API_PASS");
  if (missing.length) throw new Error(`set ${missing.join(" and ")} (the dashboard login) — see worker/README.md`);
  if (!["analyse", "fix"].includes(cfg.mode)) throw new Error(`DDP_WORKER_MODE must be "analyse" or "fix" (got ${cfg.mode})`);
}

