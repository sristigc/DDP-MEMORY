// One learning pass: score every finished/paused job from real Jira outcomes, reinforce lessons,
// and publish new or changed lessons to team memory so the runner (and people) recall them.
import { lessonsFor, observe, reward, signature } from "./reward.mjs";

/**
 * @returns {{ scored: number, changed: number, lessons: Array, errors: number }}
 */
export async function learnOnce({ store, jira, memory, log, now = Date.now(), alpha = 0.3 }) {
  const jobs = await store.jobsToScore();
  let changed = 0, errors = 0;
  const touched = [];
  for (const job of jobs) {
    let history = null;
    try { history = jira ? await jira.issueHistory(job.jira_key) : null; }
    catch (err) { errors++; log.warn("jira history unavailable", { jiraKey: job.jira_key, error: err.message }); }

    const s = observe(job, history, now);
    const sig = signature(s);
    const prev = await store.getEpisode(job.id);
    if (prev && prev.signals?.signature === sig) continue; // nothing new happened: no double counting
    const r = reward(s);
    await store.recordEpisode({ jobId: job.id, jiraKey: job.jira_key, reward: r, signals: { ...s, signature: sig } });
    changed++;

    for (const lesson of lessonsFor(job, s)) {
      const l = await store.reinforceLesson({ ...lesson, reward: r, alpha });
      touched.push(l);
      if (l.evidence === 1) {
        await memory.remember(`ddp-agent lesson [${l.scope}/${l.kind}] ${l.text}`, ["lesson", l.scope]);
      }
    }
  }
  return { scored: jobs.length, changed, lessons: touched, errors };
}
