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

test("manual queue: validates the key, adds a new job after the old one finished, never a duplicate", async () => {
  const store = new MemoryStore();
  const { job } = await store.enqueue({ jiraKey: "DPB-2070" });
  await store.finish(job.id, "succeeded", {});
  await serve(createApi({ store, stats: {}, log: quiet }), async (base) => {
    const post = (b) => fetch(`${base}/agent/jobs`, { method: "POST", body: JSON.stringify(b) });
    assert.equal((await post({ jiraKey: "drop table" })).status, 400);
    assert.equal((await post({ jiraKey: "DPB-2070", url: "javascript:x" })).status, 400);
    const first = await post({ jiraKey: "DPB-2070", summary: "retry" });
    assert.equal(first.status, 201);
    assert.notEqual((await first.json()).job.id, job.id);
    assert.equal((await post({ jiraKey: "DPB-2070" })).status, 200, "open job reused, not duplicated");
  });
});

test("claim-local can be limited to one ticket", async () => {
  const store = new MemoryStore();
  for (const k of ["HDP-11583", "DPB-2070"]) { const { job } = await store.enqueue({ jiraKey: k }); await store.finish(job.id, "awaiting_local", {}); }
  await serve(createApi({ store, stats: {}, log: quiet }), async (base) => {
    const post = (b) => fetch(`${base}/agent/jobs/claim-local`, { method: "POST", body: JSON.stringify(b) });
    assert.equal((await post({ workerId: "w", jiraKey: "bad key" })).status, 400);
    assert.equal((await (await post({ workerId: "w", jiraKey: "DPB-2070" })).json()).job.jira_key, "DPB-2070", "skips the older HDP job");
    assert.equal((await post({ workerId: "w", jiraKey: "DPB-2070" })).status, 204);
  });
});

test("local worker API: lease a paused job once, record steps, release or resume", async () => {
  const store = new MemoryStore();
  const { job } = await store.enqueue({ jiraKey: "DPB-2070" });
  await store.claim("runner");
  await store.finish(job.id, "awaiting_local", { nextStep: "pull" });
  await serve(createApi({ store, stats: {}, log: quiet }), async (base) => {
    const post = (p, b) => fetch(`${base}${p}`, { method: "POST", body: JSON.stringify(b) });
    assert.equal((await post("/agent/jobs/claim-local", {})).status, 400, "workerId required");
    const lease = await post("/agent/jobs/claim-local", { workerId: "laptop-1" });
    assert.equal(lease.status, 200);
    assert.equal((await lease.json()).job.jira_key, "DPB-2070");
    assert.equal((await post("/agent/jobs/claim-local", { workerId: "laptop-2" })).status, 204, "already leased");
    assert.equal((await post(`/agent/jobs/${job.id}/events`, { step: "logs", type: "bogus", message: "x" })).status, 400);
    assert.equal((await post(`/agent/jobs/${job.id}/events`, { step: "logs", type: "plan", message: "analysis", data: { report: "## Summary" } })).status, 201);
    assert.equal((await post(`/agent/jobs/${job.id}/release`, { workerId: "laptop-2" })).status, 409, "only the holder can release");
    assert.equal((await post(`/agent/jobs/${job.id}/release`, { workerId: "laptop-1" })).status, 200);
    assert.equal((await post("/agent/jobs/claim-local", { workerId: "laptop-2" })).status, 200, "released jobs can be leased again");
    assert.equal((await post(`/agent/jobs/${job.id}/resume`, { note: "UPI paths unguarded" })).status, 200);
    assert.equal((await store.get(job.id)).status, "queued");
  });
});

test("approval gate: a fix waiting for review is not leased; approve makes it leasable; review page renders", async () => {
  const store = new MemoryStore();
  const { job } = await store.enqueue({ jiraKey: "DPB-2070", summary: "Block multiple funding" });
  await store.claim("runner");
  await store.finish(job.id, "awaiting_local", { nextStep: "pull" });
  await serve(createApi({ store, stats: {}, log: quiet }), async (base) => {
    const post = (p, b) => fetch(`${base}${p}`, { method: "POST", body: JSON.stringify(b) });
    assert.equal((await post("/agent/jobs/claim-local", { workerId: "w1" })).status, 200);
    assert.equal((await post(`/agent/jobs/${job.id}/phase`, { workerId: "other", patch: { phase: "x" } })).status, 409, "only the lease holder");
    assert.equal((await post(`/agent/jobs/${job.id}/phase`, { workerId: "w1", patch: { decision: "approved" } })).status, 400, "workers cannot approve");
    const fix = { repo: "novopay-platform-banking-origination", base: "ddp-uat", branch: "ddp-agent/DPB-2070-job1", build: "PASS", diffStat: "2 files", diff: "+ <script>x</script>" };
    assert.equal((await post(`/agent/jobs/${job.id}/phase`, { workerId: "w1", patch: { phase: "awaiting_approval", fix } })).status, 200);
    await post(`/agent/jobs/${job.id}/release`, { workerId: "w1" });
    assert.equal((await post("/agent/jobs/claim-local", { workerId: "w1" })).status, 204, "waiting for a person, not for the worker");

    const page = await (await fetch(`${base}/agent/jobs/${job.id}/review`)).text();
    assert.match(page, /Approve: commit, push, open draft PR/);
    assert.ok(!page.includes("<script>x</script>"), "diff is escaped");

    const form = await fetch(`${base}/agent/jobs/${job.id}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "", redirect: "manual" });
    assert.equal(form.status, 303);
    assert.equal((await post(`/agent/jobs/${job.id}/approve`, {})).status, 409, "decided once");
    const lease = await post("/agent/jobs/claim-local", { workerId: "w1" });
    assert.equal(lease.status, 200);
    assert.equal((await lease.json()).job.result.decision, "approved");
  });
});
