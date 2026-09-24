// System canvas: service/group manifests (galaxy/system/**/*.md, same style as .claude/) plus live
// health and connection activity. Connections are "busy" when real traffic was seen recently,
// "heartbeat" when a service is up and polling, and "off" otherwise.
import fs from "node:fs";
import path from "node:path";

const BUSY_MS = 120e3;

/** Minimal frontmatter parser: `key: value` and `key: [a, b]` lines between --- fences. */
export function parseManifest(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const list = raw.match(/^\[(.*)\]$/);
    meta[key] = list ? list[1].split(",").map((s) => s.trim()).filter(Boolean).map(coerce) : coerce(raw.trim());
  }
  return { ...meta, notes: m[2].trim() };
}

function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

export function loadManifests(dir) {
  const read = (sub) => fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith(".md"))
    .map((f) => parseManifest(fs.readFileSync(path.join(dir, sub, f), "utf8")));
  const groups = read("groups").sort((a, b) => a.order - b.order);
  const services = read("services");
  const names = new Set(services.map((s) => s.name));
  for (const s of services) {
    if (!groups.some((g) => g.name === s.group)) throw new Error(`${s.name}: unknown group ${s.group}`);
    for (const c of s.calls || []) if (!names.has(c)) throw new Error(`${s.name}: calls unknown service ${c}`);
  }
  return { groups, services };
}

export function expand(template, env) {
  return String(template).replace(/\$\{(\w+)\}/g, (_, k) => env[k] || "");
}

export class SystemMonitor {
  constructor({ manifests, env, fetchImpl = fetch, now = () => Date.now() }) {
    this.m = manifests;
    this.env = env;
    this.fetch = fetchImpl;
    this.now = now;
    this.status = new Map();      // service -> { state, detail, checkedAt }
    this.busyUntil = new Map();   // "a->b" -> timestamp
    this.lastStats = {};
  }

  /** Called by the graph poller and the HTTP server to report traffic they observed themselves. */
  noteTraffic(from, to) { this.busyUntil.set(`${from}->${to}`, this.now() + BUSY_MS); }

  async probeOne(svc) {
    if (svc.self) return { state: "up", detail: "serving this page" };
    if (!svc.health) return null;
    const url = expand(svc.health, this.env);
    if (!url || url.startsWith("/")) return { state: "unknown", detail: "no private URL configured" };
    const headers = svc.auth === "agentmemory" && this.env.AGENTMEMORY_SECRET ? { authorization: `Bearer ${this.env.AGENTMEMORY_SECRET}` } : {};
    try {
      const res = await this.fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      const ok = (svc.healthOk || [200]).includes(res.status);
      let body = null;
      try { body = await res.json(); } catch { /* html or empty */ }
      return { state: ok ? "up" : "down", detail: ok ? summarize(svc.name, body) : `HTTP ${res.status}`, body };
    } catch (err) {
      return { state: "down", detail: err.name === "TimeoutError" ? "timeout" : "unreachable" };
    }
  }

  async probe() {
    const at = this.now();
    const results = await Promise.all(this.m.services.map(async (s) => [s, await this.probeOne(s)]));
    for (const [s, r] of results) if (r) this.status.set(s.name, { ...r, checkedAt: at });

    // Derived signals from the runner and notifier counters.
    const runner = this.status.get("agent-runner")?.body;
    const notifier = this.status.get("notifier")?.body;
    if (runner) {
      if (this.lastStats.processed !== undefined && runner.processed > this.lastStats.processed) {
        this.noteTraffic("agent-runner", "postgres");
        this.noteTraffic("agent-runner", "agentmemory");
      }
      this.lastStats.processed = runner.processed;
    }
    if (notifier) {
      const total = (notifier.sent || 0) + (notifier.dropped || 0) + (notifier.failed || 0);
      if (this.lastStats.notified !== undefined && total > this.lastStats.notified) {
        for (const s of this.m.services) if ((s.calls || []).includes("notifier")) this.noteTraffic(s.name, "notifier");
      }
      this.lastStats.notified = total;
    }
    await this.probeJobs();

    // Services without their own health check.
    const runnerUp = this.status.get("agent-runner")?.state === "up";
    this.status.set("postgres", { state: runnerUp ? "up" : "unknown", detail: runnerUp ? "in use by agent-runner" : "no signal", checkedAt: at });
    const team = this.busy("claude-code", "agentmemory");
    this.status.set("claude-code", { state: team ? "active" : "idle", detail: team ? "sessions writing to memory" : "no new observations in 2 min", checkedAt: at });
  }

  /** New jobs in the last few minutes mean the poller just ran. */
  async probeJobs() {
    const base = expand("${RUNNER_URL}", this.env);
    const poller = this.m.services.find((s) => s.name === "jira-poller");
    if (!poller) return;
    let detail = `cron ${poller.cron}`;
    if (base) {
      try {
        const res = await this.fetch(`${base}/agent/jobs`, { signal: AbortSignal.timeout(5000) });
        const { jobs = [] } = await res.json();
        const newest = jobs.reduce((t, j) => Math.max(t, Date.parse(j.created_at) || 0), 0);
        if (newest && this.now() - newest < BUSY_MS) { this.noteTraffic("jira-poller", "postgres"); }
        const open = jobs.filter((j) => ["queued", "running", "awaiting_local"].includes(j.status)).length;
        detail = `${detail} · ${jobs.length} jobs, ${open} open${newest ? ` · last queued ${new Date(newest).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}`;
      } catch { /* runner down: keep cron detail */ }
    }
    this.status.set("jira-poller", { state: "scheduled", detail, checkedAt: this.now() });
  }

  busy(from, to) { return (this.busyUntil.get(`${from}->${to}`) || 0) > this.now(); }

  edgeState(from, to) {
    if (this.busy(from, to)) return "busy";
    const a = this.status.get(from)?.state;
    const b = this.status.get(to)?.state;
    const polling = { "galaxy->agentmemory": true, "agent-runner->postgres": true };
    return polling[`${from}->${to}`] && a === "up" && b === "up" ? "heartbeat" : "off";
  }

  snapshot() {
    const services = this.m.services.map((s) => ({
      name: s.name, title: s.title, group: s.group, icon: s.icon, description: s.description, notes: s.notes,
      railway: s.railway || null, external: !!s.external, cron: s.cron || null,
      ...(this.status.get(s.name) || { state: "unknown", detail: "not checked yet" }),
      body: undefined,
    }));
    const edges = this.m.services.flatMap((s) => (s.calls || []).map((to) => ({ from: s.name, to, state: this.edgeState(s.name, to) })));
    const groups = this.m.groups.map((g) => {
      const members = services.filter((s) => s.group === g.name);
      const ok = members.filter((s) => ["up", "active", "idle", "scheduled"].includes(s.state)).length;
      return { name: g.name, title: g.title, description: g.description, operational: ok, total: members.length };
    });
    return { groups, services, edges, at: new Date(this.now()).toISOString() };
  }
}

function summarize(name, body) {
  if (!body) return "responding";
  if (name === "agentmemory") return `${body.status || "ok"} · v${body.version || "?"}`;
  if (name === "agent-runner") return `${body.mode} · ${body.processed} jobs processed${body.lastError ? ` · last error: ${body.lastError}` : ""}`;
  if (name === "notifier") return `${body.webhook ? "Google Chat connected" : "no webhook yet"} · ${body.sent} sent`;
  return "responding";
}
