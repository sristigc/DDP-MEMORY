// DDP Galaxy: live 3D knowledge graph of who worked on what.
// Serves /galaxy (UI), /galaxy/api/graph (snapshot), /galaxy/api/events (SSE live feed).
// Runs behind the viewer-proxy basic auth; the agentmemory secret never reaches the browser.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, touchedIds } from "./lib/model.mjs";
import { AgentmemorySource, DummySource } from "./lib/source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const BASE = "/galaxy";

const cfg = {
  port: Number(process.env.PORT || 8080),
  dummy: process.env.DUMMY === "1",
  pollMs: Number(process.env.POLL_MS || 5000),
  activeWindowMs: Number(process.env.ACTIVE_WINDOW_MIN || 10) * 60e3,
  maxFilesPerPerson: Number(process.env.MAX_FILES_PER_PERSON || 120),
  ticketPrefixes: (process.env.JIRA_PREFIXES || "HDP,DPB,DDP").split(",").map((s) => s.trim()).filter(Boolean),
};

const source = cfg.dummy
  ? new DummySource({ live: true, activeWindowMs: cfg.activeWindowMs })
  : new AgentmemorySource({
      url: required("AGENTMEMORY_URL"),
      secret: required("AGENTMEMORY_SECRET"),
      defaultPerson: (process.env.DEFAULT_PERSON || "").toLowerCase() || null,
      activeWindowMs: cfg.activeWindowMs,
    });

let graph = null;
let loadError = null;
const clients = new Set();

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`[galaxy] ${name} is required (or set DUMMY=1)`); process.exit(1); }
  return v;
}

function rebuild() {
  graph = buildGraph({
    ...source.snapshot(),
    activeSessions: source.activeSessions(),
    ticketPrefixes: cfg.ticketPrefixes,
    maxFilesPerPerson: cfg.maxFilesPerPerson,
  });
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

async function pollOnce() {
  try {
    const { changed, newObs } = await source.poll();
    if (!changed) return;
    const before = graph ? graph.nodes.length : 0;
    rebuild();
    const owners = new Map(graph.nodes.map((n) => [n.id, n.owners]));
    for (const { sessionId, obs } of newObs) {
      const { sessionNode, ids } = touchedIds(obs, sessionId, cfg.ticketPrefixes);
      const person = graph.nodes.find((n) => n.id === sessionNode)?.person;
      const shared = ids.filter((id) => (owners.get(id) || []).some((o) => o !== person));
      broadcast("touch", { person, sessionNode, ids, shared, type: obs.type, at: obs.timestamp });
    }
    broadcast("graph", { stats: graph.stats, nodesChanged: graph.nodes.length !== before, active: activePeople() });
  } catch (err) {
    console.error("[galaxy] poll failed:", err.message);
  }
}

function activePeople() {
  return graph ? graph.nodes.filter((n) => n.type === "person" && n.active).map((n) => n.id) : [];
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC, rel || "index.html"));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/healthz" || p === `${BASE}/healthz`) return json(res, graph ? 200 : 503, { ok: !!graph, error: loadError, stats: graph?.stats });
  if (p === BASE) { res.writeHead(302, { Location: `${BASE}/` }).end(); return; }
  if (!p.startsWith(`${BASE}/`)) { res.writeHead(404).end("not found"); return; }
  const rel = p.slice(BASE.length + 1);

  if (rel === "api/graph") return graph ? json(res, 200, graph) : json(res, 503, { error: loadError || "loading" });
  if (rel === "api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: hello\ndata: ${JSON.stringify({ active: activePeople(), pollMs: cfg.pollMs })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  return serveStatic(res, rel);
});

server.listen(cfg.port, "0.0.0.0", () => console.log(`[galaxy] listening on :${cfg.port}${BASE} (dummy=${cfg.dummy})`));

(async () => {
  try {
    await source.load();
    rebuild();
    console.log("[galaxy] loaded", graph.stats);
    setInterval(pollOnce, cfg.pollMs);
  } catch (err) {
    loadError = err.message;
    console.error("[galaxy] initial load failed:", err.message);
    setTimeout(() => process.exit(1), 5000); // let Railway restart us
  }
})();
