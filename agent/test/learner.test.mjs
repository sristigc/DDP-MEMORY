import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../shared/store/memory.mjs";
import { observe, reward, lessonsFor, REWARDS } from "../learner/reward.mjs";
import { learnOnce } from "../learner/learn.mjs";
import { pollOnce } from "../jira-poller/poll.mjs";
import { DryRunExecutor } from "../agent-runner/executors.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const H = 3.6e6;
const fakeMemory = () => ({ saved: [], async recall() { return []; }, async remember(c) { this.saved.push(c); return true; } });
const job = (over = {}) => ({ id: 1, jira_key: "DPB-2070", summary: "s", status: "succeeded", created_at: "2026-09-24T10:00:00Z", updated_at: "2026-09-24T11:00:00Z", result: {}, ...over });

test("reward: done +1, QA +0.5, reopen -1, failure -0.5, slow hand-off -0.1, clamped", () => {
  assert.equal(reward({ reachedDone: true }), REWARDS.done);
  assert.equal(reward({ reachedQA: true }), REWARDS.qa);
  assert.equal(reward({ reachedQA: true, reopened: true }), -0.5);
  assert.equal(reward({ jobStatus: "failed" }), REWARDS.failed);
  assert.equal(reward({ waitHours: 30 }), REWARDS.slowHandoff);
  assert.equal(reward({ reopened: true, jobStatus: "failed", waitHours: 30 }), -1, "clamped at -1");
});

test("observe: only transitions after the job count; reopen and QA are detected", () => {
  const history = {
    status: "In Progress", category: "indeterminate",
    transitions: [
      { at: "2026-09-21T10:00:00Z", from: "In Progress", to: "Done" },       // before the job: ignored
      { at: "2026-09-25T10:00:00Z", from: "Ready for QA", to: "Reopened" },  // after: reopen
    ],
  };
  const s = observe(job(), history, Date.parse("2026-09-26T00:00:00Z"));
  assert.equal(s.reopened, true);
  assert.deepEqual(s.transitionsSinceJob, ["Ready for QA → Reopened"]);
  assert.equal(observe(job(), { status: "Ready for QA", transitions: [] }).reachedQA, true);
});

test("learnOnce: records an episode, reinforces lessons, never double-counts an unchanged outcome", async () => {
  const store = new MemoryStore();
  const { job: j } = await store.enqueue({ jiraKey: "DPB-2070", summary: "s" });
  await store.claim("w");
  await store.finish(j.id, "succeeded", {});
  let history = { status: "Ready for QA", category: "indeterminate", transitions: [] };
  const jira = { issueHistory: async () => history };
  const memory = fakeMemory();

  const first = await learnOnce({ store, jira, memory, log: quiet });
  assert.equal(first.changed, 1);
  const ep = await store.getEpisode(j.id);
  assert.equal(ep.reward, 0.5);
  const qaLesson = (await store.topLessons(["DPB"])).find((l) => l.kind === "qa-reached");
  assert.equal(qaLesson.evidence, 1);
  assert.equal(memory.saved.length, 1, "new lesson published to team memory");

  const again = await learnOnce({ store, jira, memory, log: quiet });
  assert.equal(again.changed, 0, "same outcome, no new learning");

  // Outcome changes: the ticket is reopened after the job -> negative reward, reopen lesson.
  history = { status: "Reopened", category: "indeterminate", transitions: [{ at: new Date(Date.now() + 1000).toISOString(), from: "Ready for QA", to: "Reopened" }] };
  const third = await learnOnce({ store, jira, memory, log: quiet });
  assert.equal(third.changed, 1);
  const reopen = (await store.topLessons(["DPB"])).find((l) => l.kind === "reopened");
  assert.ok(reopen.weight < 0, "reopen lesson carries negative weight");
});

test("local notes typed on resume become lessons for the ticket and its project", () => {
  const out = lessonsFor(job({ result: { localNote: "logs show NPE in ConsentService" } }), { localNote: "logs show NPE in ConsentService", transitionsSinceJob: [] });
  assert.deepEqual(out.map((l) => l.scope).sort(), ["DPB", "DPB-2070"]);
});

test("poller requeues a finished ticket only when Jira changed after the job ended", async () => {
  const store = new MemoryStore();
  const { job: j } = await store.enqueue({ jiraKey: "DPB-1" });
  await store.claim("w");
  const done = await store.finish(j.id, "succeeded", {});
  const before = new Date(Date.parse(done.updated_at) - 60e3).toISOString();
  const after = new Date(Date.parse(done.updated_at) + 60e3).toISOString();

  let out = await pollOnce({ jira: { search: async () => [{ key: "DPB-1", updated: before }] }, store });
  assert.equal(out.created.length, 0);
  assert.equal(out.unchanged, 1);
  out = await pollOnce({ jira: { search: async () => [{ key: "DPB-1", updated: after }] }, store });
  assert.equal(out.created.length, 1, "reopened/updated ticket becomes a new episode");
});

test("runner step 1 applies learned lessons for the ticket, project and global scope", async () => {
  const store = new MemoryStore();
  await store.reinforceLesson({ scope: "DPB", kind: "reopened", text: "check the release branch", reward: -1 });
  await store.reinforceLesson({ scope: "HDP", kind: "done", text: "unrelated", reward: 1 });
  const ex = new DryRunExecutor({ memory: fakeMemory(), store });
  const out = await ex.run({ n: 1, name: "Get Jira context", drivers: ["agent:context-fetch"], memory: "recall" }, job());
  assert.equal(out.data.lessonsApplied.length, 1);
  assert.equal(out.data.lessonsApplied[0].scope, "DPB");
  assert.ok(out.data.lessonsApplied[0].weight < 0);
});
