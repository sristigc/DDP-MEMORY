// notifier HTTP handler: POST /notify {text, kind, jiraKey, jobId} with a Bearer token.
// Only reachable on Railway's private network; other services share NOTIFIER_TOKEN.
import { timingSafeEqual } from "node:crypto";
import { formatMessage, sendToGoogleChat } from "./gchat.mjs";

function tokenOk(header, token) {
  if (!token) return false;
  const given = Buffer.from(String(header || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createNotifier({ token, webhookUrl, log, fetchImpl = fetch }) {
  const stats = { sent: 0, dropped: 0, failed: 0, webhook: !!webhookUrl };
  return async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/healthz") return reply(200, { ok: true, ...stats });
    if (req.url !== "/notify" || req.method !== "POST") return reply(404, { error: "not found" });
    if (!tokenOk(req.headers.authorization, token)) return reply(401, { error: "unauthorized" });

    let body;
    try {
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 16384) return reply(413, { error: "body too large" }); }
      body = JSON.parse(raw || "{}");
    } catch { return reply(400, { error: "invalid JSON" }); }
    if (!body.text) return reply(400, { error: "text is required" });

    const message = formatMessage(body);
    if (!webhookUrl) {
      stats.dropped++;
      log.info("no GCHAT_WEBHOOK_URL; message logged only", { kind: body.kind, jiraKey: body.jiraKey, jobId: body.jobId });
      return reply(202, { delivered: false, reason: "webhook not configured" });
    }
    try {
      await sendToGoogleChat(webhookUrl, message, fetchImpl);
      stats.sent++;
      return reply(200, { delivered: true });
    } catch (err) {
      stats.failed++;
      log.error("google chat delivery failed", { error: err.message });
      return reply(502, { delivered: false, error: "delivery failed" });
    }
  };
}
