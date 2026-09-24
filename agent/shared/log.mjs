// One-line JSON logs so Railway can filter by service/level. Never log secrets or customer data.

// Field names that hold credentials. Deliberately narrow so ids like jiraKey stay readable.
const SECRET_KEYS = /pass(word|wd)?$|secret|token|api[_-]?key|^authorization$|^cookie$/i;

function scrub(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) out[k] = SECRET_KEYS.test(k) ? "***" : scrub(v);
  return out;
}

export function logger(service) {
  const write = (level, msg, data) => {
    const line = { at: new Date().toISOString(), level, service, msg, ...(data ? scrub(data) : {}) };
    (level === "error" ? console.error : console.log)(JSON.stringify(line));
  };
  return {
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
  };
}
