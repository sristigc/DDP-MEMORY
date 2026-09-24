// Reads service configuration from the environment. Every service imports only what it needs.

export function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function requireEnv(name) {
  const v = env(name);
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

export function intEnv(name, fallback) {
  const n = Number(env(name, fallback));
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function boolEnv(name, fallback = false) {
  const v = env(name);
  return v === undefined ? fallback : ["1", "true", "yes"].includes(String(v).toLowerCase());
}
