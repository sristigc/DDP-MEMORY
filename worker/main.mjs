#!/usr/bin/env node
// ddp-worker: runs on an office machine. Leases DDP-AGENT jobs paused for local steps, analyses them
// with headless Claude Code in the DDP repo (read-only), and reports back to Railway.
//   node worker/main.mjs --once    one job (or nothing), then exit
//   node worker/main.mjs           keep polling (DDP_POLL_MIN, default 10 min)
import { assertConfig, loadConfig } from "./config.mjs";
import { JobsApi } from "./api.mjs";
import { runClaude } from "./claude.mjs";
import { processOne } from "./process.mjs";

const log = (msg) => console.log(`[ddp-worker ${new Date().toISOString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  assertConfig(cfg);
  const api = new JobsApi(cfg);
  const once = process.argv.includes("--once");
  log(`worker ${cfg.workerId} · mode ${cfg.mode} · repo ${cfg.repoRoot} · DB ${cfg.allowDb ? "read-only allowed" : "off"}`);

  for (;;) {
    let outcome;
    try { outcome = await processOne({ api, cfg, run: runClaude, log }); }
    catch (err) { outcome = { status: "error", error: err.message }; log(`poll failed: ${err.message}`); }
    if (once) { log(`done: ${outcome.status}`); process.exitCode = outcome.status === "error" ? 1 : 0; return; }
    if (outcome.status === "done") continue;                         // more work may be waiting
    const wait = outcome.status === "usage-limit" ? cfg.usageBackoffMs : cfg.pollMs;
    if (outcome.status === "idle") log(`no paused jobs; next check in ${Math.round(wait / 6e4)} min`);
    await sleep(wait);
  }
}

main().catch((err) => { log(`fatal: ${err.message}`); process.exit(1); });
