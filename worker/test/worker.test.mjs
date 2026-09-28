import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { processOne } from "../process.mjs";
import { UsageLimitError, runClaude, claudeArgs, ANALYSE_TOOLS, NEVER_TOOLS } from "../claude.mjs";
import { buildPrompt, summaryOf } from "../prompt.mjs";
import { loadConfig, assertConfig } from "../config.mjs";

const quiet = () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ddpw-"));
const cfgFor = (dir) => ({ workerId: "laptop-test", mode: "analyse", repoRoot: "C:/DDP", claudeBin: "claude", claudeTimeoutMs: 1000, allowDb: false, reportsDir: dir });

function fakeApi(lease) {
  const calls = [];
  return {
    calls,
    async claim(id) { calls.push(["claim", id]); return lease; },
    async event(id, ev) { calls.push(["event", id, ev.type, ev.step]); return { ok: true }; },
    async release(id, w) { calls.push(["release", id, w]); return {}; },
    async resume(id, note) { calls.push(["resume", id, note]); return {}; },
  };
}
const LEASE = { job: { id: 7, jira_key: "DPB-2070", summary: "Block multiple funding attempts", url: "https://x/browse/DPB-2070" }, events: [{ data: { pastContext: 4, lessonsApplied: [{ scope: "global", weight: -0.03, text: "check logs sooner" }] } }] };
const REPORT = "## Summary\nFix is only on ddp-uat; UPI initiate paths unguarded.\n## Root cause\nInitiateUPIFundingProcessor.java:97";

test("no paused job: idle, nothing else called", async () => {
  const api = fakeApi(null);
  assert.deepEqual(await processOne({ api, cfg: cfgFor(tmp()), run: async () => ({}), log: quiet }), { status: "idle" });
  assert.equal(api.calls.length, 1);
});

test("success: report saved locally, posted as a step event, job resumed with the summary", async () => {
  const dir = tmp();
  const api = fakeApi(LEASE);
  let prompt;
  const out = await processOne({ api, cfg: cfgFor(dir), run: async (o) => { prompt = o.prompt; return { text: REPORT, turns: 12, costUsd: null }; }, log: quiet });
  assert.equal(out.status, "done");
  assert.match(prompt, /ANALYSIS-ONLY/);
  assert.match(prompt, /check logs sooner/, "learned lessons are passed to Claude");
  const resume = api.calls.find((c) => c[0] === "resume");
  assert.equal(resume[2], "Fix is only on ddp-uat; UPI initiate paths unguarded.");
  assert.ok(api.calls.some((c) => c[0] === "event" && c[2] === "plan" && c[3] === "logs"));
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("usage limit: job released untouched for a later retry, not failed", async () => {
  const api = fakeApi(LEASE);
  const out = await processOne({ api, cfg: cfgFor(tmp()), run: async () => { throw new UsageLimitError("Claude usage limit reached"); }, log: quiet });
  assert.equal(out.status, "usage-limit");
  assert.ok(api.calls.some((c) => c[0] === "release"));
  assert.ok(!api.calls.some((c) => c[0] === "resume"));
});

test("other failure: error event recorded and lease released", async () => {
  const api = fakeApi(LEASE);
  const out = await processOne({ api, cfg: cfgFor(tmp()), run: async () => { throw new Error("boom"); }, log: quiet });
  assert.equal(out.status, "error");
  assert.ok(api.calls.some((c) => c[0] === "event" && c[2] === "error"));
  assert.ok(api.calls.some((c) => c[0] === "release"));
});

test("allowlist is read-only: no edit/write/commit/push tools can be allowed", () => {
  for (const t of ANALYSE_TOOLS) assert.ok(!/^(Edit|Write|NotebookEdit)$|git (push|commit|checkout|reset|pull)/.test(t), `${t} must not be allowed`);
  const args = claudeArgs();
  assert.ok(args.includes("-p"));
  assert.equal(args[args.indexOf("--disallowedTools") + 1], NEVER_TOOLS.join(","));
  assert.ok(!claudeArgs().join(" ").includes("mysqlsh"), "DB is opt-in");
  assert.ok(claudeArgs({ allowDb: true }).join(" ").includes("mysqlsh"));
});

function fakeSpawn(stdout, code = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end: () => setImmediate(() => { child.stdout.emit("data", stdout); child.emit("close", code); }) };
    child.kill = () => {};
    return child;
  };
}

test("runClaude parses JSON output, and maps usage-limit exits to UsageLimitError", async () => {
  const ok = await runClaude({ prompt: "x", cwd: ".", spawnImpl: fakeSpawn(JSON.stringify({ type: "result", result: "## Summary\nok", num_turns: 3, is_error: false })) });
  assert.equal(ok.text, "## Summary\nok");
  assert.equal(ok.turns, 3);
  await assert.rejects(runClaude({ prompt: "x", cwd: ".", spawnImpl: fakeSpawn(JSON.stringify({ result: "Claude AI usage limit reached|1790000000", is_error: true }), 1) }), UsageLimitError);
  await assert.rejects(runClaude({ prompt: "x", cwd: ".", spawnImpl: fakeSpawn("crash", 2) }), /claude exited 2/);
});

test("summaryOf takes the Summary section; buildPrompt states DB rules", () => {
  assert.equal(summaryOf(REPORT), "Fix is only on ddp-uat; UPI initiate paths unguarded.");
  assert.match(buildPrompt(LEASE.job, [], { allowDb: false }), /Database: not available/);
  assert.match(buildPrompt(LEASE.job, [], { allowDb: true }), /read-only SELECT/);
});

test("config requires the dashboard login and only allows analyse mode", () => {
  assert.throws(() => assertConfig(loadConfig({})), /DDP_API_USER and DDP_API_PASS/);
  assert.throws(() => assertConfig(loadConfig({ DDP_API_USER: "u", DDP_API_PASS: "p", DDP_WORKER_MODE: "fix" })), /only "analyse"/);
  assert.doesNotThrow(() => assertConfig(loadConfig({ DDP_API_USER: "u", DDP_API_PASS: "p" })));
});
