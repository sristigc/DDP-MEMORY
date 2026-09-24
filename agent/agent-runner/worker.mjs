// Claims one job at a time from the store and runs the pipeline. Failures are recorded on the job
// (never crash the worker), and every outcome is announced via the notifier and saved to memory.
import { runPipeline } from "./pipeline.mjs";

export async function processNext({ store, executor, notifier, memory, workerId, log, staleAfterMs }) {
  const job = await store.claim(workerId, staleAfterMs);
  if (!job) return null;
  log.info("job claimed", { jobId: job.id, jiraKey: job.jira_key, attempt: job.attempts });
  try {
    const fromStep = job.result?.nextStep || undefined;
    const out = await runPipeline(job, { executor, store, fromStep });
    const finished = await store.finish(job.id, out.status, { nextStep: out.nextStep, handoffStep: out.handoffStep || null });
    const text = out.status === "awaiting_local"
      ? `${job.jira_key}: steps done up to logs. Check the logs locally, then resume. ${job.url}`
      : `${job.jira_key}: pipeline finished (${executor.mode}). ${job.url}`;
    await notifier.send({ kind: out.status, text, jobId: job.id, jiraKey: job.jira_key });
    await memory.remember(`ddp-agent job ${job.id} for ${job.jira_key} "${job.summary}" is ${out.status}`, [job.jira_key]);
    log.info("job done", { jobId: job.id, status: out.status });
    return finished;
  } catch (err) {
    await store.addEvent(job.id, { step: "runner", type: "error", message: err.message });
    const failed = await store.finish(job.id, "failed", { error: err.message });
    await notifier.send({ kind: "failed", text: `${job.jira_key}: pipeline failed: ${err.message}`, jobId: job.id, jiraKey: job.jira_key });
    log.error("job failed", { jobId: job.id, error: err.message });
    return failed;
  }
}
