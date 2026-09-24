// DDP Galaxy — Obsidian-style constellation graph (3D/2D) with per-person groups and live highlighting.
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import ForceGraph3D from "https://esm.sh/3d-force-graph@1.80.0?external=three";
import SpriteText from "https://esm.sh/three-spritetext@1.10.0?external=three";
import { forceX, forceY, forceZ } from "https://esm.sh/d3-force-3d@3.0.6";

// Dark, restrained palette. Only pure white is bright enough to trip the glow (bloom threshold),
// so just the DDP parent and live threads/nodes glow; everything else stays matte.
const C = { bg: "#000000", ivory: "#d4d4d8", muted: "#6b6b70", gold: "#ffffff", live: "#ffffff", link: "#4a4a50", session: "#55555c" };
// "Role" colouring (default), all greyscale: parent white, people light grey, own work dark grey,
// shared context a lighter mid-grey. Only the parent is pure white, so only it (and live threads) glow.
const ROLE = { project: "#ffffff", person: "#d0d0d4", own: "#6e6e74", shared: "#b4b4ba", session: "#4a4a50" };
const PERSON_TONES = ["#6f86d6", "#c0607f", "#4fa58f", "#d08a3c", "#9d7bd8", "#7ea7c9", "#c9a86b", "#8fb89a"];
const SERVICE_TONES = ["#c46a3a", "#7b8fd6", "#5fae91", "#c0607f", "#b89b5e", "#9d7bd8", "#6fa7b8", "#a7715c", "#8fb89a", "#d2a14a", "#7f6fb0", "#b0707f"];
const TYPE_TONES = { project: "#ffffff", person: "#e6e6e6", ticket: "#c8c8c8", service: "#a0a0a6", file: "#7c7c82", session: C.session };
const MONO = ["#d9d9d9", "#b8b8bc", "#9a9aa0", "#c9c9cc", "#a9a9ae", "#8c8c92", "#bdbdc1", "#9f9fa4"];
const HUB = "hub:DDP";
const LIVE_GLOW_MS = 90e3;
const $ = (id) => document.getElementById(id);

const ui = {
  dims: 3, colorBy: "role", labels: "people", globes: true, bloom: true,
  nodeSize: 1, linkWidth: 0, linkOpacity: 0.4,
  center: 0.008, repel: 90, linkForce: 0.06, linkDist: 90, groupPull: 0.04,
  filters: { ticket: true, service: true, file: true, session: false }, sharedOnly: false, query: "",
};
const state = { data: null, byId: new Map(), people: new Map(), services: new Map(), linkIndex: new Map(), glow: new Map(), sharedGlow: new Map(), pulses: new Map(), globes: new Map(), unseen: 0, feedOpen: false, fitted: false };

// ---------- colour groups ----------
function groupColor(n) {
  switch (ui.colorBy) {
    case "role":
      if (n.type === "project") return ROLE.project;
      if (n.type === "person") return ROLE.person;
      if (n.type === "session") return ROLE.session;
      return n.shared ? ROLE.shared : ROLE.own;
    case "service": {
      const svc = n.service || (n.type === "service" ? n.name : null);
      return svc ? state.services.get(svc) || C.ivory : TYPE_TONES[n.type] || C.ivory;
    }
    case "type": return TYPE_TONES[n.type] || C.ivory;
    case "mono": {
      const p = state.people.get(n.type === "person" ? n.person : n.owners[0]);
      return p ? MONO[p.index % MONO.length] : C.ivory;
    }
    default: {
      if (n.type === "session") return C.session;
      const p = state.people.get(n.type === "person" ? n.person : n.owners[0]);
      return p ? PERSON_TONES[p.index % PERSON_TONES.length] : C.ivory;
    }
  }
}
const isLive = (id) => (state.glow.get(id) || 0) > Date.now() || !!state.byId.get(id)?.live;
function colorOf(n) {
  if (isLive(n.id)) return C.live;
  if (n.type === "project") return C.gold;
  if (n.shared && (ui.colorBy === "person" || ui.colorBy === "mono")) return ROLE.shared;
  return groupColor(n);
}
function sizeOf(n) {
  const base = { project: 40, person: 12, ticket: 1.5 + Math.min(n.weight, 60) / 12, service: 3 + Math.min(n.weight, 300) / 60, session: 0.8 }[n.type] ?? 0.5 + Math.min(n.weight, 30) / 15;
  return base * ui.nodeSize;
}

// ---------- labels ----------
// Labels are the only extra drawn on top of a ball (shared context is shown by shade alone).
// Labels: only people/hub, optionally tickets — like Obsidian, details on hover.
function labelObject(n) {
  const show = n.type === "project" || n.type === "person" || (ui.labels === "tickets" && n.type === "ticket");
  if (ui.labels === "none" && n.type !== "project") return null;
  if (!show) return null;
  const text = n.type === "project" ? "DDP" : n.type === "person" ? n.name.toUpperCase() : n.name;
  // Label colours stay below pure white so labels never bloom.
  const s = new SpriteText(text, n.type === "project" ? 12 : n.type === "person" ? 6.5 : 3.2, n.type === "ticket" ? "#b8b8be" : "#dcdce0");
  s.fontFace = n.type === "ticket" ? "Inter" : "Space Grotesk";
  s.fontWeight = "600";
  s.position.y = Math.cbrt(sizeOf(n)) * 4 + (n.type === "project" ? 10 : 6);
  return s;
}

// ---------- forces ----------
function groupForce() {
  let nodes = [];
  const force = (alpha) => {
    if (!ui.groupPull) return;
    for (const n of nodes) {
      if (n.type === "person" || n.type === "project") continue;
      const ps = n.owners.map((o) => state.byId.get(`p:${o}`)).filter((p) => p && p.x !== undefined);
      if (!ps.length) continue;
      const t = ps.reduce((a, p) => ({ x: a.x + p.x / ps.length, y: a.y + p.y / ps.length, z: a.z + (p.z || 0) / ps.length }), { x: 0, y: 0, z: 0 });
      const k = ui.groupPull * (ps.length > 1 ? 0.5 : 1) * alpha;
      n.vx += (t.x - n.x) * k; n.vy += (t.y - n.y) * k;
      if (ui.dims === 3) n.vz += (t.z - n.z) * k;
    }
  };
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

function applyForces(reheat = true) {
  Graph.d3Force("charge").strength((n) => -ui.repel * (n.type === "project" ? 20 : n.type === "person" ? 14 : 1)).distanceMax(2500);
  Graph.d3Force("link")
    .strength((l) => (l.type === "shared" ? 0 : l.type === "member" ? 0.02 : ui.linkForce))
    .distance((l) => (l.type === "member" ? 600 : l.type === "owns" ? ui.linkDist * 1.5 : ui.linkDist));
  Graph.d3Force("x", forceX(0).strength(ui.center));
  Graph.d3Force("y", forceY(0).strength(ui.center));
  Graph.d3Force("z", ui.dims === 3 ? forceZ(0).strength(ui.center) : null);
  Graph.d3Force("group", groupForce());
  if (reheat) Graph.d3ReheatSimulation();
}

// ---------- graph ----------
const Graph = ForceGraph3D({ controlType: "orbit" })($("graph"))
  .backgroundColor(C.bg)
  .showNavInfo(false)
  .nodeRelSize(4)
  .nodeResolution(10)
  .nodeOpacity(0.85)
  .nodeLabel((n) => `<div style="font:13px Inter,sans-serif;color:${C.ivory};background:rgba(10,10,12,.94);border:1px solid #2a2a2f;padding:6px 9px;max-width:360px">
      <b style="font-family:'Space Grotesk',sans-serif">${esc(n.name)}</b><br><span style="color:#8a8a90">${n.type}${n.path ? ` · ${esc(n.path)}` : ""}</span><br>${n.owners.map(nameOf).join(", ")}</div>`)
  .nodeThreeObjectExtend(true)
  .linkCurvature(0)
  .onNodeClick(focusNode)
  .onBackgroundClick(() => { $("right").style.display = "none"; })
  .warmupTicks(60)
  .cooldownTicks(300)
  .onEngineStop(() => { if (!state.fitted) { state.fitted = true; fit(); } });

const controls = Graph.controls();
// Zoom goes toward the mouse pointer, with a wide range so you can get right up to a single file.
Object.assign(controls, { enableDamping: true, dampingFactor: 0.1, zoomSpeed: 1.2, zoomToCursor: true, rotateSpeed: 0.5, panSpeed: 0.8, minDistance: 4, maxDistance: 12000, screenSpacePanning: true });
let bloomPass = null;
try {
  // High threshold: only pure white (live threads, live nodes, DDP) crosses it and glows.
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.5, 0.55, 0.9);
  bloomPass.enabled = ui.bloom;
  Graph.postProcessingComposer().addPass(bloomPass);
}
catch (e) { console.warn("glow disabled", e); }
addEventListener("resize", () => Graph.width(innerWidth).height(innerHeight));

function ends(l) { return [l.source?.id ?? l.source, l.target?.id ?? l.target]; }
function linkLive(l) {
  const [s, t] = ends(l);
  if (l.type === "member") return !!state.byId.get(s)?.active;
  if (l.type === "shared") return (state.sharedGlow.get(`${s}|${t}`) || 0) > Date.now();
  return isLive(s) && isLive(t);
}
function applyStyles(rebuildLabels = false) {
  if (rebuildLabels) Graph.nodeThreeObject(labelObject);
  Graph.nodeVal(sizeOf)
    .nodeColor(colorOf)
    .nodeVisibility(isVisible)
    .linkVisibility(linkVisible)
    .linkOpacity(ui.linkOpacity)
    // Grey-and-white threads: work threads dark grey, person↔DDP mid grey, shared-context threads near white;
    // live threads get their own bright material (full opacity) and glow.
    .linkColor((l) => (l.type === "shared" ? "#cfcfd4" : l.type === "member" ? "#8a8a90" : C.link))
    .linkMaterial((l) => (linkLive(l) ? LIVE_THREAD : null))
    .linkWidth((l) => (linkLive(l) ? Math.max(ui.linkWidth, 0.7) : ui.linkWidth))
    .linkDirectionalParticles(0);
}
const LIVE_THREAD = new THREE.MeshBasicMaterial({ color: C.live, transparent: true, opacity: 1, depthWrite: false });

function isVisible(n) {
  if (!n) return false;
  if (n.type === "person" || n.type === "project") return true;
  if (n.type === "session" && isLive(n.id)) return true; // live sessions always show so their edges light up
  if (!ui.filters[n.type]) return false;
  if (ui.sharedOnly && !n.shared) return false;
  if (ui.query) {
    const q = ui.query;
    return n.name.toLowerCase().includes(q) || (n.path || "").toLowerCase().includes(q) || (n.service || "").includes(q) || n.owners.some((o) => o.includes(q));
  }
  return true;
}
function linkVisible(l) { const [s, t] = ends(l); return isVisible(state.byId.get(s)) && isVisible(state.byId.get(t)); }

async function loadGraph(keepPositions) {
  const res = await fetch("api/graph", { cache: "no-store" });
  if (!res.ok) throw new Error(`graph HTTP ${res.status}`);
  const data = await res.json();
  const old = new Map((state.data?.nodes || []).map((n) => [n.id, n]));
  if (keepPositions) for (const n of data.nodes) { const o = old.get(n.id); if (o) Object.assign(n, { x: o.x, y: o.y, z: o.z }); }

  const people = data.nodes.filter((n) => n.type === "person");
  people.forEach((p, i) => { p.index = i; });
  state.people = new Map(people.map((p) => [p.person, p]));
  const services = [...new Set(data.nodes.map((n) => n.service || (n.type === "service" ? n.name : null)).filter(Boolean))].sort();
  state.services = new Map(services.map((s, i) => [s, SERVICE_TONES[i % SERVICE_TONES.length]]));
  const hub = data.nodes.find((n) => n.id === HUB);
  if (hub) Object.assign(hub, { fx: 0, fy: 0, fz: 0 });
  state.data = data;
  state.byId = new Map(data.nodes.map((n) => [n.id, n]));

  Graph.graphData(data);
  indexLinks();
  applyStyles(true);
  applyForces(false);
  renderGroups();
  renderStats();
  drawGlobes();
}

function indexLinks() {
  state.linkIndex.clear();
  for (const l of Graph.graphData().links) { const [s, t] = ends(l); state.linkIndex.set(`${s}|${t}`, l); state.linkIndex.set(`${t}|${s}`, l); }
}

// ---------- optional person globes (follow the person as the layout moves) ----------
function drawGlobes() {
  const scene = Graph.scene();
  for (const g of state.globes.values()) scene.remove(g);
  state.globes.clear();
  if (!ui.globes) return;
  const counts = new Map();
  for (const n of state.data.nodes) if (n.owners?.length === 1 && !["person", "project"].includes(n.type)) counts.set(n.owners[0], (counts.get(n.owners[0]) || 0) + 1);
  for (const p of state.people.values()) {
    const r = 30 + Math.sqrt(counts.get(p.person) || 1) * 6;
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshBasicMaterial({ color: groupColor(p), wireframe: true, transparent: true, opacity: 0.06, depthWrite: false }));
    const field = new THREE.LineSegments(fieldLines(r), new THREE.LineBasicMaterial({ color: groupColor(p), transparent: true, opacity: 0.07, depthWrite: false }));
    g.add(shell, field);
    g.userData = { person: p.person, shell, field };
    scene.add(g);
    state.globes.set(p.person, g);
  }
}

// Dipole "magnetic field" loops around a globe: r = L·sin²θ, swept around the vertical axis.
function fieldLines(radius) {
  const pts = [];
  for (const L of [1.35, 1.8]) {
    for (let k = 0; k < 8; k++) {
      const phi = (k / 8) * Math.PI * 2;
      let prev = null;
      for (let i = 0; i <= 48; i++) {
        const th = (i / 48) * Math.PI;
        const rr = radius * L * Math.sin(th) ** 2;
        const v = new THREE.Vector3(rr * Math.sin(th) * Math.cos(phi), rr * Math.cos(th), rr * Math.sin(th) * Math.sin(phi));
        if (prev) pts.push(prev, v);
        prev = v;
      }
    }
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

// ---------- panel ----------
function nameOf(person) { return state.people.get(person)?.name || person; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function renderStats() {
  const s = state.data.stats;
  $("statsline").innerHTML = `<b>${s.people}</b> people · <b>${s.tickets}</b> tickets · <b>${s.services}</b> services · <b>${s.files}</b> files · <b>${s.sharedNodes}</b> shared`;
}

function renderGroups() {
  let rows = [];
  if (ui.colorBy === "role") {
    rows = [
      { key: HUB, label: "DDP (parent)", color: ROLE.project },
      ...[...state.people.values()].map((p) => ({ key: p.id, label: p.name, color: ROLE.person, live: p.active, extra: `${p.sessions}` })),
      { key: "own", label: "Their own tickets / files", color: ROLE.own },
      { key: "shared", label: "Shared by 2+ people", color: ROLE.shared },
    ];
  } else if (ui.colorBy === "person" || ui.colorBy === "mono") {
    rows = [...state.people.values()].map((p) => ({ key: p.id, label: p.name, color: groupColor(p), live: p.active, extra: `${p.sessions}` }));
    if (ui.colorBy === "person") rows.push({ key: "shared", label: "Shared by 2+", color: C.gold });
  } else if (ui.colorBy === "service") {
    rows = [...state.services].map(([s, c]) => ({ key: `s:${s}`, label: s.replace(/^(novopay|trustt)-platform-/, ""), color: c }));
  } else {
    rows = Object.entries(TYPE_TONES).map(([t, c]) => ({ key: `type:${t}`, label: t, color: c }));
  }
  rows.push({ key: "live", label: "Live now (glowing thread)", color: C.live });
  $("groups").innerHTML = rows.map((r) => `<div class="group" data-key="${esc(r.key)}"><span class="swatch" style="background:${r.color}"></span>${esc(r.label)}${r.extra ? ` <span class="muted">${r.extra}</span>` : ""}${r.live ? '<span class="live-tag">LIVE</span>' : ""}</div>`).join("");
  for (const el of document.querySelectorAll(".group")) el.onclick = () => {
    const n = state.byId.get(el.dataset.key);
    if (n) focusNode(n);
  };
}

function showDetails(n) {
  const neighbours = Graph.graphData().links.filter((l) => ends(l).includes(n.id))
    .map((l) => { const [s, t] = ends(l); return state.byId.get(s === n.id ? t : s); })
    .filter((x) => x && x.type !== "session").sort((a, b) => b.weight - a.weight).slice(0, 18);
  $("right").style.display = "block";
  $("right").innerHTML = `<span class="close" id="closeRight">✕</span><h3>${esc(n.name)}</h3>
    <div class="muted">${n.type}${n.shared ? " · <span style='color:var(--gold);font-style:normal'>shared context</span>" : ""}${isLive(n.id) ? " · <span style='color:var(--live);font-style:normal'>live</span>" : ""}</div>
    <h4>Details</h4><dl class="kv"><dt>People</dt><dd>${n.owners.map((o) => esc(nameOf(o))).join(", ")}</dd>
      ${n.service ? `<dt>Service</dt><dd>${esc(n.service)}</dd>` : ""}${n.path ? `<dt>Path</dt><dd>${esc(n.path)}</dd>` : ""}<dt>Activity</dt><dd>${Math.round(n.weight)}</dd></dl>
    <h4>Connected</h4>${neighbours.map((x) => `<div>${esc(x.name)} <span class="muted">${x.type}</span></div>`).join("") || '<div class="muted">—</div>'}`;
  $("closeRight").onclick = () => { $("right").style.display = "none"; };
}

// ---------- camera ----------
function fit(ms = 900) { Graph.zoomToFit(ms, 60, isVisible); }
function zoomBy(f) {
  const cam = Graph.camera().position, t = controls.target;
  const d = new THREE.Vector3().subVectors(cam, t);
  d.setLength(THREE.MathUtils.clamp(d.length() * f, controls.minDistance, controls.maxDistance));
  Graph.cameraPosition({ x: t.x + d.x, y: t.y + d.y, z: t.z + d.z }, { x: t.x, y: t.y, z: t.z }, 350);
}
function focusNode(n) {
  if (!n) return;
  const dist = n.type === "project" ? 500 : n.type === "person" ? 220 : 90;
  if (ui.dims === 2) Graph.cameraPosition({ x: n.x, y: n.y, z: dist }, { x: n.x, y: n.y, z: 0 }, 900);
  else {
    const r = Math.hypot(n.x || 0, n.y || 0, n.z || 0) || 1;
    Graph.cameraPosition({ x: n.x + (n.x / r) * dist, y: n.y + dist * 0.3, z: n.z + ((n.z || 0) / r || 1) * dist }, n, 900);
  }
  showDetails(n);
}

// ---------- controls wiring ----------
function bindSlider(id, key, onChange) {
  const el = $(id), out = $(`v-${id}`);
  const show = () => { out.textContent = Number(el.value).toString(); };
  el.value = ui[key]; show();
  el.oninput = () => { ui[key] = Number(el.value); show(); onChange(); };
}
bindSlider("nodeSize", "nodeSize", () => applyStyles(true));
bindSlider("linkWidth", "linkWidth", () => applyStyles());
bindSlider("linkOpacity", "linkOpacity", () => applyStyles());
for (const [id, key] of [["center", "center"], ["repel", "repel"], ["linkForce", "linkForce"], ["linkDist", "linkDist"], ["groupPull", "groupPull"]]) bindSlider(id, key, () => applyForces());
$("reheat").onclick = () => { applyForces(); state.fitted = false; };

for (const b of document.querySelectorAll("#dimSeg button")) b.onclick = () => {
  ui.dims = Number(b.dataset.dim);
  document.querySelectorAll("#dimSeg button").forEach((x) => x.classList.toggle("on", x === b));
  Graph.numDimensions(ui.dims);
  controls.enableRotate = ui.dims === 3;
  applyForces();
  state.fitted = false;
  if (ui.dims === 2) Graph.cameraPosition({ x: 0, y: 0, z: 1600 }, { x: 0, y: 0, z: 0 }, 600);
};
for (const b of document.querySelectorAll("#colorBySeg button")) b.onclick = () => {
  ui.colorBy = b.dataset.by;
  document.querySelectorAll("#colorBySeg button").forEach((x) => x.classList.toggle("on", x === b));
  applyStyles(true); renderGroups(); drawGlobes();
};
for (const cb of document.querySelectorAll("input[data-type]")) cb.onchange = () => { ui.filters[cb.dataset.type] = cb.checked; applyStyles(); };
$("sharedOnly").onchange = (e) => { ui.sharedOnly = e.target.checked; applyStyles(); };
$("search").oninput = (e) => { ui.query = e.target.value.trim().toLowerCase(); applyStyles(); };
$("labels").onchange = (e) => { ui.labels = e.target.value; applyStyles(true); };
$("globes").onchange = (e) => { ui.globes = e.target.checked; drawGlobes(); };
$("bloom").onchange = (e) => { ui.bloom = e.target.checked; if (bloomPass) bloomPass.enabled = ui.bloom; };
$("zoomIn").onclick = () => zoomBy(0.5);
$("zoomOut").onclick = () => zoomBy(2);
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "+" || e.key === "=") zoomBy(0.6);
  else if (e.key === "-") zoomBy(1.6);
  else if (e.key.toLowerCase() === "f") fit();
});
$("fitBtn").onclick = () => fit();
$("liveBtn").onclick = () => {
  state.feedOpen = !state.feedOpen;
  $("feed").style.display = state.feedOpen ? "block" : "none";
  $("liveBtn").classList.toggle("on", state.feedOpen);
  if (state.feedOpen) { state.unseen = 0; $("badge").hidden = true; }
};

// ---------- live ----------
let restyleQueued = false;
function restyleSoon() {
  if (restyleQueued) return;
  restyleQueued = true;
  setTimeout(() => { restyleQueued = false; applyStyles(); }, 400);
}

function onTouch(ev) {
  const until = Date.now() + LIVE_GLOW_MS;
  for (const id of [ev.sessionNode, `p:${ev.person}`, ...ev.ids]) state.glow.set(id, until);
  for (const id of ev.ids) state.pulses.set(id, performance.now() + 2500);
  state.pulses.set(`p:${ev.person}`, performance.now() + 1500);
  const others = new Set();
  for (const id of ev.shared) for (const o of state.byId.get(id)?.owners || []) if (o !== ev.person) others.add(o);
  for (const o of others) {
    const l = state.linkIndex.get(`p:${ev.person}|p:${o}`);
    if (l) { const [s, t] = ends(l); state.sharedGlow.set(`${s}|${t}`, until); }
    state.pulses.set(`p:${o}`, performance.now() + 1500);
  }
  restyleSoon();
  addFeed(ev, others);
}

function addFeed(ev, others) {
  const items = ev.ids.map((id) => state.byId.get(id)).filter((n) => n && n.type !== "service");
  const what = items.slice(0, 2).map((n) => n.name).join(", ") || "context";
  const verb = { file_edit: "edited", file_write: "wrote", file_read: "read", command_run: "ran a command on", search: "searched" }[ev.type] || "touched";
  const div = document.createElement("div");
  div.className = `ev${others.size ? " shared" : ""}`;
  div.innerHTML = `<time>${new Date(ev.at || Date.now()).toLocaleTimeString()}</time><b>${esc(nameOf(ev.person))}</b> ${verb} <span class="what">${esc(what)}</span>${others.size ? esc(` — shared with ${[...others].map(nameOf).join(", ")}`) : ""}`;
  const box = $("events");
  if (box.firstElementChild?.classList.contains("muted")) box.innerHTML = "";
  box.prepend(div);
  while (box.children.length > 80) box.lastChild.remove();
  if (!state.feedOpen) { state.unseen++; $("badge").hidden = false; $("badge").textContent = state.unseen > 99 ? "99+" : state.unseen; }
}

setInterval(() => {
  const now = Date.now();
  let expired = false;
  for (const m of [state.glow, state.sharedGlow]) for (const [k, t] of m) if (t < now) { m.delete(k); expired = true; }
  if (expired) restyleSoon();
}, 5000);

function animate() {
  const now = performance.now();
  for (const [id, until] of state.pulses) {
    const obj = state.byId.get(id)?.__threeObj;
    if (!obj) { state.pulses.delete(id); continue; }
    if (now > until) { obj.scale.setScalar(1); state.pulses.delete(id); continue; }
    obj.scale.setScalar(1 + 0.25 * Math.abs(Math.sin(now / 260)));
  }
  for (const [person, g] of state.globes) {
    const p = state.byId.get(`p:${person}`);
    if (p?.x !== undefined) g.position.set(p.x, p.y, p.z || 0);
    const { shell, field } = g.userData;
    const col = p?.active ? C.live : groupColor(p || {});
    shell.material.opacity = 0.06 + (p?.active ? 0.04 + 0.03 * Math.sin(now / 420) : 0);
    field.material.opacity = 0.07 + (p?.active ? 0.05 + 0.04 * Math.sin(now / 420) : 0);
    shell.material.color.set(col);
    field.material.color.set(col);
    g.rotation.y += 0.0006;
  }
  requestAnimationFrame(animate);
}

function connect() {
  const es = new EventSource("api/events");
  es.addEventListener("hello", () => { $("status").textContent = "● LIVE"; $("status").style.color = C.live; });
  es.addEventListener("touch", (e) => onTouch(JSON.parse(e.data)));
  es.addEventListener("graph", async (e) => {
    const g = JSON.parse(e.data);
    for (const p of state.people.values()) p.active = g.active.includes(p.id);
    if (g.nodesChanged) await loadGraph(true);
    renderGroups(); renderStats(); restyleSoon();
  });
  es.onerror = () => { $("status").textContent = "RECONNECTING…"; $("status").style.color = "#c9884a"; };
}

// Sprite labels are drawn to canvas, so load the fonts first.
Promise.all([document.fonts.load("600 16px 'Space Grotesk'"), document.fonts.load("500 16px Inter")]).catch(() => {})
  .then(() => loadGraph(false))
  .then(() => { connect(); animate(); })
  .catch((e) => { $("status").textContent = `ERROR: ${e.message}`; console.error(e); });
