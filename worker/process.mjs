// One unit of work. A leased job is in one of three situations:
//   1. fresh at the local step      -> analyse (and in fix mode: worktree + fix + build -> wait for review)
//   2. fix approved by a person     -> commit, push, draft PR, resume the job
//   3. fix rejected by a person     -> remove the worktree, resume the job with the rejection
import fs from "node:fs";
import path from "node:path";
import { FIX_TOOLS, UsageLimitError } from "./claude.mjs";
import { buildFixPrompt, buildPrompt, buildResultOf, fixTargetOf, summaryOf } from "./prompt.mjs";
import * as realGit from "./git.mjs";

/**
 * @returns {Promise<{ status: "idle"|"done"|"awaiting-approval"|"usage-limit"|"error", jobId?: number, jiraKey?: string, error?: string }>}
 */
export async function processOne({ api, cfg, run, git = realGit, log, now = () => new Date() }) {
  const lease = await api.claim(cfg.workerId);
  if (!lease) return { status: "idle" };
  const { job, events = [] } = lease;
  const r = job.result || {};
  log(`leased job ${job.id} (${job.jira_key})${r.decision ? ` — decision: ${r.decision}` : ""}`);

  try {
    if (r.phase === "awaiting_approval" && r.decision === "approved") return await ship(job, { api, cfg, git, log });
    if (r.phase === "awaiting_approval" && r.decision === "rejected") return await discard(job, { api, cfg, git, log });
    return await analyseAndMaybeFix(job, events, { api, cfg, run, git, log, now });
  } catch (err) {
    const usage = err instanceof UsageLimitError;
    await api.event(job.id, { step: "local", type: usage ? "info" : "error", message: usage ? "Claude usage limit reached; job released for a later retry" : `Local work failed: ${err.message}` }).catch(() => {});
    await api.release(job.id, cfg.workerId).catch(() => {});
    log(`job ${job.id} ${usage ? "paused (usage limit)" : `failed: ${err.message}`}`);
    return { status: usage ? "usage-limit" : "error", jobId: job.id, jiraKey: job.jira_key, error: err.message };
  }
}

async function analyseAndMaybeFix(job, events, { api, cfg, run, git, log, now }) {
  await api.event(job.id, { step: "local", type: "info", message: `ddp-worker ${cfg.workerId} started (${cfg.mode} mode)`, data: { mode: cfg.mode } });
  const started = Date.now();
  const out = await run({ prompt: buildPrompt(job, events, { allowDb: cfg.allowDb }), cwd: cfg.repoRoot, bin: cfg.claudeBin, timeoutMs: cfg.claudeTimeoutMs, allowDb: cfg.allowDb });
  const report = String(out.text || "").trim();
  if (!report) throw new Error("claude returned an empty report");
  const file = saveReport(cfg.reportsDir, job, "analysis", report, now());
  await api.event(job.id, {
    step: "logs", type: "plan", message: "Local analysis: RCA, evidence, branch state and plan",
    data: { report: report.slice(0, 200_000), minutes: Math.round((Date.now() - started) / 6e4), turns: out.turns, reportFile: path.basename(file) },
  });

  const target = fixTargetOf(report);
  if (cfg.mode !== "fix" || !target?.repo) {
    const why = cfg.mode !== "fix" ? "" : "\n(No code change proposed by the analysis.)";
    await api.resume(job.id, summaryOf(report) + why);
    log(`job ${job.id} analysed and resumed; report ${file}`);
    return { status: "done", jobId: job.id, jiraKey: job.jira_key };
  }

  // Fix: isolated worktree from origin/<base>, Claude edits + builds there, then wait for a person.
  const { repo, base, repoDir } = git.validateTarget(target, cfg.repoRoot);
  const branch = `ddp-agent/${job.jira_key}-job${job.id}`;
  const worktree = path.join(cfg.worktreesDir, `${repo}-${job.jira_key}-job${job.id}`);
  await git.prepareWorktree({ repoDir, base, branch, dir: worktree });
  await api.event(job.id, { step: "pull", type: "info", message: `Worktree ${branch} created from origin/${base}`, data: { repo, base, branch } });

  const fixOut = await run({ prompt: buildFixPrompt(job, report, { repo, base, branch, worktree, repoRoot: cfg.repoRoot }), cwd: worktree, bin: cfg.claudeBin, timeoutMs: cfg.fixTimeoutMs, tools: FIX_TOOLS });
  const summary = String(fixOut.text || "").trim();
  saveReport(cfg.reportsDir, job, "fix", summary, now());
  const diff = await git.diffOf(worktree);
  if (diff.empty) {
    await api.event(job.id, { step: "change", type: "info", message: "Fix pass produced no code change" });
    await api.resume(job.id, `${summaryOf(report)}\n(Fix pass produced no code change.)`);
    return { status: "done", jobId: job.id, jiraKey: job.jira_key };
  }

  const build = buildResultOf(summary);
  const fix = { repo, base, branch, worktree, build, diffStat: diff.stat, diff: diff.diff, summary: summary.slice(0, 20_000) };
  await api.phase(job.id, cfg.workerId, { phase: "awaiting_approval", fix, analysisSummary: summaryOf(report) });
  await api.event(job.id, { step: "change", type: "handoff", message: `Fix ready for review (build ${build}): ${api.reviewUrl(job.id)}`, data: { branch, diffStat: diff.stat } });
  await api.release(job.id, cfg.workerId);
  log(`job ${job.id}: fix ready for review (build ${build}) — ${api.reviewUrl(job.id)}`);
  return { status: "awaiting-approval", jobId: job.id, jiraKey: job.jira_key };
}

async function ship(job, { api, cfg, git, log }) {
  const fix = job.result.fix;
  const title = `${job.jira_key} || ${String(job.summary).slice(0, 120)}`;
  const body = [
    `Jira: ${job.url}`,
    "",
    job.result.analysisSummary || "",
    "",
    `Build: ${fix.build}`,
    "",
    "Analysed and implemented by ddp-worker (headless Claude Code); approved by a reviewer on the DDP-AGENT review page before commit.",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
  const commitBody = `${job.result.analysisSummary || ""}\n\nApproved on the DDP-AGENT review page.\n\nCo-Authored-By: Claude <noreply@anthropic.com>`;
  const prUrl = await git.commitPushPr({ dir: fix.worktree, branch: fix.branch, base: fix.base, title, body, commitBody });
  await api.phase(job.id, cfg.workerId, { phase: "pr-opened", fix: { ...fix, diff: undefined, prUrl } });
  await api.event(job.id, { step: "pr", type: "done", message: `Draft PR opened: ${prUrl}`, data: { prUrl, branch: fix.branch } });
  await api.resume(job.id, `Draft PR: ${prUrl}\n${job.result.analysisSummary || ""}`.slice(0, 1900));
  log(`job ${job.id}: draft PR ${prUrl}`);
  return { status: "done", jobId: job.id, jiraKey: job.jira_key };
}

async function discard(job, { api, cfg, git, log }) {
  const fix = job.result.fix || {};
  if (fix.worktree && fix.repo) {
    await git.run("git", ["-C", path.join(cfg.repoRoot, fix.repo), "worktree", "remove", "--force", fix.worktree]).catch(() => {});
  }
  await api.phase(job.id, cfg.workerId, { phase: "rejected" });
  await api.event(job.id, { step: "change", type: "info", message: "Fix rejected by reviewer; worktree removed, nothing committed" });
  await api.resume(job.id, `Fix rejected by reviewer. ${job.result.analysisSummary || ""}`.slice(0, 1900));
  log(`job ${job.id}: fix rejected, cleaned up`);
  return { status: "done", jobId: job.id, jiraKey: job.jira_key };
}

function saveReport(dir, job, kind, text, date) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `${job.jira_key}-job${job.id}-${kind}-${stamp}.md`);
  fs.writeFileSync(file, `# ${job.jira_key} — ${kind} (job ${job.id})\n\n${text}\n`);
  return file;
}
