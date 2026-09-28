// Runs headless Claude Code (`claude -p`) in the DDP repo with a read-only tool allowlist.
// Uses the machine's existing Claude Code login (subscription) — no API key needed.
import { spawn } from "node:child_process";

export class UsageLimitError extends Error {}

// Analysis mode: read code, read-only git, Jira read, team-memory recall, Elasticsearch log search.
// Anything not listed is refused automatically in headless mode (no one is there to approve it).
export const ANALYSE_TOOLS = [
  "Read", "Grep", "Glob", "Agent",
  "Bash(git fetch:*)", "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
  "Bash(git show:*)", "Bash(git branch:*)", "Bash(git rev-list:*)", "Bash(git remote:*)",
  "mcp__claude_ai_Atlassian_Rovo__getJiraIssue", "mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql",
  "mcp__claude_ai_Atlassian_Rovo__getJiraIssueRemoteIssueLinks", "mcp__claude_ai_Atlassian_Rovo__fetch",
  "mcp__agentmemory__memory_smart_search", "mcp__agentmemory__memory_recall", "mcp__agentmemory__memory_file_history",
  "mcp__elasticsearch__list_indices", "mcp__elasticsearch__get_mappings", "mcp__elasticsearch__search",
];
// Opt-in (DDP_WORKER_ALLOW_DB=1): read-only QA/UAT queries through the db-connections skill's client.
export const DB_TOOLS = ["Bash(mysqlsh:*)"]; // needs mysqlsh on PATH (see README)
// Fix mode (second pass): edit files inside the prepared worktree and build. Still no commit/push/pull —
// those happen in git.mjs, only after a human approves on the review page.
export const FIX_TOOLS = [
  "Read", "Grep", "Glob", "Agent", "Edit", "Write",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
  "Bash(./gradlew:*)", "Bash(gradlew:*)", "Bash(gradlew.bat:*)", "Bash(./gradlew.bat:*)",
  "mcp__agentmemory__memory_smart_search", "mcp__agentmemory__memory_recall",
];
export const NEVER_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash(git push:*)", "Bash(git commit:*)", "Bash(git checkout:*)", "Bash(git reset:*)", "Bash(git pull:*)", "Bash(git worktree:*)", "Bash(git switch:*)", "Bash(git rebase:*)", "Bash(git merge:*)", "Bash(git stash:*)"];

const USAGE_RE = /usage limit|limit reached|rate limit|quota|out of (credits|usage)|429/i;

export function claudeArgs({ allowDb = false, tools } = {}) {
  const allowed = tools || (allowDb ? [...ANALYSE_TOOLS, ...DB_TOOLS] : ANALYSE_TOOLS);
  return ["-p", "--output-format", "json", "--allowedTools", allowed.join(","), "--disallowedTools", NEVER_TOOLS.join(",")];
}

const winQuote = (a) => (/[\s"(),*:]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * @returns {Promise<{ text: string, costUsd: number|null, turns: number|null }>}
 */
export function runClaude({ prompt, cwd, bin = "claude", timeoutMs = 30 * 60e3, allowDb = false, tools, spawnImpl = spawn }) {
  const args = claudeArgs({ allowDb, tools });
  const win = process.platform === "win32";
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, win ? args.map(winQuote) : args, { cwd, shell: win, windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude timed out after ${Math.round(timeoutMs / 60e3)} min`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not start claude (${e.message}); is Claude Code installed and on PATH?`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split("\n").pop()); } catch { /* not JSON */ }
      const text = parsed?.result ?? out.trim();
      const failed = code !== 0 || parsed?.is_error;
      if (failed && USAGE_RE.test(`${text}\n${err}`)) return reject(new UsageLimitError(String(text || err).slice(0, 300)));
      if (failed) return reject(new Error(`claude exited ${code}: ${String(text || err).slice(0, 500)}`));
      resolve({ text, costUsd: parsed?.total_cost_usd ?? null, turns: parsed?.num_turns ?? null });
    });
    child.stdin.end(prompt);
  });
}
