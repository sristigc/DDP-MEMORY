#!/bin/sh
set -eu

: "${AUTH_USER:?AUTH_USER is required}"
: "${AUTH_PASS:?AUTH_PASS is required}"
: "${UPSTREAM_URL:?UPSTREAM_URL is required, e.g. http://agentmemory.railway.internal:8083}"

# Hash with Caddy's built-in bcrypt; the password is passed as an argument, never
# interpolated into code, so quotes or special characters are safe.
AUTH_PASS_HASH=$(caddy hash-password --plaintext "$AUTH_PASS")
export AUTH_PASS_HASH

echo "[viewer-proxy] user=${AUTH_USER} upstream=${UPSTREAM_URL} host-header=${VIEWER_HOST_HEADER:-localhost:8082}"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
