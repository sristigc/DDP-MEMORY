// Poll logic: fetch Jira tickets assigned to me and queue one job per ticket.

export const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const FINISHED = new Set(["succeeded", "failed"]);

/**
 * Queues each fetched issue unless it already has an open job, or its last job finished after the
 * ticket's latest Jira update (nothing new to act on). A ticket changed after the job ended
 * (reopened, new comment, moved back) is queued again, which is how the learning loop gets new episodes.
 */
export async function pollOnce({ jira, store, jql = DEFAULT_JQL }) {
  const issues = await jira.search(jql);
  const created = [];
  let unchanged = 0;
  for (const issue of issues) {
    const last = store.lastJob ? await store.lastJob(issue.key) : null;
    if (last && FINISHED.has(last.status) && issue.updated && Date.parse(issue.updated) <= Date.parse(last.updated_at)) {
      unchanged++;
      continue;
    }
    const { created: isNew, job } = await store.enqueue({ jiraKey: issue.key, summary: issue.summary, url: issue.url });
    if (isNew) created.push(job);
  }
  return { fetched: issues.length, created, unchanged };
}
