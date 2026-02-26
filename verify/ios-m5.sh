#!/usr/bin/env bash
set -euo pipefail

M="IOS-M5"
ROOT="/Users/luisrevilla/code/swapgraph"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="${ROOT}/artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="${ROOT}/artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

HOME_DIR="${ROOT}/.codex-home"
CLANG_CACHE_DIR="${ROOT}/.clang-module-cache"
mkdir -p "$HOME_DIR" "$CLANG_CACHE_DIR"

{
  echo "# verify ${M}"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "HOME=$HOME_DIR"
  echo "CLANG_MODULE_CACHE_PATH=$CLANG_CACHE_DIR"
  echo "$ HOME=$HOME_DIR CLANG_MODULE_CACHE_PATH=$CLANG_CACHE_DIR swift test"
  echo "$ node scripts/ios/run-sc-ux-04.mjs > $OUT_DIR/sc-ux-04.json"
  echo "$ node scripts/ios/run-sc-an-01.mjs > $OUT_DIR/sc-an-01.json"
  echo "$ node scripts/ios/run-sc-api-01.mjs > $OUT_DIR/sc-api-01.json"
  echo "$ node scripts/ios/run-sc-api-04.mjs > $OUT_DIR/sc-api-04.json"
  echo "$ node scripts/ios/run-sc-api-03.mjs > $OUT_DIR/sc-api-03.json"
  echo "$ node scripts/ios/run-sc-ds-01.mjs > $OUT_DIR/sc-ds-01.json"
  echo "$ node scripts/ios/run-sc-ds-02.mjs > $OUT_DIR/sc-ds-02.json"
} > "$OUT_DIR/commands.log"

(
  cd "${ROOT}/ios/MarketplaceClient"
  HOME="$HOME_DIR" CLANG_MODULE_CACHE_PATH="$CLANG_CACHE_DIR" swift test > "$OUT_DIR/swift-test.log"
)

node scripts/ios/run-sc-ux-04.mjs > "$OUT_DIR/sc-ux-04.json"
node scripts/ios/run-sc-an-01.mjs > "$OUT_DIR/sc-an-01.json"
node scripts/ios/run-sc-api-01.mjs > "$OUT_DIR/sc-api-01.json"
node scripts/ios/run-sc-api-04.mjs > "$OUT_DIR/sc-api-04.json"
node scripts/ios/run-sc-api-03.mjs > "$OUT_DIR/sc-api-03.json"
node scripts/ios/run-sc-ds-01.mjs > "$OUT_DIR/sc-ds-01.json"
node scripts/ios/run-sc-ds-02.mjs > "$OUT_DIR/sc-ds-02.json"

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/swift-test.log" "$LATEST_DIR/swift-test.log"
cp "$OUT_DIR/sc-ux-04.json" "$LATEST_DIR/sc-ux-04.json"
cp "$OUT_DIR/sc-an-01.json" "$LATEST_DIR/sc-an-01.json"
cp "$OUT_DIR/sc-api-01.json" "$LATEST_DIR/sc-api-01.json"
cp "$OUT_DIR/sc-api-04.json" "$LATEST_DIR/sc-api-04.json"
cp "$OUT_DIR/sc-api-03.json" "$LATEST_DIR/sc-api-03.json"
cp "$OUT_DIR/sc-ds-01.json" "$LATEST_DIR/sc-ds-01.json"
cp "$OUT_DIR/sc-ds-02.json" "$LATEST_DIR/sc-ds-02.json"

echo "verify ${M} pass"
