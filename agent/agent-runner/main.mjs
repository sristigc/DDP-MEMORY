// agent-runner entry point: long-running worker + small HTTP API (/healthz, /agent/jobs).
import http from "node:http";
import os from "node:os";
import { env, intEnv } from "../shared/config.mjs";
import { logger } from "../shared/log.mjs";
import { createStore } from "../shared/store/index.mjs";
import { MemoryClient, NotifierClient } from "../shared/clients.mjs";
import { createExecutor } from "./executors.mjs";
import { processNext } from "./worker.mjs";
import { createApi } from "./api.mjs";

const log = logger("agent-runner");
const mode = env("AGENT_MODE", "dry-run");
const pollMs = intEnv("POLL_MS", 15000);
const workerId = `${os.hostname()}-${process.pid}`;
const stats = { mode, workerId, processed: 0, lastJobAt: null, lastError: null };

if (!env("DATABASE_URL")) log.warn("DATABASE_URL not set; using an in-memory job store (local dev only)");
const store = await createStore(env("DATABASE_URL"));
await store.migrate();
const memory = new MemoryClient({ url: env("AGENTMEMORY_URL"), secret: env("AGENTMEMORY_SECRET"), log });
const notifier = new NotifierClient({ url: env("NOTIFIER_URL"), token: env("NOTIFIER_TOKEN"), log });
const executor = createExecutor({ mode, memory });

let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      const job = await processNext({ store, executor, notifier, memory, workerId, log, staleAfterMs: intEnv("STALE_AFTER_MIN", 30) * 60e3 });
      if (job) { stats.processed++; stats.lastJobAt = new Date().toISOString(); continue; }
    } catch (err) {
      stats.lastError = err.message;
      log.error("worker loop error", { error: err.message });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const server = http.createServer(createApi({ store, stats, log }));
server.listen(intEnv("PORT", 8080), () => log.info("agent-runner started", { mode, workerId, pollMs }));

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  stopping = true;
  server.close();
  await store.close();
  process.exit(0);
});

loop();
