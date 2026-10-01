import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { processOne } from "../process.mjs";
import { UsageLimitError, runClaude, claudeArgs, ANALYSE_TOOLS, FIX_TOOLS, NEVER_TOOLS } from "../claude.mjs";
import { buildPrompt, summaryOf, fixTargetOf, buildResultOf } from "../prompt.mjs";
import { validateTarget } from "../git.mjs";
import { loadConfig, assertConfig } from "../config.mjs";

const quiet = () => {};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ddpw-"));
const cfgFor = (dir) => ({ workerId: "laptop-test", mode: "analyse", repoRoot: "C:/DDP", claudeBin: "claude", claudeTimeoutMs: 1000, allowDb: false, reportsDir: dir });

function fakeApi(lease) {
  const calls = [];
  return {
    calls,
    async claim(id, key) { calls.push(["claim", id, key]); return lease; },
    async event(id, ev) { calls.push(["event", id, ev.type, ev.step]); return { ok: true }; },
    async release(id, w) { calls.push(["release", id, w]); return {}; },
    async resume(id, note) { calls.push(["resume", id, note]); return {}; },
    async phase(id, w, patch) { calls.push(["phase", id, patch.phase, patch]); return {}; },
    reviewUrl: (id) => `https://dash/agent/jobs/${id}/review`,
  };
}
const LEASE = { job: { id: 7, jira_key: "DPB-2070", summary: "Block multiple funding attempts", url: "https://x/browse/DPB-2070" }, events: [{ data: { pastContext: 4, lessonsApplied: [{ scope: "global", weight: -0.03, text: "check logs sooner" }] } }] };
const REPORT = "## Summary\nFix is only on ddp-uat; UPI initiate paths unguarded.\n## Root cause\nInitiateUPIFundingProcessor.java:97";

test("no paused job: idle, nothing else called", async () => {
  const api = fakeApi(null);
  assert.deepEqual(await processOne({ api, cfg: cfgFor(tmp()), run: async () => ({}), log: quiet }), { status: "idle" });
  assert.equal(api.calls.length, 1);
});

test("--ticket limits the lease to one Jira key", async () => {
  const api = fakeApi(null);
  await processOne({ api, cfg: { ...cfgFor(tmp()), ticket: "DPB-2070" }, run: async () => ({}), log: quiet });
  assert.deepEqual(api.calls[0], ["claim", "laptop-test", "DPB-2070"]);
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

test("fix pass can really edit: Edit/Write are not also denied, but git push/commit still are", () => {
  const args = claudeArgs({ tools: FIX_TOOLS });
  const denied = args[args.indexOf("--disallowedTools") + 1].split(",");
  assert.ok(!denied.includes("Edit") && !denied.includes("Write"), "a deny would override the allow");
  assert.ok(denied.includes("Bash(git push:*)") && denied.includes("Bash(git commit:*)") && denied.includes("NotebookEdit"));
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
  assert.throws(() => assertConfig(loadConfig({ DDP_API_USER: "u", DDP_API_PASS: "p", DDP_WORKER_MODE: "yolo" })), /"analyse" or "fix"/);
  assert.doesNotThrow(() => assertConfig(loadConfig({ DDP_API_USER: "u", DDP_API_PASS: "p", DDP_WORKER_MODE: "fix" })));
  assert.doesNotThrow(() => assertConfig(loadConfig({ DDP_API_USER: "u", DDP_API_PASS: "p" })));
});

// ---------- fix mode ----------
const ANALYSIS = `${REPORT}\n## Plan\n1. guard UPI\nDDP_FIX_TARGET: {"repo": "novopay-platform-banking-origination", "base": "ddp-uat"}`;
function fakeGit({ empty = false } = {}) {
  const calls = [];
  return {
    calls,
    validateTarget: (t) => ({ repo: t.repo, base: t.base, repoDir: `C:/DDP/${t.repo}` }),
    async prepareWorktree(o) { calls.push(["worktree", o.branch, o.base]); return o.dir; },
    async diffOf() { calls.push(["diff"]); return empty ? { empty: true } : { empty: false, stat: "2 files changed, 30 insertions(+)", diff: "+ guard" }; },
    async commitPushPr(o) { calls.push(["ship", o.branch, o.base, o.title]); return "https://github.com/trusttai/repo/pull/99"; },
    async run(...a) { calls.push(["run", ...a]); return ""; },
  };
}

test("fix mode: analyse, worktree from origin/<base>, fix pass with edit tools, then wait for review", async () => {
  const api = fakeApi(LEASE);
  const git = fakeGit();
  const runs = [];
  const run = async (o) => { runs.push(o); return runs.length === 1 ? { text: ANALYSIS } : { text: "Changed InitiateUPIFundingProcessor\nDDP_BUILD: PASS" }; };
  const out = await processOne({ api, cfg: { ...cfgFor(tmp()), mode: "fix", worktreesDir: "C:/DDP/.ddp-worktrees", fixTimeoutMs: 1000 }, run, git, log: quiet });
  assert.equal(out.status, "awaiting-approval");
  assert.deepEqual(git.calls[0], ["worktree", "ddp-agent/DPB-2070-job7", "ddp-uat"]);
  assert.ok(runs[1].tools.includes("Edit"), "second pass may edit");
  assert.ok(!runs[0].tools, "analysis pass keeps the read-only default");
  const phase = api.calls.find((c) => c[0] === "phase");
  assert.equal(phase[2], "awaiting_approval");
  assert.equal(phase[3].fix.build, "PASS");
  assert.ok(api.calls.some((c) => c[0] === "release"), "lease released while waiting for a person");
  assert.ok(!api.calls.some((c) => c[0] === "resume"), "not resumed before approval");
  assert.ok(!git.calls.some((c) => c[0] === "ship"), "nothing committed before approval");
});

test("approved fix: commit, push, draft PR, job resumed with the PR link", async () => {
  const fix = { repo: "novopay-platform-banking-origination", base: "ddp-uat", branch: "ddp-agent/DPB-2070-job7", worktree: "C:/w", build: "PASS" };
  const api = fakeApi({ job: { ...LEASE.job, result: { phase: "awaiting_approval", decision: "approved", fix, analysisSummary: "s" } } });
  const git = fakeGit();
  const out = await processOne({ api, cfg: { ...cfgFor(tmp()), mode: "fix" }, run: async () => { throw new Error("no Claude on ship"); }, git, log: quiet });
  assert.equal(out.status, "done");
  assert.deepEqual(git.calls[0].slice(0, 3), ["ship", fix.branch, "ddp-uat"]);
  assert.match(api.calls.find((c) => c[0] === "resume")[2], /pull\/99/);
});

test("rejected fix: worktree removed, nothing committed, job resumed", async () => {
  const api = fakeApi({ job: { ...LEASE.job, result: { phase: "awaiting_approval", decision: "rejected", fix: { repo: "novopay-platform-actor", worktree: "C:/w" } } } });
  const git = fakeGit();
  const out = await processOne({ api, cfg: { ...cfgFor(tmp()), mode: "fix" }, run: async () => ({}), git, log: quiet });
  assert.equal(out.status, "done");
  assert.ok(!git.calls.some((c) => c[0] === "ship"));
  assert.ok(git.calls.some((c) => c[0] === "run" && c[2].includes("worktree")));
  assert.match(api.calls.find((c) => c[0] === "resume")[2], /rejected/);
});

test("fix mode with no proposed repo just resumes with the analysis", async () => {
  const api = fakeApi(LEASE);
  const out = await processOne({ api, cfg: { ...cfgFor(tmp()), mode: "fix" }, run: async () => ({ text: `${REPORT}\nDDP_FIX_TARGET: {"repo": null, "base": null}` }), git: fakeGit(), log: quiet });
  assert.equal(out.status, "done");
  assert.match(api.calls.find((c) => c[0] === "resume")[2], /No code change proposed/);
});

test("analysis target parsing and validation guard the git commands", () => {
  assert.deepEqual(fixTargetOf(ANALYSIS), { repo: "novopay-platform-banking-origination", base: "ddp-uat" });
  assert.equal(fixTargetOf("no line"), null);
  assert.equal(buildResultOf("x\nDDP_BUILD: FAIL test X broke"), "FAIL test X broke");
  assert.throws(() => validateTarget({ repo: "../../etc", base: "main" }, "C:/DDP"), /valid microservice repo/);
  assert.throws(() => validateTarget({ repo: "novopay-platform-actor", base: "--upload-pack=x" }, "C:/DDP"), /invalid base branch/);
});
