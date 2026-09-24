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

  async get(jobId) { const j = this.jobs.get(jobId); return j ? { ...j } : null; }
  async events(jobId) { return [...(this.jobEvents.get(jobId) || [])]; }
  async list({ status, limit = 50 } = {}) {
    return [...this.jobs.values()].filter((j) => !status || j.status === status).sort((a, b) => b.id - a.id).slice(0, limit).map((j) => ({ ...j }));
  }
  async close() {}
}
