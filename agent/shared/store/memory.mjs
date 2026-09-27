// In-memory job store with the same semantics as the Postgres one (see index.mjs contract).

const OPEN = new Set(["queued", "running", "awaiting_local"]);

export class MemoryStore {
  constructor() {
    this.jobs = new Map();
    this.jobEvents = new Map();
    this.seq = 0;
    this.eventSeq = 0;
  }

  async migrate() {}

  async enqueue({ jiraKey, summary = "", url = "" }) {
    const open = [...this.jobs.values()].find((j) => j.jira_key === jiraKey && OPEN.has(j.status));
    if (open) return { created: false, job: { ...open } };
    const now = new Date().toISOString();
    const job = { id: ++this.seq, jira_key: jiraKey, summary, url, status: "queued", attempts: 0, locked_by: null, locked_at: null, result: {}, created_at: now, updated_at: now };
    this.jobs.set(job.id, job);
    this.jobEvents.set(job.id, []);
    return { created: true, job: { ...job } };
  }

  async claim(workerId, staleAfterMs = 30 * 60e3) {
    const now = Date.now();
    const candidates = [...this.jobs.values()]
      .filter((j) => j.status === "queued" || (j.status === "running" && Date.parse(j.locked_at) < now - staleAfterMs))
      .sort((a, b) => a.id - b.id);
    const job = candidates[0];
    if (!job) return null;
    Object.assign(job, { status: "running", attempts: job.attempts + 1, locked_by: workerId, locked_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
    return { ...job };
  }

  async addEvent(jobId, { step, type, message, data = {} }) {
    if (!this.jobs.has(jobId)) throw new Error(`job ${jobId} not found`);
    this.jobEvents.get(jobId).push({ id: ++this.eventSeq, job_id: jobId, step, type, message, data, at: new Date().toISOString() });
  }

  async finish(jobId, status, result = {}) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    Object.assign(job, { status, result, locked_by: null, locked_at: null, updated_at: new Date().toISOString() });
    return { ...job };
  }

  async resume(jobId, note = "") {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "awaiting_local") return null;
    Object.assign(job, { status: "queued", result: { ...job.result, localNote: note }, updated_at: new Date().toISOString() });
    return { ...job };
  }

  // ---------- learning loop ----------
  async lastJob(jiraKey) {
    return [...this.jobs.values()].filter((j) => j.jira_key === jiraKey).sort((a, b) => b.id - a.id).map((j) => ({ ...j }))[0] || null;
  }

  async jobsToScore() {
    return [...this.jobs.values()].filter((j) => ["succeeded", "failed", "awaiting_local"].includes(j.status)).map((j) => ({ ...j }));
  }

  async recordEpisode({ jobId, jiraKey, reward, signals }) {
    this.episodes = this.episodes || new Map();
    this.episodes.set(jobId, { job_id: jobId, jira_key: jiraKey, reward, signals, scored_at: new Date().toISOString() });
  }

  async getEpisode(jobId) { const e = (this.episodes || new Map()).get(jobId); return e ? { ...e } : null; }

  async listEpisodes(limit = 100) {
    return [...(this.episodes || new Map()).values()].sort((a, b) => b.job_id - a.job_id).slice(0, limit);
  }

  async reinforceLesson({ scope, kind, text, reward, alpha = 0.3 }) {
    this.lessons = this.lessons || new Map();
    const key = `${scope}|${kind}|${text}`;
    const l = this.lessons.get(key) || { id: this.lessons.size + 1, scope, kind, text, weight: 0, evidence: 0 };
    l.weight = l.weight + alpha * (reward - l.weight);
    l.evidence += 1;
    l.updated_at = new Date().toISOString();
    this.lessons.set(key, l);
    return { ...l };
  }

  async topLessons(scopes, limit = 10) {
    return [...(this.lessons || new Map()).values()]
      .filter((l) => scopes.includes(l.scope))
      .sort((a, b) => b.evidence - a.evidence || Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, limit).map((l) => ({ ...l }));
  }

  async get(jobId) { const j = this.jobs.get(jobId); return j ? { ...j } : null; }
  async events(jobId) { return [...(this.jobEvents.get(jobId) || [])]; }
  async list({ status, limit = 50 } = {}) {
    return [...this.jobs.values()].filter((j) => !status || j.status === status).sort((a, b) => b.id - a.id).slice(0, limit).map((j) => ({ ...j }));
  }
  async close() {}
}
