// Poll logic: fetch Jira tickets assigned to me and queue one job per ticket.

export const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

/** Queues every fetched issue; returns the newly created jobs. Tickets with an open job are skipped. */
export async function pollOnce({ jira, store, jql = DEFAULT_JQL }) {
  const issues = await jira.search(jql);
  const created = [];
  for (const issue of issues) {
    const { created: isNew, job } = await store.enqueue({ jiraKey: issue.key, summary: issue.summary, url: issue.url });
    if (isNew) created.push(job);
  }
  return { fetched: issues.length, created };
}
