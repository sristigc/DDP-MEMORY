// Small HTTP API on the runner. Railway uses /healthz; people reach /agent/* through the
// viewer-proxy (same password login as the dashboard). The runner has no public domain of its own.
//   GET  /agent/jobs[?status=]        recent jobs
//   GET  /agent/jobs/:id              one job with its step events
//   POST /agent/jobs/:id/resume       {"note": "..."}  continue after the local log check
// Used by ddp-worker (office machine) for the local steps:
//   POST /agent/jobs/claim-local      {"workerId": "..."}  lease the oldest paused job (204 if none)
//   POST /agent/jobs/:id/events       {"step","type","message","data"}  record a local step
//   POST /agent/jobs/:id/release      {"workerId": "..."}  give the lease back untouched

const EVENT_TYPES = new Set(["info", "plan", "handoff", "error", "done"]);
const WORKER_ID_RE = /^[\w.@-]{1,120}$/;

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function send(res, code, body) {
  res.writeHead(code, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

export function createApi({ store, stats, log }) {
  return async (req, res) => {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean); // ["agent","jobs",":id","resume"]
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true, ...stats });
      if (parts[0] !== "agent" || parts[1] !== "jobs") return send(res, 404, { error: "not found" });

      if (req.method === "GET" && parts.length === 2) {
        const status = url.searchParams.get("status") || undefined;
        return send(res, 200, { jobs: await store.list({ status, limit: 100 }) });
      }
      if (req.method === "POST" && parts[2] === "claim-local" && parts.length === 3) {
        const { workerId } = await readJson(req);
        if (!WORKER_ID_RE.test(String(workerId || ""))) return send(res, 400, { error: "workerId is required (letters, digits, . _ - @)" });
        const job = await store.claimLocal(workerId);
        if (!job) { res.writeHead(204).end(); return; }
        log.info("job leased to local worker", { jobId: job.id, jiraKey: job.jira_key, workerId });
        return send(res, 200, { job, events: await store.events(job.id) });
      }
      const id = Number(parts[2]);
      if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: "job id must be a positive integer" });

      if (req.method === "GET" && parts.length === 3) {
        const job = await store.get(id);
        return job ? send(res, 200, { job, events: await store.events(id) }) : send(res, 404, { error: "job not found" });
      }
      if (req.method === "POST" && parts[3] === "resume" && parts.length === 4) {
        const { note = "" } = await readJson(req);
        const job = await store.resume(id, String(note).slice(0, 2000));
        if (!job) return send(res, 409, { error: "job is not waiting for a local step" });
        log.info("job resumed", { jobId: id });
        return send(res, 200, { job });
      }
      if (req.method === "POST" && parts[3] === "events" && parts.length === 4) {
        const { step, type, message, data = {} } = await readJson(req, 256 * 1024);
        if (!step || !message || !EVENT_TYPES.has(type)) return send(res, 400, { error: `step, message and type (${[...EVENT_TYPES].join("/")}) are required` });
        if (!(await store.get(id))) return send(res, 404, { error: "job not found" });
        await store.addEvent(id, { step: String(step).slice(0, 60), type, message: String(message).slice(0, 4000), data });
        return send(res, 201, { ok: true });
      }
      if (req.method === "POST" && parts[3] === "release" && parts.length === 4) {
        const { workerId } = await readJson(req);
        const job = await store.releaseLocal(id, String(workerId || ""));
        return job ? send(res, 200, { job }) : send(res, 409, { error: "job is not leased to this worker" });
      }
      return send(res, 405, { error: "method not allowed" });
    } catch (err) {
      log.error("api error", { path: url.pathname, error: err.message });
      return send(res, err.status || 500, { error: err.status ? err.message : "internal error" });
    }
  };
}
