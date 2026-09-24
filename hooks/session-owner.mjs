#!/usr/bin/env node
// Claude Code SessionStart hook: records which person owns this session, for the DDP Galaxy.
// Person = git user.email (repo-level, then global). Stored as an agentmemory memory:
//   galaxy-session-owner {"sessionId":"…","person":"…","service":"…","branch":"…"}
// Must never block or print: stdout from SessionStart hooks is injected into Claude's context.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const done = () => process.exit(0);
setTimeout(done, 4000).unref();

function git(cwd, args) {
  try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }).trim(); }
  catch { return ""; }
}

async function main() {
  const url = process.env.AGENTMEMORY_URL;
  const secret = process.env.AGENTMEMORY_SECRET;
  if (!url || !secret) return;

  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const sessionId = input.session_id;
  const cwd = input.cwd || process.cwd();
  if (!sessionId) return;

  // One record per session, even though SessionStart also fires on resume/clear/compact.
  const markerDir = path.join(os.homedir(), ".agentmemory-galaxy", "sessions");
  const marker = path.join(markerDir, sessionId.replace(/[^\w-]/g, ""));
  if (fs.existsSync(marker)) return;

  const person = (process.env.DDP_PERSON
    || git(cwd, ["config", "user.email"])
    || git(os.homedir(), ["config", "--global", "user.email"])).toLowerCase();
  if (!person) return;
  const service = (cwd.match(/(?:novopay|trustt)-platform-[a-z0-9-]+/i) || [""])[0].toLowerCase();
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const record = { sessionId, person, service, branch, cwd: path.basename(cwd), at: new Date().toISOString() };

  const res = await fetch(`${url.replace(/\/+$/, "")}/agentmemory/remember`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ content: `galaxy-session-owner ${JSON.stringify(record)}`, type: "fact", concepts: ["galaxy", "session-owner", person], project: "DDP" }),
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, record.at);
  }
}

main().catch(() => {}).finally(done);
