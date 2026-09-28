// One unit of work: lease a paused job, analyse it with headless Claude Code, report back.
import fs from "node:fs";
import path from "node:path";
import { UsageLimitError } from "./claude.mjs";
import { buildPrompt, summaryOf } from "./prompt.mjs";

/**
 * @returns {Promise<{ status: "idle" | "done" | "usage-limit" | "error", jobId?: number, jiraKey?: string, error?: string }>}
 */
export async function processOne({ api, cfg, run, log, now = () => new Date() }) {
  const lease = await api.claim(cfg.workerId);
  if (!lease) return { status: "idle" };
  const { job, events = [] } = lease;
  log(`leased job ${job.id} (${job.jira_key})`);
  await api.event(job.id, { step: "local", type: "info", message: `ddp-worker ${cfg.workerId} started local analysis`, data: { mode: cfg.mode } });

  try {
    const started = Date.now();
    const out = await run({ prompt: buildPrompt(job, events, { allowDb: cfg.allowDb }), cwd: cfg.repoRoot, bin: cfg.claudeBin, timeoutMs: cfg.claudeTimeoutMs, allowDb: cfg.allowDb });
    const report = String(out.text || "").trim();
    if (!report) throw new Error("claude returned an empty report");

    const file = saveReport(cfg.reportsDir, job, report, now());
    await api.event(job.id, {
      step: "logs", type: "plan", message: "Local analysis: RCA, evidence, branch state and plan",
      data: { report: report.slice(0, 200_000), minutes: Math.round((Date.now() - started) / 6e4), turns: out.turns, costUsd: out.costUsd, reportFile: path.basename(file) },
    });
    await api.resume(job.id, summaryOf(report));
    log(`job ${job.id} analysed and resumed; report ${file}`);
    return { status: "done", jobId: job.id, jiraKey: job.jira_key };
  } catch (err) {
    const usage = err instanceof UsageLimitError;
    await api.event(job.id, { step: "local", type: usage ? "info" : "error", message: usage ? "Claude usage limit reached; job released for a later retry" : `Local analysis failed: ${err.message}` }).catch(() => {});
    await api.release(job.id, cfg.workerId).catch(() => {});
    log(`job ${job.id} ${usage ? "paused (usage limit)" : `failed: ${err.message}`}`);
    return { status: usage ? "usage-limit" : "error", jobId: job.id, jiraKey: job.jira_key, error: err.message };
  }
}

function saveReport(dir, job, report, date) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `${job.jira_key}-job${job.id}-${stamp}.md`);
  fs.writeFileSync(file, `# ${job.jira_key} — local analysis (job ${job.id})\n\n${report}\n`);
  return file;
}
