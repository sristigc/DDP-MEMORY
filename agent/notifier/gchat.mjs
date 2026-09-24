// Google Chat incoming-webhook sender. Formats one short card-less text message per event.

const ICON = { queued: "📥", awaiting_local: "🖥️", succeeded: "✅", failed: "❌", info: "ℹ️" };

export function formatMessage({ text, kind = "info", jiraKey, jobId }) {
  const head = `${ICON[kind] || ICON.info} *DDP-AGENT*${jiraKey ? ` · ${jiraKey}` : ""}${jobId ? ` · job ${jobId}` : ""}`;
  return { text: `${head}\n${String(text).slice(0, 3500)}` };
}

export async function sendToGoogleChat(webhookUrl, message, fetchImpl = fetch) {
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Google Chat webhook returned HTTP ${res.status}`);
}
