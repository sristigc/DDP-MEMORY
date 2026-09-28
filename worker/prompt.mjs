// The instruction headless Claude Code receives for one job (analysis mode).

export function buildPrompt(job, events = [], { allowDb = false } = {}) {
  const lessons = events.flatMap((e) => e.data?.lessonsApplied || []);
  const pastContext = events.find((e) => e.data?.pastContext !== undefined)?.data.pastContext;
  return [
    `You are ddp-worker running the DDP Phase 1 flow for Jira ${job.jira_key} ("${job.summary}") in ANALYSIS-ONLY mode.`,
    `Ticket: ${job.url}`,
    "",
    "Follow this repository's CLAUDE.md and .claude/ setup (commands/jira-ticket.md, agents/fullstack-agent.md, skills).",
    "Hard rules for this run:",
    "- Do NOT edit or create files, commit, push, pull, check out branches, or write to Jira. Read-only everything.",
    "- Git: fetch/log/status/diff/show only. Report how the relevant microservice branch compares to origin; do not pull.",
    "- Logs: search application logs with the Elasticsearch tools (list_indices first). Never print secrets or customer data.",
    allowDb
      ? "- Database: only read-only SELECT/DESCRIBE queries on QA/UAT via the db-connections skill. Never UPDATE/DELETE/DROP/ALTER."
      : "- Database: not available in this run. If a DB check is needed, write the exact read-only query you would run.",
    "- Recall earlier team context for this ticket with the agentmemory tools before concluding.",
    "",
    lessons.length ? `Lessons the team learned before (apply them):\n${lessons.map((l) => `- [${l.scope}, weight ${l.weight}] ${l.text}`).join("\n")}` : "No prior lessons for this ticket.",
    pastContext !== undefined ? `Team memory already holds ${pastContext} related observations.` : "",
    "",
    "Produce a markdown report with exactly these sections:",
    "## Summary (max 5 lines — this is sent back to the team, so make it self-contained)",
    "## Root cause (with file paths and line numbers)",
    "## Evidence (log lines / queries / commits you checked)",
    "## Branch state (per repo: current branch, ahead/behind origin, uncommitted changes)",
    "## Plan (numbered task sheet for coding-agent: file, change, test)",
    "## Risks and estimate",
    "",
    "Finally, on the very last line, name the single repository and base branch a fix should start from, exactly like:",
    'DDP_FIX_TARGET: {"repo": "novopay-platform-banking-origination", "base": "ddp-uat"}',
    'If no code change is needed, write: DDP_FIX_TARGET: {"repo": null, "base": null}',
  ].filter((l) => l !== "").join("\n");
}

/** Parses the DDP_FIX_TARGET line from an analysis report. */
export function fixTargetOf(report) {
  const m = String(report).match(/DDP_FIX_TARGET:\s*(\{[^\n]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Second pass (fix mode): implement the plan inside an isolated worktree, build, do not commit. */
export function buildFixPrompt(job, report, { repo, base, branch, worktree, repoRoot }) {
  return [
    `You are ddp-worker implementing the fix for Jira ${job.jira_key} ("${job.summary}").`,
    `You are inside a fresh git worktree of ${repo} on branch ${branch}, created from origin/${base}.`,
    `Worktree: ${worktree}`,
    "",
    `First read ${repoRoot}/CLAUDE.md and ${repoRoot}/.claude/agents/coding-agent.md and follow them (Java 21, Spring Boot conventions,`,
    "constructor injection, methods under ~40 lines, reuse existing methods, no secrets or customer data in logs).",
    "",
    "Rules for this run:",
    "- Edit files ONLY inside this worktree. Keep the change minimal and focused on the plan below.",
    "- Add or update unit tests for the change.",
    "- Run `./gradlew build` (on Windows `gradlew.bat build`) and fix compilation or test failures you caused.",
    "- Do NOT commit, push, pull, switch branches or touch Jira. A human reviews the diff before anything is committed.",
    "",
    "The analysis and plan to implement:",
    "-----",
    String(report).replace(/DDP_FIX_TARGET:[^\n]*/g, "").slice(0, 60_000),
    "-----",
    "",
    "Reply with a markdown summary of what you changed (files, why, tests), and on the very last line exactly:",
    "DDP_BUILD: PASS   or   DDP_BUILD: FAIL <one-line reason>",
  ].join("\n");
}

export function buildResultOf(text) {
  const m = String(text).match(/DDP_BUILD:\s*(PASS|FAIL)([^\n]*)/i);
  return m ? `${m[1].toUpperCase()}${m[2] ? ` ${m[2].trim()}` : ""}` : "UNKNOWN (no DDP_BUILD line)";
}

/** First section of the report, used as the resume note (the runner caps notes at 2000 chars). */
export function summaryOf(report) {
  const m = String(report).match(/##\s*Summary[^\n]*\n([\s\S]*?)(\n##\s|$)/i);
  return (m ? m[1] : String(report)).trim().slice(0, 1900);
}
