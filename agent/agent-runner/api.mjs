// Small HTTP API on the runner. Railway uses /healthz; people reach /agent/* through the
// viewer-proxy (same password login as the dashboard). The runner has no public domain of its own.
//   GET  /agent/jobs[?status=]        recent jobs
//   GET  /agent/jobs/:id              one job with its step events
//   POST /agent/jobs/:id/resume       {"note": "..."}  continue after the local log check

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
      return send(res, 405, { error: "method not allowed" });
    } catch (err) {
      log.error("api error", { path: url.pathname, error: err.message });
      return send(res, err.status || 500, { error: err.status ? err.message : "internal error" });
    }
  };
}
