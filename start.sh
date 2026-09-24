#!/usr/bin/env bash
# Railway entrypoint for agentmemory.
# Based on the XavTo/agentmemory Railway template, pinned and maintained here.
set -euo pipefail

export HOME=/app
export PATH="/app/.local/bin:${PATH}"

# Railway public API port.
export PORT="${PORT:-8080}"

# Persistent Railway volume paths.
export III_DATA_DIR="${III_DATA_DIR:-/data}"
export AGENTMEMORY_DATA_DIR="${AGENTMEMORY_DATA_DIR:-/data}"

mkdir -p /data /app /app/.agentmemory

echo "[railway] Starting agentmemory"
echo "[railway] PORT=${PORT}"
echo "[railway] AGENTMEMORY_DATA_DIR=${AGENTMEMORY_DATA_DIR}"
echo "[railway] agentmemory version: $(npm ls -g @agentmemory/agentmemory --depth=0 2>/dev/null | grep -o '@[0-9.]*$' || echo unknown)"

if [ -z "${AGENTMEMORY_SECRET:-}" ]; then
  echo "[railway] ERROR: AGENTMEMORY_SECRET is not set. Refusing to start an unauthenticated public server."
  exit 1
fi

echo "[railway] Fixing /data permissions..."
chown -R 65532:65532 /data || true
chmod 755 /data || true

echo "[railway] Testing /data write access..."
echo "ok" > /data/.railway-write-test
rm -f /data/.railway-write-test

DIST_DIR="/usr/local/lib/node_modules/@agentmemory/agentmemory/dist"
SOURCE_CONFIG="${DIST_DIR}/iii-config.docker.yaml"
DEFAULT_CONFIG="${DIST_DIR}/iii-config.yaml"
RAILWAY_CONFIG="/app/iii-config.railway.yaml"

if [ ! -f "$SOURCE_CONFIG" ]; then
  echo "[railway] ERROR: missing ${SOURCE_CONFIG}"
  ls -la "$DIST_DIR" || true
  exit 1
fi

# Start from agentmemory's official Docker config.
cp "$SOURCE_CONFIG" "$RAILWAY_CONFIG"

# Listen on all interfaces inside the container.
sed -i "s/host: 127.0.0.1/host: 0.0.0.0/g" "$RAILWAY_CONFIG"
sed -i "s/host: localhost/host: 0.0.0.0/g" "$RAILWAY_CONFIG"

# Move the REST API from 3111 to Railway's public PORT.
sed -i "0,/port: 3111/s//port: ${PORT}/" "$RAILWAY_CONFIG"

# agentmemory loads this default config path internally.
cp "$RAILWAY_CONFIG" "$DEFAULT_CONFIG"
echo "[railway] Config written to ${DEFAULT_CONFIG}"

echo "[railway] Writing /app/.agentmemory/.env from Railway variables..."
cat > /app/.agentmemory/.env <<EOF
AGENTMEMORY_DATA_DIR=${AGENTMEMORY_DATA_DIR}
III_DATA_DIR=${III_DATA_DIR}
AGENTMEMORY_REQUIRE_HTTPS=${AGENTMEMORY_REQUIRE_HTTPS:-1}
AGENTMEMORY_SECRET=${AGENTMEMORY_SECRET}
PUBLIC_AGENTMEMORY_URL=${PUBLIC_AGENTMEMORY_URL:-}
AGENTMEMORY_AUTO_COMPRESS=${AGENTMEMORY_AUTO_COMPRESS:-false}
AGENTMEMORY_INJECT_CONTEXT=${AGENTMEMORY_INJECT_CONTEXT:-false}
AGENTMEMORY_AGENT_SCOPE=${AGENTMEMORY_AGENT_SCOPE:-shared}
GRAPH_EXTRACTION_ENABLED=${GRAPH_EXTRACTION_ENABLED:-false}
EOF

# Optional keys: only written when set in Railway, so empty values never override defaults.
for var in ANTHROPIC_API_KEY EMBEDDING_PROVIDER; do
  if [ -n "${!var:-}" ]; then
    echo "${var}=${!var}" >> /app/.agentmemory/.env
  fi
done

echo "[railway] Writing preferences.json to skip interactive first-run..."
cat > /app/.agentmemory/preferences.json <<EOF
{
  "schemaVersion": 1,
  "lastAgent": null,
  "lastAgents": [],
  "lastProvider": null,
  "skipSplash": true,
  "skipNpxHint": true,
  "skipGlobalInstall": true,
  "skipConsoleInstall": true,
  "firstRunAt": "2026-09-24T00:00:00.000Z"
}
EOF

chmod 600 /app/.agentmemory/.env /app/.agentmemory/preferences.json || true

echo "[railway] Env preview (secrets hidden):"
grep -vE "SECRET|API_KEY" /app/.agentmemory/.env || true

# Viewer listens on loopback; expose it on the private network only
# (Railway does not route it publicly unless a domain is added for this port).
export VIEWER_PUBLIC_PORT="${VIEWER_PUBLIC_PORT:-8083}"
export VIEWER_INTERNAL_PORT="${VIEWER_INTERNAL_PORT:-8082}"
echo "[railway] Viewer proxy 0.0.0.0:${VIEWER_PUBLIC_PORT} -> 127.0.0.1:${VIEWER_INTERNAL_PORT}"
socat TCP-LISTEN:${VIEWER_PUBLIC_PORT},bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:${VIEWER_INTERNAL_PORT} &

echo "[railway] Launching agentmemory..."
exec agentmemory --port "${PORT}" --verbose
