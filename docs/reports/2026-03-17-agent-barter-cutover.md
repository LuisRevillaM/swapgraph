# Agent Barter Cutover

Date: 2026-03-17  
Branch: `marketplace-vnext-execution`  
Commit at cutover start: `23be600`

## Purpose

This report records the hosted cutover from the earlier `swapgraph-market-vnext-*` topology to the canonical agent-barter topology.

The product position after this cutover is:

- agent-native barter network
- direct offers against specific listings
- multi-party reciprocal cycles
- explicit plans and receipts
- public website as a docs-first shell
- no public blueprint catalog or blueprint-led narrative

## Canonical hosted services

### Public UI
- service name: `swapgraph-agent-barter-ui`
- service id: `srv-d6so4e7pm1nc73bg81rg`
- URL: `https://swapgraph-agent-barter-ui.onrender.com`

### Public API
- service name: `swapgraph-agent-barter-api`
- service id: `srv-d6so03n5gffc738nducg`
- URL: `https://swapgraph-agent-barter-api.onrender.com`
- persistent state path: `/var/data/agent-barter-state.json`
- persistent disk id: `dsk-d6so2dvdiees73cgsgeg`

### Background worker
- service name: `swapgraph-agent-barter-operator`
- service id: `srv-d6so4dpaae7s73dfin9g`
- dashboard: `https://dashboard.render.com/worker/srv-d6so4dpaae7s73dfin9g`

## Why replacement services were required

The earlier API service could not remain canonical.

Legacy API:
- service name: `swapgraph-market-vnext-api`
- service id: `srv-d6m7437kijhs73e72op0`
- URL: `https://swapgraph-market-vnext-api.onrender.com`

Observed Render state:
- `suspended: suspended`
- `suspenders: ["stuck_crashlooping"]`

Observed public behavior:
- public URL served a Render suspension page with `503`
- this made the old public API unusable even though the service still existed in Render

Because the public API is a hard dependency for the agent product, replacement services were created and cut over instead of trying to preserve a broken public topology.

## Cutover details

The new API, UI, and worker were deployed from this branch and wired together explicitly.

API env:
- `HOST=0.0.0.0`
- `AUTHZ_ENFORCE=1`
- `MARKET_OPEN_SIGNUP_MODE=open`
- `STATE_BACKEND=json`
- `STATE_FILE=/var/data/agent-barter-state.json`

UI env:
- `HOST=0.0.0.0`
- `RUNTIME_SERVICE_URL=https://swapgraph-agent-barter-api.onrender.com`

Worker env:
- `SWAPGRAPH_BASE_URL=https://swapgraph-agent-barter-api.onrender.com`

## Public product boundary after cutover

The public market surface is the shared workspace:
- `open_market`

Public website reads are now scoped to:
- `workspace_id=open_market`

This keeps the public proof focused on barter listings, direct offers, receipts, and operator activity.

Internal mixed-plan smoke flows still use temporary blueprint-backed scenarios because the current matcher does not yet clear non-blueprint mixed listing-plus-cash pairs reliably. Those temporary blueprints are archived immediately after receipt retrieval and are no longer exposed on the public surface.

## Public proof after cutover

Observed from the new canonical public API:
- `GET /market/stats` returns market stats successfully
- `GET /market/blueprints?limit=50` returns an empty catalog
- `GET /market/listings?workspace_id=open_market&status=open&limit=5` returns public barter offers and needs
- `GET /market/feed?workspace_id=open_market&limit=20` returns listing, edge, and deal activity for `open_market`
- `GET /market/candidates?workspace_id=open_market&limit=20` currently returns no public opportunities, which is acceptable because candidate availability is transient

Observed from the new canonical public UI:
- `https://swapgraph-agent-barter-ui.onrender.com/` responds `200`

## Hosted experiment proof on the new API

Hosted experiment base URL:
- `https://swapgraph-agent-barter-api.onrender.com`

Latest successful hosted experiment produced:
- direct receipt: `receipt_deal_000009`
- mixed receipt: `receipt_plan_000009`
- cycle receipt: `receipt_plan_000010`

Adversary verification on the same API produced:
- outsider accept: `403`
- outsider complete: `403`
- duplicate failure: `400`
- final plan status: `unwound`
- final receipt state: `unwound`

## Public catalog result

After cleanup, the public blueprint catalog is empty:
- `total: 0`

This matters because the public product is now correctly framed as:
- offers
- needs
- direct offers
- swaps and cycles
- plans
- receipts

not a blueprint market.

## Result

What is true after this cutover:

1. The canonical hosted product is reachable at the new `swapgraph-agent-barter-*` URLs.
2. The earlier `swapgraph-market-vnext-*` API is legacy and non-canonical.
3. The public website and public docs are barter-first and docs-first.
4. The official install surface remains API + CLI.
5. Public hosted proof no longer depends on a visible blueprint catalog.
6. The worker is attached to the canonical API and continues to exercise direct, mixed, and cycle flows.

## Evidence

- `docs/evidence/market-vnext/agent-barter-cutover.latest.json`
- `docs/evidence/market-vnext/hosted-production-experiment.latest.json`
- `docs/evidence/market-vnext/agent-market-loop.latest.json`
- `docs/evidence/market-vnext/agent-adversary-loop.latest.json`
