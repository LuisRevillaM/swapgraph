#!/bin/zsh
set -euo pipefail

OPENCLAW_NODE_BIN="${OPENCLAW_NODE_BIN:-/Users/luisrevilla/.nvm/versions/node/v22.14.0/bin/node}"
OPENCLAW_ENTRY="${OPENCLAW_ENTRY:-/Users/luisrevilla/.nvm/versions/node/v22.14.0/lib/node_modules/openclaw/openclaw.mjs}"

if [[ ! -x "$OPENCLAW_NODE_BIN" ]]; then
  echo "[swapgraph] missing Node runtime for OpenClaw: $OPENCLAW_NODE_BIN" >&2
  exit 1
fi

if [[ ! -f "$OPENCLAW_ENTRY" ]]; then
  echo "[swapgraph] missing OpenClaw entrypoint: $OPENCLAW_ENTRY" >&2
  exit 1
fi

exec "$OPENCLAW_NODE_BIN" "$OPENCLAW_ENTRY" "$@"
