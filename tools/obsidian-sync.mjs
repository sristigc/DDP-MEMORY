// Writes the Galaxy graph into an Obsidian vault as linked notes, one colour group per person.
// Usage:
//   node tools/obsidian-sync.mjs <vault-dir>            # real data (needs AGENTMEMORY_URL/SECRET)
//   node tools/obsidian-sync.mjs <vault-dir> --dummy    # fake 5-person team
//   add --watch to re-sync every 60s (Obsidian's graph refreshes as files change)
// Only files under DDP-Galaxy/ carrying `generated: ddp-galaxy` are ever created or deleted.
import fs from "node:fs";
import path from "node:path";
import { buildGraph, personLabel } from "../galaxy/lib/model.mjs";
import { AgentmemorySource, DummySource } from "../galaxy/lib/source.mjs";

const args = process.argv.slice(2);
const vault = args.find((a) => !a.startsWith("--"));
const dummy = args.includes("--dummy");
const watch = args.includes("--watch");
if (!vault) { console.error("usage: node tools/obsidian-sync.mjs <vault-dir> [--dummy] [--watch]"); process.exit(1); }

const ROOT = path.join(vault, "DDP-Galaxy");
const MARK = "generated: ddp-galaxy";
const FOLDERS = { project: "Project", person: "People", ticket: "Tickets", service: "Services", file: "Files" };
const PREFIXES = (process.env.JIRA_PREFIXES || "HDP,DPB,DDP").split(",");

const source = dummy
  ? new DummySource({ live: false, activeWindowMs: 600e3 })
  : new AgentmemorySource({ url: need("AGENTMEMORY_URL"), secret: need("AGENTMEMORY_SECRET"), defaultPerson: null, activeWindowMs: 600e3 });

function need(k) { if (!process.env[k]) { console.error(`${k} is required (or use --dummy)`); process.exit(1); } return process.env[k]; }

const safe = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, "_").slice(0, 120);
const shortSvc = (s) => s.replace(/^(novopay|trustt)-platform-/, "");
// Files: "Name.java (service · parent-dir)" so same-named classes in different packages don't collide.
const noteName = (n) => (n.type === "file"
  ? safe(`${n.name} (${shortSvc(n.service)} · ${n.path.split("/").slice(-2, -1)[0] || "root"})`)
  : safe(n.type === "person" ? n.name : shortSvc(n.name)));
const tagOf = (person) => `person/${safe(personLabel(person)).replace(/\s+/g, "-")}`;

function render(n, byId, neighbours) {
  const tags = [`type/${n.type}`, ...n.owners.map(tagOf), ...(n.shared ? ["shared"] : [])];
  const front = ["---", MARK, `type: ${n.type}`, `tags: [${tags.join(", ")}]`, `people: [${n.owners.map(personLabel).join(", ")}]`, ...(n.path ? [`path: "${n.path}"`] : []), `weight: ${Math.round(n.weight)}`, "---", ""];
  const link = (x) => `[[${FOLDERS[x.type]}/${noteName(x)}|${noteName(x)}]]`;
  const group = (type, title) => {
    const list = neighbours.filter((x) => x.type === type).sort((a, b) => b.weight - a.weight);
    return list.length ? [`## ${title}`, ...list.map((x) => `- ${link(x)}${x.shared ? " ⭐ shared" : ""}`), ""] : [];
  };
  const body = [`# ${n.name}`, "", n.shared ? `> Shared context between ${n.owners.map((o) => link(byId.get(`p:${o}`))).join(", ")}\n` : ""];
  if (n.type === "person") body.push(`Sessions: ${n.sessions}`, "");
  return [...front, ...body, ...group("person", "People"), ...group("ticket", "Tickets"), ...group("service", "Services"), ...group("file", "Files")].join("\n");
}

function neighbourMap(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nb = new Map(graph.nodes.map((n) => [n.id, new Set()]));
  // Collapse sessions: connect each person/ticket/file/service through the sessions that touched them.
  const viaSession = new Map();
  for (const l of graph.links) {
    const [s, t] = [l.source, l.target];
    if (s.startsWith("x:")) { if (!viaSession.has(s)) viaSession.set(s, new Set()); viaSession.get(s).add(t); }
    else if (t.startsWith("x:")) { if (!viaSession.has(t)) viaSession.set(t, new Set()); viaSession.get(t).add(s); }
    else { nb.get(s)?.add(t); nb.get(t)?.add(s); }
  }
  for (const members of viaSession.values()) {
    const list = [...members].filter((id) => byId.has(id));
    for (const a of list) for (const b of list) if (a !== b && (a.startsWith("p:") || b.startsWith("p:") || a.startsWith("t:") || b.startsWith("t:"))) nb.get(a)?.add(b);
  }
  return { byId, nb };
}

function writeColorGroups(graph) {
  const cfgDir = path.join(vault, ".obsidian");
  const file = path.join(cfgDir, "graph.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* new vault */ }
  // Monochrome: each person a different grey, shared context white.
  const GREYS = [0xd9d9d9, 0xb8b8bc, 0x9a9aa0, 0xc9c9cc, 0xa9a9ae, 0x8c8c92, 0xbdbdc1, 0x9f9fa4];
  const ours = graph.nodes.filter((n) => n.type === "person").map((p, i) => ({ query: `tag:#${tagOf(p.person)}`, color: { a: 1, rgb: GREYS[i % GREYS.length] } }));
  const shared = { query: "tag:#shared", color: { a: 1, rgb: 0xffffff } };
  const others = (cfg.colorGroups || []).filter((g) => !String(g.query).startsWith("tag:#person/") && g.query !== "tag:#shared");
  cfg.colorGroups = [shared, ...ours, ...others]; // first match wins: shared overrides person colour
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));

  // Royal theme snippet (user enables it once under Appearance → CSS snippets).
  const snippets = path.join(cfgDir, "snippets");
  fs.mkdirSync(snippets, { recursive: true });
  fs.copyFileSync(new URL("./obsidian/ddp-royal.css", import.meta.url), path.join(snippets, "ddp-royal.css"));
}

async function syncOnce(first) {
  if (first) await source.load(); else await source.poll();
  const graph = buildGraph({ ...source.snapshot(), activeSessions: source.activeSessions(), ticketPrefixes: PREFIXES });
  const { byId, nb } = neighbourMap(graph);
  const wanted = new Set();
  for (const n of graph.nodes) {
    if (n.type === "session") continue;
    const rel = path.join(FOLDERS[n.type], `${noteName(n)}.md`);
    wanted.add(path.normalize(rel));
    const full = path.join(ROOT, rel);
    const text = render(n, byId, [...nb.get(n.id)].map((id) => byId.get(id)).filter((x) => x && x.type !== "session"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full) || fs.readFileSync(full, "utf8") !== text) fs.writeFileSync(full, text);
  }
  let removed = 0;
  for (const folder of Object.values(FOLDERS)) {
    const dir = path.join(ROOT, folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const rel = path.normalize(path.join(folder, f));
      const full = path.join(ROOT, rel);
      if (!wanted.has(rel) && f.endsWith(".md") && fs.readFileSync(full, "utf8").includes(MARK)) { fs.unlinkSync(full); removed++; }
    }
  }
  writeColorGroups(graph);
  console.log(`[obsidian-sync] ${new Date().toLocaleTimeString()} wrote ${wanted.size} notes, removed ${removed}`, graph.stats);
}

await syncOnce(true);
if (watch) setInterval(() => syncOnce(false).catch((e) => console.error("[obsidian-sync]", e.message)), 60e3);
