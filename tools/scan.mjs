// Independent re-scan of a file for sensitive patterns. Prints counts + masked samples only.
import fs from "node:fs";

const t = fs.readFileSync(process.argv[2], "utf8");
const PATS = {
  // Quotes may be JSON-escaped (\" or \\\") in exports. Skips askpass/sshpass helpers and
  // shell/PowerShell variable or cmdlet values ($var, Join-Path), which are code, not secrets.
  password: /(?<!ssh|ask)pass(word|wd)?["'\\]*\s*[:=]\s*["'\\]*(?!\*\*\*REDACTED|\$|Join-Path)[^\s"'\\,]{3,}/gi,
  apiKey: /api[_-]?key["']?\s*[:=]\s*["']?(?!\*\*\*REDACTED)[A-Za-z0-9+/=_-]{12,}/gi,
  bearer: /bearer\s+(?!\*\*\*REDACTED)[A-Za-z0-9._\-+/=]{16,}/gi,
  secretVar: /(secret|token)["']?\s*[:=]\s*["']?(?!\*\*\*REDACTED)[A-Za-z0-9._\-+/=]{12,}/gi,
  urlCreds: /:\/\/[^\s:/@"']+:(?!\*\*\*REDACTED)[^\s@"']+@/g,
  privateIP: /\b(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+(\.\d+)?\b/g,
  awsKey: /AKIA[0-9A-Z]{16}/g,
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  pem: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gi,
};
let risky = 0;
for (const [n, re] of Object.entries(PATS)) {
  const m = t.match(re) || [];
  if (n !== "email") risky += m.length;
  const sample = [...new Set(m)].slice(0, 3).map((s) => s.slice(0, 12) + "…").join(" | ");
  console.log(n.padEnd(10), String(m.length).padStart(3), sample);
}
console.log(`REDACTED markers: ${(t.match(/\*\*\*REDACTED\*\*\*/g) || []).length}`);
console.log(risky ? `RESULT: ${risky} risky match(es) remain — NOT safe` : "RESULT: clean (emails kept on purpose)");
process.exit(risky ? 1 : 0);
