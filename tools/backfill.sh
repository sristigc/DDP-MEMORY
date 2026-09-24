#!/usr/bin/env bash
# Backfill old Claude Code DDP sessions into the shared Railway memory.
#
# Flow: local agentmemory server -> import-jsonl -> export -> redact -> scan -> upload.
# Nothing leaves the machine unless the scan is clean.
#
# Usage (Git Bash):
#   ./tools/backfill.sh <path-to-DDP-sessions-folder> [--upload]
#   e.g. ./tools/backfill.sh ~/.claude/projects/C--DDP            # dry run, no upload
#        ./tools/backfill.sh ~/.claude/projects/C--DDP --upload   # upload if clean
#
# Needs: Node 18+, AGENTMEMORY_URL + AGENTMEMORY_SECRET set (Windows user env vars),
#        and the local server started first:  npx -y @agentmemory/agentmemory@0.9.29 --data-dir ./.local-am
set -euo pipefail

SRC="${1:?give the DDP sessions folder, e.g. ~/.claude/projects/C--DDP}"
UPLOAD="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${HERE}/../exports"
LOCAL="http://localhost:3111"
mkdir -p "$OUT"

curl -sf -m 5 "$LOCAL/agentmemory/livez" >/dev/null \
  || { echo "Local agentmemory not running on :3111. Start it first (see README)."; exit 1; }

echo "== 1. Import sessions from $SRC into LOCAL server"
# import-jsonl always talks to localhost, never to AGENTMEMORY_URL.
( unset AGENTMEMORY_URL AGENTMEMORY_SECRET
  npx -y @agentmemory/agentmemory@0.9.29 import-jsonl "$SRC" --max-files 1000 )

echo "== 2. Export from local server"
curl -sf -m 120 "$LOCAL/agentmemory/export" -o "$OUT/raw.export.json"

echo "== 3. Redact"
node "$HERE/redact.mjs" "$OUT/raw.export.json" "$OUT/redacted.export.json"

echo "== 4. Scan"
node "$HERE/scan.mjs" "$OUT/redacted.export.json"
rm -f "$OUT/raw.export.json"   # unredacted copy is never kept

if [ "$UPLOAD" != "--upload" ]; then
  echo "Dry run done. Review exports/redacted.export.json, then re-run with --upload."
  exit 0
fi

: "${AGENTMEMORY_URL:?set AGENTMEMORY_URL}" "${AGENTMEMORY_SECRET:?set AGENTMEMORY_SECRET}"
echo "== 5. Upload to $AGENTMEMORY_URL"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify({exportData:JSON.parse(fs.readFileSync(process.argv[1],"utf8")),strategy:"merge"}))' \
  "$OUT/redacted.export.json" "$OUT/payload.json"
curl -s -m 300 -X POST \
  -H "Authorization: Bearer ${AGENTMEMORY_SECRET}" \
  -H "content-type: application/json" \
  --data-binary @"$OUT/payload.json" \
  "$AGENTMEMORY_URL/agentmemory/import" -w "\nhttp=%{http_code}\n"
rm -f "$OUT/payload.json"
