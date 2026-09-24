// Job store factory. Postgres in Railway (DATABASE_URL); in-memory for tests and local dry runs.
//
// Contract (both implementations):
//   migrate()                                   -> void
//   enqueue({ jiraKey, summary, url })          -> { created: boolean, job }
//   claim(workerId, staleAfterMs)               -> job | null   (queued -> running, oldest first)
//   addEvent(jobId, { step, type, message, data })
//   finish(jobId, status, result)               -> job          (running -> succeeded|failed|awaiting_local)
//   resume(jobId, note)                         -> job | null   (awaiting_local -> queued; keeps result.nextStep)
//   get(jobId) / events(jobId) / list({ status, limit })

import { MemoryStore } from "./memory.mjs";

export const OPEN_STATUSES = ["queued", "running", "awaiting_local"];
export const FINAL_STATUSES = ["succeeded", "failed"];

export async function createStore(databaseUrl) {
  if (!databaseUrl) return new MemoryStore();
  const { PostgresStore } = await import("./postgres.mjs");
  return new PostgresStore(databaseUrl);
}
