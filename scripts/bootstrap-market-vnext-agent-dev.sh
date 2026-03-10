#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d node_modules ]]; then
  npm ci
fi

: "${HOST:=127.0.0.1}"
: "${PORT:=3005}"
: "${AUTHZ_ENFORCE:=1}"
: "${STATE_BACKEND:=json}"
: "${STATE_FILE:=/tmp/swapgraph-market-vnext-agent-dev.json}"

mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"

cat <<EOF
{
  "ok": true,
  "root_dir": "$ROOT_DIR",
  "host": "$HOST",
  "port": "$PORT",
  "authz_enforce": "$AUTHZ_ENFORCE",
  "state_backend": "$STATE_BACKEND",
  "state_file": "$STATE_FILE",
  "start_api_command": "AUTHZ_ENFORCE=$AUTHZ_ENFORCE HOST=$HOST PORT=$PORT STATE_BACKEND=$STATE_BACKEND STATE_FILE=$STATE_FILE npm run start:api"
}
EOF
