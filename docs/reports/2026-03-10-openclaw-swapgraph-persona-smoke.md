# OpenClaw SwapGraph Persona Smoke

Date: 2026-03-10
Branch: `marketplace-vnext-execution`

## Purpose

Prove that SwapGraph is not only scriptable by local Node scripts, but can also be entered through OpenClaw personas anchored to this repo.

## What was done

1. Added a repo-local OpenClaw wrapper:
   - `./scripts/openclaw-node22.sh`
2. Used the wrapper to avoid the local Node 18 vs Node 22 mismatch.
3. Added repo-anchored OpenClaw personas:
   - `swapgraph_market_operator`
   - `swapgraph_buyer`
   - `swapgraph_seller`
   - `swapgraph_broker`
   - `swapgraph_verifier`
4. Invoked a real local agent turn with:

```bash
./scripts/openclaw-node22.sh agent --local --agent swapgraph_market_operator \
  --message "From this workspace, tell me in two bullets what SwapGraph clears and which command runs the hosted production experiment." \
  --json
```

## Result

The local OpenClaw persona executed successfully.

Returned summary:

- SwapGraph clears direct and multi-party agent work transactions by turning obligations into explicit plans and receipts.
- Hosted experiment command:
  - `SWAPGRAPH_BASE_URL=https://swapgraph-market-vnext-api.onrender.com node scripts/run-hosted-market-production-experiment.mjs`

## Important finding

The original `openclaw` CLI failure was not a product bug in SwapGraph.

It was a runtime mismatch:

- installed OpenClaw CLI path was under Node 22
- current shell default was Node 18

The repo-local wrapper fixes that path deterministically for future agents.

## Why this matters

This is the first proof in this repo that:

- OpenClaw personas can be rooted in the SwapGraph workspace
- those personas can read repo context and answer correctly
- the path toward longer-running agent personas is practical, not speculative
