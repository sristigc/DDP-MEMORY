// DDP System canvas: groups of services (from galaxy/system/*.md) with live status and connections
// that animate while traffic flows. Data: /galaxy/api/system, live updates: "system" SSE events.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICONS = {
  terminal: '<path d="M4 6l5 5-5 5"/><path d="M12 18h8"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  memory: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"/>',
  graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8 7.5l7.5 0.5M7 8l2.5 7.5M16.5 10l-5 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
};
const CHECK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';
const STATE_LABEL = { up: "online", down: "down", unknown: "unknown", scheduled: "scheduled", active: "active", idle: "idle" };

let data = null;
let focus = null;

function render() {
  const grid = $("grid");
  grid.innerHTML = data.groups.map((g) => {
    const members = data.services.filter((s) => s.group === g.name);
    const bad = g.operational < g.total;
    return `<section class="group" data-group="${esc(g.name)}">
      <h2>${esc(g.title)}</h2>
      <p class="desc">${esc(g.description)}</p>
      <div class="tiles">${members.map(tile).join("")}</div>
      <div class="foot${bad ? " bad" : ""}">${CHECK}${g.operational} of ${g.total} ${g.total === 1 ? "service" : "services"} operational</div>
    </section>`;
  }).join("");
  for (const el of grid.querySelectorAll(".tile")) el.onclick = () => showDetail(el.dataset.name);
  const up = data.services.filter((s) => s.state !== "down").length;
  $("summary").textContent = `${up} of ${data.services.length} services healthy · ${data.edges.filter((e) => e.state === "busy").length} connections busy · checked ${new Date(data.at).toLocaleTimeString()}`;
  requestAnimationFrame(drawWires);
}

function tile(s) {
  return `<div class="tile${focus === s.name ? " on" : ""}" data-name="${esc(s.name)}" data-state="${esc(s.state)}" title="${esc(s.detail)}">
    <div class="ico"><svg viewBox="0 0 24 24">${ICONS[s.icon] || ICONS.cog}</svg><span class="dot"></span></div>
    <div class="name">${esc(s.title)} <small>${esc(STATE_LABEL[s.state] || s.state)}${s.external ? " · off Railway" : ""}</small></div>
    <div class="what">${esc(s.description)}</div>
  </div>`;
}

// Draw each connection as a curve between the two service tiles, with its state as a class.
function drawWires() {
  const svg = $("wires");
  const board = $("board").getBoundingClientRect();
  svg.setAttribute("width", board.width);
  svg.setAttribute("height", board.height);
  const box = (name) => {
    const el = document.querySelector(`.tile[data-name="${CSS.escape(name)}"] .ico`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - board.left + r.width / 2, y: r.top - board.top + r.height / 2, w: r.width, h: r.height };
  };
  const paths = data.edges.map((e) => {
    const a = box(e.from), b = box(e.to);
    if (!a || !b) return "";
    const dx = b.x - a.x, dy = b.y - a.y;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const c1 = horizontal ? { x: a.x + dx / 2, y: a.y } : { x: a.x, y: a.y + dy / 2 };
    const c2 = horizontal ? { x: a.x + dx / 2, y: b.y } : { x: b.x, y: a.y + dy / 2 };
    const end = horizontal ? { x: b.x - Math.sign(dx) * (b.w / 2 + 4), y: b.y } : { x: b.x, y: b.y - Math.sign(dy) * (b.h / 2 + 4) };
    const start = horizontal ? { x: a.x + Math.sign(dx) * (a.w / 2 + 4), y: a.y } : { x: a.x, y: a.y + Math.sign(dy) * (a.h / 2 + 4) };
    const cls = ["wire", e.state === "off" ? "" : e.state, focus && (e.from === focus || e.to === focus) ? "focus" : ""].filter(Boolean).join(" ");
    return `<path class="${cls}" marker-end="url(#arr)" d="M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}"><title>${esc(e.from)} → ${esc(e.to)}: ${e.state}</title></path>`;
  }).join("");
  const defs = svg.querySelector("defs").outerHTML;
  svg.innerHTML = defs + paths;
}

// toggle=true on click (open/close); false when live data refreshes an open panel.
function showDetail(name, toggle = true) {
  if (toggle) focus = focus === name ? null : name;
  const s = data.services.find((x) => x.name === name);
  const box = $("detail");
  if (!focus || !s) { box.style.display = "none"; render(); return; }
  const outs = data.edges.filter((e) => e.from === name).map((e) => `${e.to} (${e.state})`);
  const ins = data.edges.filter((e) => e.to === name).map((e) => `${e.from} (${e.state})`);
  box.style.display = "block";
  box.innerHTML = `<button class="close" id="closeDetail" aria-label="Close">✕</button>
    <h3>${esc(s.title)}</h3><div style="color:var(--muted)">${esc(s.description)}</div>
    <dl class="kv">
      <dt>Status</dt><dd>${esc(STATE_LABEL[s.state] || s.state)} · ${esc(s.detail)}</dd>
      ${s.railway ? `<dt>Railway</dt><dd>${esc(s.railway)}</dd>` : ""}
      ${s.cron ? `<dt>Schedule</dt><dd>${esc(s.cron)}</dd>` : ""}
      <dt>Calls</dt><dd>${esc(outs.join(", ") || "—")}</dd>
      <dt>Called by</dt><dd>${esc(ins.join(", ") || "—")}</dd>
      ${s.notes ? `<dt>Notes</dt><dd>${esc(s.notes)}</dd>` : ""}
    </dl>`;
  $("closeDetail").onclick = () => showDetail(name);
  render();
}

async function load() {
  const res = await fetch("api/system", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  data = await res.json();
  render();
}

function connect() {
  const es = new EventSource("api/events");
  es.addEventListener("hello", () => { $("status").textContent = "● LIVE"; $("status").style.color = "var(--live)"; });
  es.addEventListener("system", (e) => { data = JSON.parse(e.data); render(); if (focus) showDetail(focus, false); });
  es.onerror = () => { $("status").textContent = "RECONNECTING…"; $("status").style.color = "var(--warn)"; };
}

addEventListener("resize", () => data && drawWires());
load().then(connect).catch((err) => { $("status").textContent = `ERROR: ${err.message}`; });
