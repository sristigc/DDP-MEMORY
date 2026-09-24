import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SystemMonitor, expand, loadManifests, parseManifest } from "../lib/system.mjs";
import { DUMMY_ENV, makeDummyFetch } from "../lib/system-dummy.mjs";

const SYSTEM_DIR = new URL("../system", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

test("parseManifest reads scalars, lists, booleans, numbers and the notes body", () => {
  const m = parseManifest("---\nname: a\ncalls: [b, c]\nexternal: true\norder: 3\nhealthOk: [200, 401]\n---\nSome notes.\n");
  assert.deepEqual(m, { name: "a", calls: ["b", "c"], external: true, order: 3, healthOk: [200, 401], notes: "Some notes." });
  assert.throws(() => parseManifest("no frontmatter"), /missing frontmatter/);
});

test("the shipped manifests are valid and every service belongs to a known group", () => {
  const { groups, services } = loadManifests(SYSTEM_DIR);
  assert.ok(groups.length >= 5);
  assert.deepEqual(groups.map((g) => g.order), [...groups.map((g) => g.order)].sort((a, b) => a - b));
  for (const s of services) assert.ok(s.description, `${s.name} needs a description`);
  assert.ok(services.find((s) => s.name === "agent-runner").calls.includes("postgres"));
});

test("loadManifests rejects calls to unknown services", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sys-"));
  fs.mkdirSync(path.join(dir, "groups")); fs.mkdirSync(path.join(dir, "services"));
  fs.writeFileSync(path.join(dir, "groups", "g.md"), "---\nname: g\ntitle: G\norder: 1\n---\n");
  fs.writeFileSync(path.join(dir, "services", "a.md"), "---\nname: a\ngroup: g\ndescription: x\ncalls: [ghost]\n---\n");
  assert.throws(() => loadManifests(dir), /calls unknown service ghost/);
});

test("expand fills ${VAR} from the env and blanks missing ones", () => {
  assert.equal(expand("${A}/x/${B}", { A: "http://h" }), "http://h/x/");
});

test("monitor: heartbeat while polling, busy when counters move, unreachable is down", async () => {
  let t = 1_000_000;
  const now = () => t;
  const sys = new SystemMonitor({ manifests: loadManifests(SYSTEM_DIR), env: DUMMY_ENV, fetchImpl: makeDummyFetch(now), now });
  await sys.probe();
  let snap = sys.snapshot();
  const edge = (from, to) => snap.edges.find((e) => e.from === from && e.to === to).state;
  const svc = (n) => snap.services.find((s) => s.name === n);
  assert.equal(svc("agentmemory").state, "up");
  assert.equal(svc("viewer-proxy").state, "up", "401 from the login proxy counts as up");
  assert.equal(svc("postgres").state, "up", "inferred from agent-runner");
  assert.equal(svc("jira-poller").state, "scheduled");
  assert.equal(edge("galaxy", "agentmemory"), "heartbeat");
  assert.equal(edge("agent-runner", "notifier"), "off");

  t += 25_000; // dummy counters advance -> runner processed a job and notifier got a message
  await sys.probe();
  snap = sys.snapshot();
  assert.equal(edge("agent-runner", "agentmemory"), "busy");
  assert.equal(edge("agent-runner", "notifier"), "busy");
  assert.equal(edge("jira-poller", "postgres"), "busy", "a job was queued recently");

  t += 200_000; // traffic ages out
  const down = new SystemMonitor({ manifests: loadManifests(SYSTEM_DIR), env: DUMMY_ENV, fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, now });
  await down.probe();
  const d = down.snapshot();
  assert.equal(d.services.find((s) => s.name === "notifier").state, "down");
  assert.equal(d.groups.find((g) => g.name === "integrations").operational, 0);
});

test("claude-code shows active only after new observations were seen", async () => {
  let t = 5_000;
  const sys = new SystemMonitor({ manifests: loadManifests(SYSTEM_DIR), env: DUMMY_ENV, fetchImpl: makeDummyFetch(() => t), now: () => t });
  await sys.probe();
  assert.equal(sys.snapshot().services.find((s) => s.name === "claude-code").state, "idle");
  sys.noteTraffic("claude-code", "agentmemory");
  await sys.probe();
  const snap = sys.snapshot();
  assert.equal(snap.services.find((s) => s.name === "claude-code").state, "active");
  assert.equal(snap.edges.find((e) => e.from === "claude-code").state, "busy");
});
