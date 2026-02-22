#!/usr/bin/env bash
set -euo pipefail

# Reproduce the validated release-evidence baseline used by M92/M97 gates.
export AUTHZ_ENFORCE="${AUTHZ_ENFORCE:-1}"
export INTEGRATION_ENABLED="${INTEGRATION_ENABLED:-1}"

echo "== verify baseline: M71..M97 =="
for i in $(seq 71 97); do
  echo "== verify:m${i} =="
  npm run "verify:m${i}"
done

echo "== runner gates =="
node verify/runner.mjs milestones/M92.yaml
node verify/runner.mjs milestones/M97.yaml

echo "verify baseline pass"
