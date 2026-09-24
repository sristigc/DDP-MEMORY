// Tags backfilled sessions with their owner (git user.email) so the Galaxy puts them in the right globe.
// Usage: node tools/tag-sessions.mjs exports/redacted.export.json [--person you@company.com] [--dry-run]
// Needs AGENTMEMORY_URL + AGENTMEMORY_SECRET. Sends only session ids + the person, never content.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dry = args.includes("--dry-run");
const pIdx = args.indexOf("--person");
if (!file) { console.error("usage: node tools/tag-sessions.mjs <export.json> [--person email] [--dry-run]"); process.exit(1); }

let person = pIdx >= 0 ? args[pIdx + 1] : "";
if (!person) {
  try { person = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8" }).trim(); } catch { /* none */ }
}
if (!person) { console.error("No person: pass --person or set git config --global user.email"); process.exit(1); }
person = person.toLowerCase();

const data = JSON.parse(fs.readFileSync(file, "utf8"));
const sessions = data.sessions || [];
console.log(`${sessions.length} sessions -> ${person}${dry ? " (dry run)" : ""}`);
if (dry) process.exit(0);

const url = process.env.AGENTMEMORY_URL;
const secret = process.env.AGENTMEMORY_SECRET;
if (!url || !secret) { console.error("Set AGENTMEMORY_URL and AGENTMEMORY_SECRET"); process.exit(1); }

let ok = 0;
for (const s of sessions) {
  const service = (String(s.cwd || "").match(/(?:novopay|trustt)-platform-[a-z0-9-]+/i) || [""])[0].toLowerCase();
  const record = { sessionId: s.id, person, service, branch: "", cwd: "", at: s.startedAt || new Date().toISOString(), backfill: true };
  const res = await fetch(`${url.replace(/\/+$/, "")}/agentmemory/remember`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ content: `galaxy-session-owner ${JSON.stringify(record)}`, type: "fact", concepts: ["galaxy", "session-owner", person], project: "DDP" }),
  });
  if (res.ok) ok++; else console.error(`  ${s.id}: HTTP ${res.status}`);
}
console.log(`tagged ${ok}/${sessions.length}`);
process.exit(ok === sessions.length ? 0 : 2);
