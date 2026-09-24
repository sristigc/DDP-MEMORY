// Fake private-network responses for local previews (DUMMY=1): healthy services whose counters move,
// so the System canvas shows busy and heartbeat connections without Railway.

export const DUMMY_ENV = {
  AGENTMEMORY_URL: "http://agentmemory.local",
  AGENTMEMORY_SECRET: "dummy",
  RUNNER_URL: "http://runner.local",
  NOTIFIER_URL: "http://notifier.local",
  VIEWER_URL: "http://viewer.local",
};

export function makeDummyFetch(now = () => Date.now()) {
  const t0 = now();
  const tick = () => Math.floor((now() - t0) / 20000); // counters advance every 20s
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
  return async (url) => {
    if (url.startsWith(DUMMY_ENV.VIEWER_URL)) return reply(401, null);
    if (url.startsWith(DUMMY_ENV.AGENTMEMORY_URL)) return reply(200, { status: "healthy", version: "0.9.29" });
    if (url === `${DUMMY_ENV.RUNNER_URL}/healthz`) return reply(200, { ok: true, mode: "dry-run", processed: tick(), lastError: null });
    if (url === `${DUMMY_ENV.RUNNER_URL}/agent/jobs`) {
      const n = tick();
      const jobs = Array.from({ length: n }, (_, i) => ({ id: i + 1, jira_key: `HDP-${1000 + i}`, status: i === n - 1 ? "awaiting_local" : "succeeded", created_at: new Date(t0 + i * 20000).toISOString() }));
      return reply(200, { jobs });
    }
    if (url === `${DUMMY_ENV.NOTIFIER_URL}/healthz`) return reply(200, { ok: true, webhook: false, sent: 0, dropped: tick(), failed: 0 });
    return reply(404, null);
  };
}
