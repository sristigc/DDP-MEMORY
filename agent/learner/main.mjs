// learner entry point: Railway cron job (every 2 hours). Scores recent DDP-AGENT work from Jira
// outcomes, reinforces lessons, publishes them to team memory, then exits.
import { env, requireEnv } from "../shared/config.mjs";
import { logger } from "../shared/log.mjs";
import { createStore } from "../shared/store/index.mjs";
import { MemoryClient, NotifierClient } from "../shared/clients.mjs";
import { JiraClient } from "../jira-poller/jira.mjs";
import { learnOnce } from "./learn.mjs";

const log = logger("learner");

async function main() {
  const store = await createStore(requireEnv("DATABASE_URL"));
  try {
    await store.migrate();
    const jira = env("JIRA_API_TOKEN")
      ? new JiraClient({ baseUrl: requireEnv("JIRA_BASE_URL"), email: requireEnv("JIRA_EMAIL"), apiToken: requireEnv("JIRA_API_TOKEN") })
      : null;
    if (!jira) log.warn("no Jira credentials; scoring from job outcomes only");
    const memory = new MemoryClient({ url: env("AGENTMEMORY_URL"), secret: env("AGENTMEMORY_SECRET"), log });
    const out = await learnOnce({ store, jira, memory, log, alpha: Number(env("LEARNING_RATE", "0.3")) });
    const episodes = await store.listEpisodes(50);
    const avg = episodes.length ? episodes.reduce((a, e) => a + e.reward, 0) / episodes.length : 0;
    log.info("learning pass complete", {
      scored: out.scored, changed: out.changed, lessonsReinforced: out.lessons.length, jiraErrors: out.errors,
      episodes: episodes.length, avgReward: Math.round(avg * 100) / 100,
    });
    if (out.changed) {
      const notifier = new NotifierClient({ url: env("NOTIFIER_URL"), token: env("NOTIFIER_TOKEN"), log });
      const top = out.lessons.slice(0, 3).map((l) => `• [${l.scope}] ${l.text.slice(0, 140)} (w=${l.weight.toFixed(2)})`).join("\n");
      await notifier.send({ kind: "info", text: `Learning pass: ${out.changed} new outcome(s), average reward ${avg.toFixed(2)}.\n${top}` });
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => { log.error("learning pass failed", { error: err.message }); process.exit(1); });
