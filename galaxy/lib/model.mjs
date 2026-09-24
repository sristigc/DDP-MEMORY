// Builds the "galaxy" graph from agentmemory sessions + observations.
// Person = globe. Tickets, services, files and sessions hang off the people who touched them;
// anything touched by 2+ people is "shared" and sits between their globes.

const SERVICE_RE = /((?:novopay|trustt)-platform-[a-z0-9-]+)[\\/](.+)$/i;
const SERVICE_ONLY_RE = /((?:novopay|trustt)-platform-[a-z0-9-]+)/i;
const HAS_EXT_RE = /\.[a-z0-9]{1,8}$/i;
const EDIT_TYPES = new Set(["file_edit", "file_write"]);
// Muted jewel tones (royal blue, amethyst, emerald, garnet, bronze, …) for per-person colour groups.
const PALETTE = ["#6f86d6", "#9d7bd8", "#4fa58f", "#c0607f", "#c39a6b", "#7ea7c9", "#b59fdc", "#8fb89a"];
export const HUB_ID = "hub:DDP";

export const UNKNOWN_PERSON = "unassigned";

export function normalizeFile(path) {
  const m = typeof path === "string" && path.match(SERVICE_RE);
  if (!m) return null;
  const rel = m[2].replace(/\\/g, "/");
  if (!HAS_EXT_RE.test(rel)) return null; // directories are noise
  const service = m[1].toLowerCase();
  return { id: `f:${service}/${rel}`, service, rel, name: rel.split("/").pop() };
}

export function serviceOf(text) {
  const m = typeof text === "string" && text.match(SERVICE_ONLY_RE);
  return m ? m[1].toLowerCase() : null;
}

export function ticketRegex(prefixes) {
  const alt = prefixes.map((p) => p.replace(/[^A-Z0-9]/gi, "")).filter(Boolean).join("|");
  return new RegExp(`\\b(?:${alt})-\\d{1,6}\\b`, "g");
}

export function personLabel(person) {
  return person === UNKNOWN_PERSON ? "unassigned" : String(person).split("@")[0];
}

/**
 * @param {object} input
 * @param {Array} input.sessions        agentmemory sessions
 * @param {Map}   input.obsBySession    sessionId -> observations[]
 * @param {Map}   input.ownerOf         sessionId -> person (git email)
 * @param {Set}   input.activeSessions  sessionIds considered live
 * @param {string[]} input.ticketPrefixes Jira project keys, e.g. ["HDP","DPB","DDP"]
 * @param {number} input.maxFilesPerPerson cap on non-shared files per person
 */
export function buildGraph({ sessions, obsBySession, ownerOf, activeSessions = new Set(), ticketPrefixes, maxFilesPerPerson = 120 }) {
  const TICKET = ticketRegex(ticketPrefixes);
  const nodes = new Map();
  const links = new Map();
  const people = new Map();

  const node = (id, type, name, extra = {}) => {
    if (!nodes.has(id)) nodes.set(id, { id, type, name, owners: new Set(), weight: 0, ...extra });
    return nodes.get(id);
  };
  const link = (source, target, type, w = 1) => {
    const key = `${source}|${target}`;
    const l = links.get(key) || { source, target, type, weight: 0 };
    l.weight += w;
    links.set(key, l);
  };

  for (const s of sessions) {
    const person = ownerOf.get(s.id) || UNKNOWN_PERSON;
    const pid = `p:${person}`;
    if (!people.has(pid)) people.set(pid, { id: pid, person, name: personLabel(person), sessions: 0, active: false });
    const p = people.get(pid);
    p.sessions++;
    const live = activeSessions.has(s.id);
    if (live) p.active = true;

    const sid = `x:${s.id}`;
    node(sid, "session", (s.firstPrompt || s.id).slice(0, 80), { person, startedAt: s.startedAt, live }).owners.add(person);
    link(pid, sid, "owns");

    const touch = (id, type, name, w, extra) => {
      const n = node(id, type, name, extra);
      n.owners.add(person);
      n.weight += w;
      link(sid, id, type, w);
    };

    const svc = serviceOf(s.cwd);
    if (svc) touch(`s:${svc}`, "service", svc, 1);
    for (const t of (s.firstPrompt || "").match(TICKET) || []) touch(`t:${t}`, "ticket", t, 3);

    for (const o of obsBySession.get(s.id) || []) {
      for (const t of `${o.title || ""} ${o.narrative || ""}`.match(TICKET) || []) touch(`t:${t}`, "ticket", t, 1);
      const w = EDIT_TYPES.has(o.type) ? 3 : 1;
      for (const raw of o.files || []) {
        const f = normalizeFile(raw);
        if (!f) continue;
        touch(f.id, "file", f.name, w, { service: f.service, path: f.rel });
        touch(`s:${f.service}`, "service", f.service, 0.2);
      }
    }
  }

  pruneFiles(nodes, links, maxFilesPerPerson);
  return finish(nodes, links, people);
}

// Keep every shared file; keep only the top-N private files per person by weight.
function pruneFiles(nodes, links, maxFilesPerPerson) {
  const byPerson = new Map();
  for (const n of nodes.values()) {
    if (n.type !== "file" || n.owners.size > 1) continue;
    const [owner] = n.owners;
    if (!byPerson.has(owner)) byPerson.set(owner, []);
    byPerson.get(owner).push(n);
  }
  const drop = new Set();
  for (const list of byPerson.values()) {
    list.sort((a, b) => b.weight - a.weight).slice(maxFilesPerPerson).forEach((n) => drop.add(n.id));
  }
  for (const id of drop) nodes.delete(id);
  for (const [k, l] of links) if (drop.has(l.target)) links.delete(k);
}

function finish(nodes, links, people) {
  const personList = [...people.values()].sort((a, b) => b.sessions - a.sessions);
  personList.forEach((p, i) => { p.color = PALETTE[i % PALETTE.length]; });

  // Person <-> person "shared context" links, weighted by how much they share.
  const shared = new Map();
  for (const n of nodes.values()) {
    if (n.type === "session" || n.owners.size < 2) continue;
    const owners = [...n.owners].sort();
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        const key = `p:${owners[i]}|p:${owners[j]}`;
        const s = shared.get(key) || { source: `p:${owners[i]}`, target: `p:${owners[j]}`, type: "shared", weight: 0, items: [] };
        s.weight++;
        if (s.items.length < 25) s.items.push(n.id);
        shared.set(key, s);
      }
    }
  }

  // Parent project hub: every person's globe hangs off it.
  const everyone = personList.map((p) => p.person);
  const hub = { id: HUB_ID, type: "project", name: "DDP", owners: everyone, shared: everyone.length > 1, weight: personList.reduce((a, p) => a + p.sessions, 0) };
  const members = personList.map((p) => ({ source: p.id, target: HUB_ID, type: "member", weight: p.sessions }));

  const outNodes = [
    hub,
    ...personList.map((p) => ({ id: p.id, type: "person", name: p.name, person: p.person, owners: [p.person], color: p.color, sessions: p.sessions, active: p.active, weight: p.sessions })),
    ...[...nodes.values()].map((n) => ({ ...n, owners: [...n.owners], shared: n.owners.size > 1 })),
  ];
  const outLinks = [...members, ...links.values(), ...shared.values()];
  const stats = {
    people: personList.length,
    sessions: outNodes.filter((n) => n.type === "session").length,
    tickets: outNodes.filter((n) => n.type === "ticket").length,
    services: outNodes.filter((n) => n.type === "service").length,
    files: outNodes.filter((n) => n.type === "file").length,
    sharedNodes: outNodes.filter((n) => n.shared).length,
    links: outLinks.length,
  };
  return { nodes: outNodes, links: outLinks, stats, generatedAt: new Date().toISOString() };
}

/** Node ids an observation touches, for live "touch" events. */
export function touchedIds(o, sessionId, ticketPrefixes) {
  const TICKET = ticketRegex(ticketPrefixes);
  const ids = new Set();
  for (const raw of o.files || []) {
    const f = normalizeFile(raw);
    if (f) { ids.add(f.id); ids.add(`s:${f.service}`); }
  }
  for (const t of `${o.title || ""} ${o.narrative || ""}`.match(TICKET) || []) ids.add(`t:${t}`);
  return { sessionNode: `x:${sessionId}`, ids: [...ids] };
}
