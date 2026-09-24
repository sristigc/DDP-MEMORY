// jira-poller entry point. Railway runs it as a cron job every 5 hours; it polls once and exits.
import { env, requireEnv } from "../shared/config.mjs";
import { logger } from "../shared/log.mjs";
import { createStore } from "../shared/store/index.mjs";
import { NotifierClient } from "../shared/clients.mjs";
import { JiraClient } from "./jira.mjs";
import { DEFAULT_JQL, pollOnce } from "./poll.mjs";

const log = logger("jira-poller");

async function main() {
  if (!env("JIRA_API_TOKEN")) {
    log.warn("JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set; nothing polled");
    return;
  }
  const store = await createStore(requireEnv("DATABASE_URL"));
  try {
    await store.migrate();
    const jira = new JiraClient({ baseUrl: requireEnv("JIRA_BASE_URL"), email: requireEnv("JIRA_EMAIL"), apiToken: requireEnv("JIRA_API_TOKEN") });
    const { fetched, created } = await pollOnce({ jira, store, jql: env("JIRA_JQL", DEFAULT_JQL) });
    log.info("poll complete", { fetched, queued: created.length, keys: created.map((j) => j.jira_key) });
    if (created.length) {
      const notifier = new NotifierClient({ url: env("NOTIFIER_URL"), token: env("NOTIFIER_TOKEN"), log });
      await notifier.send({ kind: "queued", text: `Queued ${created.length} new ticket(s): ${created.map((j) => j.jira_key).join(", ")}` });
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => { log.error("poll failed", { error: err.message }); process.exit(1); });
