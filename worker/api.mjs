// Client for the DDP-AGENT jobs API on Railway (reached through the dashboard login).

export class JobsApi {
  constructor({ apiUrl, apiUser, apiPass, fetchImpl = fetch }) {
    this.base = apiUrl;
    this.auth = `Basic ${Buffer.from(`${apiUser}:${apiPass}`).toString("base64")}`;
    this.fetch = fetchImpl;
  }

  async call(method, path, body) {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.status === 401) throw new Error("dashboard login rejected (check DDP_API_USER / DDP_API_PASS)");
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}${json?.error ? `: ${json.error}` : ""}`);
    return json;
  }

  claim(workerId) { return this.call("POST", "/jobs/claim-local", { workerId }); }
  event(jobId, ev) { return this.call("POST", `/jobs/${jobId}/events`, ev); }
  release(jobId, workerId) { return this.call("POST", `/jobs/${jobId}/release`, { workerId }); }
  resume(jobId, note) { return this.call("POST", `/jobs/${jobId}/resume`, { note }); }
  phase(jobId, workerId, patch) { return this.call("POST", `/jobs/${jobId}/phase`, { workerId, patch }); }
  reviewUrl(jobId) { return `${this.base}/jobs/${jobId}/review`; }
}
