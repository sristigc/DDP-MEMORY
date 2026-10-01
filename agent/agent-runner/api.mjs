// Small HTTP API on the runner. Railway uses /healthz; people reach /agent/* through the
// viewer-proxy (same password login as the dashboard). The runner has no public domain of its own.
//   GET  /agent/jobs[?status=]        recent jobs
//   GET  /agent/jobs/:id              one job with its step events
//   POST /agent/jobs/:id/resume       {"note": "..."}  continue after the local log check
// Used by ddp-worker (office machine) for the local steps:
//   POST /agent/jobs/claim-local      {"workerId": "..."}  lease the oldest paused job (204 if none)
//   POST /agent/jobs/:id/events       {"step","type","message","data"}  record a local step
//   POST /agent/jobs/:id/release      {"workerId": "..."}  give the lease back untouched
//   POST /agent/jobs/:id/phase        {"workerId","patch"}  record fix progress on the job (lease holder only)
// Approval gate (people, through the dashboard login):
//   GET  /agent/jobs/:id/review       HTML: proposed change, build result, Approve / Reject
//   POST /agent/jobs/:id/approve | /reject   decide on a fix waiting for approval

const EVENT_TYPES = new Set(["info", "plan", "handoff", "error", "done"]);
const WORKER_ID_RE = /^[\w.@-]{1,120}$/;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

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

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Minimal review page for the approval gate (behind the dashboard login; no scripts). */
export function reviewPage(job) {
  const fix = job.result?.fix || {};
  const r = job.result || {};
  const waiting = r.phase === "awaiting_approval" && !r.decision;
  const state = r.decision ? `Decision: ${r.decision}` : r.phase ? `Phase: ${r.phase}` : `Status: ${job.status}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review ${esc(job.jira_key)}</title>
<style>body{margin:0;padding:24px 20px;background:#000;color:#e4e4e8;font:14px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:0 auto;display:grid;gap:16px}
h1{font-size:20px;margin:0}.muted{color:#8b8b93}pre{background:#0d0d10;border:1px solid #26262c;padding:12px;overflow:auto;max-height:60vh;font:12px/1.5 ui-monospace,Consolas,monospace}
.row{display:flex;gap:10px;flex-wrap:wrap}button{font:600 14px system-ui;padding:10px 18px;border-radius:4px;border:1px solid #444;cursor:pointer}
.ok{background:#e4e4e8;color:#000}.no{background:#000;color:#e4e4e8}dl{display:grid;grid-template-columns:140px 1fr;gap:4px 12px;margin:0}dt{color:#8b8b93}</style></head>
<body><main>
<h1>${esc(job.jira_key)} · proposed fix (job ${job.id})</h1>
<div class="muted">${esc(job.summary)} — ${esc(state)}</div>
<dl><dt>Repository</dt><dd>${esc(fix.repo || "—")}</dd><dt>Branch</dt><dd>${esc(fix.branch || "—")} (from ${esc(fix.base || "—")})</dd>
<dt>Build</dt><dd>${esc(fix.build || "—")}</dd><dt>Files</dt><dd>${esc(fix.diffStat || "—")}</dd><dt>PR</dt><dd>${fix.prUrl ? `<a href="${esc(fix.prUrl)}" style="color:#e4e4e8">${esc(fix.prUrl)}</a>` : "—"}</dd></dl>
<div><strong>What changed</strong><pre>${esc(fix.summary || "—")}</pre></div>
<div><strong>Diff</strong><pre>${esc(fix.diff || "—")}</pre></div>
${waiting ? `<div class="row"><form method="post" action="/agent/jobs/${job.id}/approve"><button class="ok">Approve: commit, push, open draft PR</button></form>
<form method="post" action="/agent/jobs/${job.id}/reject"><button class="no">Reject</button></form></div>` : ""}
</main></body></html>`;
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
      if (req.method === "POST" && parts.length === 2) { // manual (re)queue of a ticket, e.g. to retry it
        const { jiraKey, summary = "", url: link = "" } = await readJson(req);
        if (!JIRA_KEY_RE.test(String(jiraKey || ""))) return send(res, 400, { error: "jiraKey like DPB-2070 is required" });
        if (link && !/^https:\/\/[^\s"<>]+$/.test(link)) return send(res, 400, { error: "url must be https" });
        const { created, job } = await store.enqueue({ jiraKey, summary: String(summary).slice(0, 300), url: link });
        log.info(created ? "job queued manually" : "ticket already has an open job", { jobId: job.id, jiraKey });
        return send(res, created ? 201 : 200, { created, job });
      }
      if (req.method === "POST" && parts[2] === "claim-local" && parts.length === 3) {
        const { workerId, jiraKey = null } = await readJson(req);
        if (!WORKER_ID_RE.test(String(workerId || ""))) return send(res, 400, { error: "workerId is required (letters, digits, . _ - @)" });
        if (jiraKey !== null && !JIRA_KEY_RE.test(String(jiraKey))) return send(res, 400, { error: "jiraKey must look like DPB-2070" });
        const job = await store.claimLocal(workerId, undefined, jiraKey);
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
      if (req.method === "POST" && parts[3] === "phase" && parts.length === 4) {
        const { workerId, patch } = await readJson(req, 512 * 1024);
        const job = await store.get(id);
        if (!job) return send(res, 404, { error: "job not found" });
        if (job.locked_by !== workerId) return send(res, 409, { error: "job is not leased to this worker" });
        if (!patch || typeof patch !== "object" || "decision" in patch) return send(res, 400, { error: "patch object required (decision is set by people)" });
        return send(res, 200, { job: await store.patchResult(id, patch) });
      }
      if (req.method === "POST" && (parts[3] === "approve" || parts[3] === "reject") && parts.length === 4) {
        const job = await store.get(id);
        if (!job) return send(res, 404, { error: "job not found" });
        if (job.result?.phase !== "awaiting_approval" || job.result?.decision) return send(res, 409, { error: "job has no fix waiting for approval" });
        const decision = parts[3] === "approve" ? "approved" : "rejected";
        await store.patchResult(id, { decision, decidedAt: new Date().toISOString() });
        await store.addEvent(id, { step: "approval", type: "info", message: `Fix ${decision} from the dashboard` });
        log.info("fix decision", { jobId: id, decision });
        if ((req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) {
          res.writeHead(303, { location: `/agent/jobs/${id}/review` }).end();
          return;
        }
        return send(res, 200, { decision });
      }
      if (req.method === "GET" && parts[3] === "review" && parts.length === 4) {
        const job = await store.get(id);
        if (!job) return send(res, 404, { error: "job not found" });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(reviewPage(job));
        return;
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
