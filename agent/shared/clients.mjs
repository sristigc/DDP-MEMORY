// HTTP clients for the other services. All calls are best-effort with timeouts:
// a notifier or memory outage must never fail a job.

export class NotifierClient {
  constructor({ url, token, log }) {
    this.url = url ? url.replace(/\/+$/, "") : null;
    this.token = token;
    this.log = log;
  }

  async send({ text, jobId, jiraKey, kind = "info" }) {
    if (!this.url) { this.log.warn("notifier not configured; message dropped", { kind, jobId }); return false; }
    try {
      const res = await fetch(`${this.url}/notify`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ text, jobId, jiraKey, kind }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) this.log.warn("notifier rejected message", { status: res.status });
      return res.ok;
    } catch (err) {
      this.log.warn("notifier unreachable", { error: err.message });
      return false;
    }
  }
}

export class MemoryClient {
  constructor({ url, secret, log }) {
    this.url = url ? url.replace(/\/+$/, "") : null;
    this.secret = secret;
    this.log = log;
  }

  /** Saves a note to shared team memory so people (and the graph) see automated work too. */
  async remember(content, concepts = []) {
    if (!this.url || !this.secret) return false;
    try {
      const res = await fetch(`${this.url}/agentmemory/remember`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.secret}` },
        body: JSON.stringify({ content, type: "fact", concepts: ["ddp-agent", ...concepts], project: "DDP" }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch (err) {
      this.log.warn("agentmemory unreachable", { error: err.message });
      return false;
    }
  }

  /** Past context for a ticket: used by step 1 so the agent starts from what the team already knows. */
  async recall(query, limit = 10) {
    if (!this.url || !this.secret) return [];
    try {
      const res = await fetch(`${this.url}/agentmemory/smart-search`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.secret}` },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      return (await res.json()).results || [];
    } catch (err) {
      this.log.warn("agentmemory recall failed", { error: err.message });
      return [];
    }
  }
}
