// Redacts secrets from an agentmemory export before it leaves the machine.
// Usage: node redact.mjs <in.json> <out.json> [--keep-ips]
// Never prints secret values — only counts.
import fs from "node:fs";

const [, , inFile, outFile, ...flags] = process.argv;
const KEEP_IPS = flags.includes("--keep-ips");
const R = "***REDACTED***";

// 1. Known secrets: pull literal values from local credential sources so they are
//    masked wherever they appear, whatever the surrounding format.
//    DDP_ROOT = where the DDP repo is cloned on this machine (default C:/DDP).
const DDP_ROOT = process.env.DDP_ROOT || "C:/DDP";
const HOME = process.env.USERPROFILE || process.env.HOME;
const CRED_SOURCES = [
  `${DDP_ROOT}/.claude/skills/db-connections/SKILL.md`,
  `${DDP_ROOT}/.claude/skills/app-servers/SKILL.md`,
  `${DDP_ROOT}/.mcp.json`,
  `${HOME}/.claude.json`,
];
const known = new Set();
for (const f of CRED_SOURCES) {
  let t;
  try { t = fs.readFileSync(f, "utf8"); } catch { continue; }
  for (const m of t.matchAll(/(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"'·|,}]{3,})/gi)) known.add(m[1]);
  for (const m of t.matchAll(/"[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*"\s*:\s*"([^"$][^"]{7,})"/g)) known.add(m[1]);
}
if (process.env.AGENTMEMORY_SECRET) known.add(process.env.AGENTMEMORY_SECRET);
const knownList = [...known].sort((a, b) => b.length - a.length);

// 2. Generic patterns (keep the label, mask the value).
const RULES = [
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  ["password", /((?:password|passwd|pwd|PGPASSWORD|MYSQL_PWD)["']?\s*[:=]\s*["']?)[^\s"',;)}·|]{3,}/gi, `$1${R}`],
  ["cli-pass", /(\s-p)(?!\s)[^\s"']{3,}/g, `$1${R}`],
  ["secret", /((?:secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, `$1${R}`],
  ["bearer", /(bearer\s+)[A-Za-z0-9._\-+/=]{16,}/gi, `$1${R}`],
  ["url-creds", /(:\/\/[^\s:/@"']+:)[^\s@"']+(@)/g, `$1${R}$2`],
  ["aws", /AKIA[0-9A-Z]{16}/g, R],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, R],
];
if (!KEEP_IPS) RULES.push(["ip", /\b(10|172|192)\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.$2.x.x"]);

const counts = { known: 0 };
for (const [n] of RULES) counts[n] = 0;

function scrub(s) {
  for (const k of knownList) {
    if (s.includes(k)) { counts.known += s.split(k).length - 1; s = s.split(k).join(R); }
  }
  for (const [n, re, rep] of RULES) {
    s = s.replace(re, (...a) => { counts[n]++; return a[0].replace(new RegExp(re.source, re.flags.replace("g", "")), rep); });
  }
  return s;
}

function walk(v) {
  if (typeof v === "string") return scrub(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    return o;
  }
  return v;
}

const data = JSON.parse(fs.readFileSync(inFile, "utf8"));
fs.writeFileSync(outFile, JSON.stringify(walk(data)));
console.log(`known secret values loaded: ${knownList.length}`);
console.log("redactions:", JSON.stringify(counts));

// 3. Verify: no known secret may survive in the output.
const out = fs.readFileSync(outFile, "utf8");
const leaked = knownList.filter((k) => out.includes(k)).length;
console.log(`known secrets remaining in output: ${leaked}`);
process.exit(leaked ? 2 : 0);
