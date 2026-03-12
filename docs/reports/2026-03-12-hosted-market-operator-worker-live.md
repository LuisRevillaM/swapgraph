# Hosted Market Operator Worker Live

Date: 2026-03-12  
Branch: `marketplace-vnext-execution`  
Worker commit: `f40882d`

## Purpose

Move the hosted SwapGraph market from one-shot production experiments to a continuous production agent loop.

This report records the first successful Render background worker deployment that:

- seeds the hosted market
- runs the hosted happy-path agent loop
- periodically runs the hosted adversary loop
- leaves observable receipts and stats changes on the public market

## Live services

- UI: `https://swapgraph-market-vnext-ui.onrender.com`
- API: `https://swapgraph-market-vnext-api.onrender.com`
- Worker dashboard: `https://dashboard.render.com/worker/srv-d6pholdm5p6s73fu5n60`

## Service configuration

Render background worker:

- service id: `srv-d6pholdm5p6s73fu5n60`
- service name: `swapgraph-market-operator`
- deploy id: `dep-d6phs94r85hc73dumre0`
- deploy commit: `f40882ddf69cd8df431385f25cdf634e85f35916`
- start command: `node scripts/run-market-operator-worker.mjs`

Worker env:

- `SWAPGRAPH_BASE_URL=https://swapgraph-market-vnext-api.onrender.com`
- `MARKET_OPERATOR_INTERVAL_MS=900000`
- `MARKET_OPERATOR_ADVERSARY_EVERY=6`

## What the worker does

Each cycle:

1. runs `scripts/seed-market-agent-personas.mjs`
2. runs `scripts/run-agent-market-loop.mjs`
3. every sixth cycle, runs `scripts/run-agent-adversary-loop.mjs`
4. prints a machine-readable JSON summary to app logs

The worker is not a fake heartbeat. It performs real market actions against the hosted API.

## First observed live cycle

Observed in Render app logs after the live deploy:

- direct receipt: `receipt_deal_000008`
- mixed-plan receipt: `receipt_plan_000009`
- cycle-plan receipt: `receipt_plan_000010`

The log line emitted a `market_operator_worker_cycle` JSON object with:

- `ok: true`
- `iteration: 1`
- `base_url: https://swapgraph-market-vnext-api.onrender.com`

## Fresh hosted verification after worker launch

I reran the hosted agent loops after the worker was live.

Happy path:

- direct:
  - `deal_000009`
  - `receipt_deal_000009`
- mixed:
  - `plan_000012`
  - `receipt_plan_000012`
- cycle:
  - `plan_000013`
  - `receipt_plan_000013`

Adversary path:

- outsider accept: `403`
- outsider complete: `403`
- duplicate failure: `400`
- final plan status: `unwound`
- final receipt state: `unwound`

## Hosted market state after launch

Observed stats:

- `actors: 40`
- `workspaces: 17`
- `listings_open: 46`
- `wants_open: 18`
- `capabilities_open: 6`
- `deals_completed: 8`

This matters because the hosted system is no longer only a human-clickable demo or a manually kicked script. It now has a continuous production operator loop creating and verifying activity.

## Product implications

What is now true:

1. The hosted market teaches direct offers, blueprints, plans, and receipts.
2. The hosted API clears direct, mixed, and cycle transactions.
3. The hosted deployment has an always-on operator exercising the product continuously.
4. The agent story is no longer only local CLI smoke; it is running on Render against the live market.

## Evidence

- `docs/evidence/market-vnext/hosted-market-operator-worker-live.json`
- `docs/evidence/market-vnext/agent-market-loop.latest.json`
- `docs/evidence/market-vnext/agent-adversary-loop.latest.json`
