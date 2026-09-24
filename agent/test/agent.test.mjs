import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MemoryStore } from "../shared/store/memory.mjs";
import { JiraClient } from "../jira-poller/jira.mjs";
import { pollOnce } from "../jira-poller/poll.mjs";
import { STEPS, runPipeline } from "../agent-runner/pipeline.mjs";
import { DryRunExecutor, LiveExecutor } from "../agent-runner/executors.mjs";
import { processNext } from "../agent-runner/worker.mjs";
import { createApi } from "../agent-runner/api.mjs";
import { createNotifier } from "../notifier/server.mjs";
import { formatMessage } from "../notifier/gchat.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const fakeMemory = (hits = []) => ({ recalls: [], saved: [], async recall(q) { this.recalls.push(q); return hits; }, async remember(c) { this.saved.push(c); return true; } });
const fakeNotifier = () => ({ sent: [], async send(m) { this.sent.push(m); return true; } });

// ---------- job store ----------
test("store keeps one open job per ticket and requeues only after it finishes", async () => {
  const s = new MemoryStore();
  const a = await s.enqueue({ jiraKey: "HDP-1" });
  const b = await s.enqueue({ jiraKey: "HDP-1" });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  const job = await s.claim("w1");
  await s.finish(job.id, "succeeded");
  assert.equal((await s.enqueue({ jiraKey: "HDP-1" })).created, true);
});

test("store claims oldest first and reclaims stale running jobs", async () => {
  const s = new MemoryStore();
  await s.enqueue({ jiraKey: "A-1" });
  await s.enqueue({ jiraKey: "A-2" });
  assert.equal((await s.claim("w1")).jira_key, "A-1");
  assert.equal((await s.claim("w1")).jira_key, "A-2");
  assert.equal(await s.claim("w1"), null);
  const reclaimed = await s.claim("w2", -1); // everything running counts as stale
  assert.equal(reclaimed.jira_key, "A-1");
  assert.equal(reclaimed.attempts, 2);
});

// ---------- jira poller ----------
test("jira client follows pagination and builds browse URLs", async () => {
  const pages = [
    { issues: [{ key: "HDP-1", fields: { summary: "one", status: { name: "To Do" } } }], nextPageToken: "p2", isLast: false },
    { issues: [{ key: "DPB-2", fields: { summary: "two" } }], isLast: true },
  ];
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, auth: opts.headers.authorization }); return { ok: true, json: async () => pages[calls.length - 1] }; };
  const jira = new JiraClient({ baseUrl: "https://x.atlassian.net/", email: "me@x.com", apiToken: "t", fetchImpl });
  const issues = await jira.search("assignee = currentUser()");
  assert.deepEqual(issues.map((i) => i.key), ["HDP-1", "DPB-2"]);
  assert.equal(issues[0].url, "https://x.atlassian.net/browse/HDP-1");
  assert.match(calls[1].url, /nextPageToken=p2/);
  assert.match(calls[0].auth, /^Basic /);
});

test("poller queues only tickets without an open job", async () => {
  const store = new MemoryStore();
  await store.enqueue({ jiraKey: "HDP-1" });
  const jira = { search: async () => [{ key: "HDP-1", summary: "", url: "" }, { key: "HDP-2", summary: "new", url: "u" }] };
  const out = await pollOnce({ jira, store });
  assert.equal(out.fetched, 2);
  assert.deepEqual(out.created.map((j) => j.jira_key), ["HDP-2"]);
});

// ---------- runner ----------
test("pipeline pauses at the local logs step, then resumes from step 4", async () => {
  const store = new MemoryStore();
  const { job } = await store.enqueue({ jiraKey: "HDP-9", summary: "fix" });
  const memory = fakeMemory([{ obsId: "1" }]);
  const first = await runPipeline(job, { executor: new DryRunExecutor({ memory }), store });
  assert.deepEqual(first, { status: "awaiting_local", nextStep: "pull", handoffStep: "logs" });
  assert.equal(memory.recalls.length, 1, "step 1 recalls past context");
  const second = await runPipeline(job, { executor: new DryRunExecutor({ memory }), store, fromStep: "pull" });
  assert.equal(second.status, "succeeded");
  const steps = (await store.events(job.id)).map((e) => e.step);
  assert.deepEqual(steps, ["context", "subtask", "logs", "pull", "change", "commit", "push", "pr", "review"]);
  assert.equal(STEPS.length, 9);
});

test("worker: dry run -> awaiting_local, notifies and saves to memory; resume completes it", async () => {
  const store = new MemoryStore();
  await store.enqueue({ jiraKey: "HDP-5", summary: "s", url: "https://j/HDP-5" });
  const notifier = fakeNotifier();
  const memory = fakeMemory();
  const deps = { store, executor: new DryRunExecutor({ memory }), notifier, memory, workerId: "w", log: quiet };
  const paused = await processNext(deps);
  assert.equal(paused.status, "awaiting_local");
  assert.equal(notifier.sent[0].kind, "awaiting_local");
  assert.equal(memory.saved.length, 1);
  assert.ok(await store.resume(paused.id, "logs show NPE in ConsentService"));
  const done = await processNext(deps);
  assert.equal(done.status, "succeeded");
  assert.equal(await processNext(deps), null);
});

test("worker records failures instead of crashing (live mode not enabled)", async () => {
  const store = new MemoryStore();
  await store.enqueue({ jiraKey: "HDP-7" });
  const notifier = fakeNotifier();
  const failed = await processNext({ store, executor: new LiveExecutor(), notifier, memory: fakeMemory(), workerId: "w", log: quiet });
  assert.equal(failed.status, "failed");
  assert.match(failed.result.error, /live mode is not enabled/);
  assert.equal(notifier.sent[0].kind, "failed");
});

// ---------- HTTP handlers ----------
async function serve(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test("runner API lists jobs and resumes only paused ones", async () => {
  const store = new MemoryStore();
  const { job } = await store.enqueue({ jiraKey: "HDP-3" });
  await serve(createApi({ store, stats: { mode: "dry-run" }, log: quiet }), async (base) => {
    assert.equal((await (await fetch(`${base}/agent/jobs`)).json()).jobs.length, 1);
    assert.equal((await fetch(`${base}/agent/jobs/${job.id}/resume`, { method: "POST" })).status, 409);
    await store.claim("w");
    await store.finish(job.id, "awaiting_local", { nextStep: "pull" });
    const ok = await fetch(`${base}/agent/jobs/${job.id}/resume`, { method: "POST", body: JSON.stringify({ note: "checked" }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).job.status, "queued");
    assert.equal((await fetch(`${base}/agent/jobs/abc`)).status, 400);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test("notifier requires the token, drops without a webhook, delivers with one", async () => {
  const posted = [];
  const fetchImpl = async (url, opts) => { posted.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
  const body = JSON.stringify({ text: "PR ready", kind: "succeeded", jiraKey: "HDP-1", jobId: 4 });
  await serve(createNotifier({ token: "t0k", webhookUrl: null, log: quiet }), async (base) => {
    assert.equal((await fetch(`${base}/notify`, { method: "POST", body })).status, 401);
    const r = await fetch(`${base}/notify`, { method: "POST", body, headers: { authorization: "Bearer t0k" } });
    assert.equal(r.status, 202);
  });
  await serve(createNotifier({ token: "t0k", webhookUrl: "https://chat.example/hook", log: quiet, fetchImpl }), async (base) => {
    const r = await fetch(`${base}/notify`, { method: "POST", body, headers: { authorization: "Bearer t0k" } });
    assert.equal(r.status, 200);
  });
  assert.equal(posted.length, 1);
  assert.match(posted[0].body.text, /HDP-1 · job 4\nPR ready/);
  assert.match(formatMessage({ text: "x", kind: "failed" }).text, /^❌/);
});

test("logger masks credential fields but keeps ids readable", async () => {
  const { logger } = await import("../shared/log.mjs");
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(JSON.parse(l));
  try { logger("t").info("x", { jiraKey: "HDP-1", apiKey: "k", NOTIFIER_TOKEN: "t", password: "p", jobId: 3 }); }
  finally { console.log = orig; }
  assert.equal(lines[0].jiraKey, "HDP-1");
  assert.equal(lines[0].jobId, 3);
  assert.equal(lines[0].apiKey, "***");
  assert.equal(lines[0].NOTIFIER_TOKEN, "***");
  assert.equal(lines[0].password, "***");
});
