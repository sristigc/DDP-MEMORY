// Data sources for the galaxy: the live agentmemory server, or generated dummy data.
// Both expose: load() -> snapshot, poll() -> { newObs: [{sessionId, obs}], changed }.

import { makeDummyWorld } from "./dummy.mjs";

export const OWNER_TAG = "galaxy-session-owner";

/** Parses "galaxy-session-owner {json}" memories into sessionId -> person. */
export function parseOwners(memories) {
  const owners = new Map();
  for (const m of memories || []) {
    const text = typeof m.content === "string" ? m.content : "";
    const at = text.indexOf(OWNER_TAG);
    if (at < 0) continue;
    try {
      const rec = JSON.parse(text.slice(at + OWNER_TAG.length).trim());
      if (rec.sessionId && rec.person) owners.set(rec.sessionId, String(rec.person).toLowerCase());
    } catch { /* not ours */ }
  }
  return owners;
}

export class AgentmemorySource {
  constructor({ url, secret, defaultPerson, activeWindowMs }) {
    this.base = url.replace(/\/+$/, "") + "/agentmemory";
    this.secret = secret;
    this.defaultPerson = defaultPerson;
    this.activeWindowMs = activeWindowMs;
    this.sessions = [];
    this.obsBySession = new Map();
    this.counts = new Map();
    this.ownerOf = new Map();
  }

  async get(path) {
    const res = await fetch(this.base + path, {
      headers: { Authorization: `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`agentmemory ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  async fetchObs(sessionId) {
    const r = await this.get(`/observations?sessionId=${encodeURIComponent(sessionId)}&limit=5000`);
    return r.observations || [];
  }

  async refreshOwners() {
    const r = await this.get("/memories?agentId=*&limit=5000");
    const owners = parseOwners(r.memories || r);
    for (const s of this.sessions) {
      if (!owners.has(s.id) && this.defaultPerson) owners.set(s.id, this.defaultPerson);
    }
    this.ownerOf = owners;
  }

  async load() {
    this.sessions = (await this.get("/sessions")).sessions || [];
    for (const s of this.sessions) {
      this.obsBySession.set(s.id, await this.fetchObs(s.id));
      this.counts.set(s.id, s.observationCount || 0);
    }
    await this.refreshOwners();
    return this.snapshot();
  }

  /** Re-reads session list; fetches observations only for sessions that grew. */
  async poll() {
    const sessions = (await this.get("/sessions")).sessions || [];
    const newObs = [];
    let changed = sessions.length !== this.sessions.length;
    for (const s of sessions) {
      const before = this.counts.get(s.id);
      if (before === s.observationCount) continue;
      changed = true;
      const known = new Set((this.obsBySession.get(s.id) || []).map((o) => o.id));
      const obs = await this.fetchObs(s.id);
      for (const o of obs) if (!known.has(o.id)) newObs.push({ sessionId: s.id, obs: o });
      this.obsBySession.set(s.id, obs);
      this.counts.set(s.id, s.observationCount || 0);
    }
    this.sessions = sessions;
    if (changed) await this.refreshOwners();
    return { changed, newObs };
  }

  activeSessions() {
    const cutoff = Date.now() - this.activeWindowMs;
    const active = new Set();
    for (const s of this.sessions) {
      if (s.status === "active") { active.add(s.id); continue; }
      const obs = this.obsBySession.get(s.id) || [];
      const last = obs.length ? Date.parse(obs[obs.length - 1].timestamp) : 0;
      if (last > cutoff) active.add(s.id);
    }
    return active;
  }

  snapshot() {
    return { sessions: this.sessions, obsBySession: this.obsBySession, ownerOf: this.ownerOf };
  }
}

/** Five fake teammates with overlapping tickets/services, plus a live simulator. */
export class DummySource {
  constructor({ live, activeWindowMs }) {
    this.world = makeDummyWorld();
    this.live = live;
    this.activeWindowMs = activeWindowMs;
  }

  async load() { return this.snapshot(); }

  async poll() {
    if (!this.live) return { changed: false, newObs: [] };
    const newObs = this.world.tick();
    return { changed: newObs.length > 0, newObs };
  }

  activeSessions() { return this.world.activeSessions(this.activeWindowMs); }

  snapshot() {
    const { sessions, obsBySession, ownerOf } = this.world;
    return { sessions, obsBySession, ownerOf };
  }
}
