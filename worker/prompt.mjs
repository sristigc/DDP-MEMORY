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
  ].filter((l) => l !== "").join("\n");
}

/** First section of the report, used as the resume note (the runner caps notes at 2000 chars). */
export function summaryOf(report) {
  const m = String(report).match(/##\s*Summary[^\n]*\n([\s\S]*?)(\n##\s|$)/i);
  return (m ? m[1] : String(report)).trim().slice(0, 1900);
}
