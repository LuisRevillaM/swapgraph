# Render Agent Market Topology

Last updated: 2026-03-17T12:00:00Z

## Purpose

This document records the exact Render topology for the active agent barter product line.

## Canonical product services

### Canonical web UI
- service name: `swapgraph-market-vnext-ui`
- service id: `srv-d6m74jnkijhs73fqjnl0`
- type: `web_service`
- public URL: `https://swapgraph-market-vnext-ui.onrender.com`
- branch: `marketplace-vnext-execution`
- classification: `canonical`
- role: external-facing public UI

### Canonical API
- service name: `swapgraph-market-vnext-api`
- service id: `srv-d6m7437kijhs73e72op0`
- type: `web_service`
- public URL: `https://swapgraph-market-vnext-api.onrender.com`
- branch: `marketplace-vnext-execution`
- classification: `canonical only if externally reachable`
- role: external-facing public API
- current issue observed: public URL returns `503` with `x-render-routing: suspend-by-user`
- latest known live deploy id from Render metadata: `dep-d6pi0l15pdvs73bn2nv0`
- latest known deploy commit from Render metadata: `a7b327c0cc3b4aa3c72cf2fe614c3902475b445e`

### Canonical background worker
- service name: `swapgraph-market-operator`
- service id: `srv-d6pholdm5p6s73fu5n60`
- type: `background_worker`
- public URL: none
- branch: `marketplace-vnext-execution`
- classification: `canonical`
- role: continuous hosted operator loop against the live market API

## Legacy or non-canonical adjacent services

### Legacy web UI
- service name: `swapgraph-marketplace-web`
- service id: `srv-d6f2qh41hm7c73avc9d0`
- type: `web_service`
- public URL: `https://swapgraph-marketplace-web.onrender.com`
- classification: `legacy`
- role: older marketplace web client lineage

### Legacy runtime API
- service name: `swapgraph-runtime-api`
- service id: `srv-d6dlfgvgi27c738jtkhg`
- type: `web_service`
- public URL: `https://swapgraph-runtime-api.onrender.com`
- classification: `legacy`
- role: older runtime API surface, not the canonical agent barter surface

### Legacy feed worker
- service name: `graph-board-feed-worker`
- service id: `srv-d6k5i2rh46gs73eb5umg`
- type: `background_worker`
- public URL: none
- classification: `legacy`
- role: older background process outside the canonical agent barter surface

## Product split

The human-first marketplace lineage is a separate product track.

These Render services should not define the public story or canonical URLs for the agent barter branch:
- `swapgraph-marketplace-web`
- `swapgraph-runtime-api`
- `graph-board-feed-worker`

## Current operational conclusion

The topology is only truly canonical when both of these are true:
1. the public UI is reachable
2. the public API is reachable

As of this document update:
- UI is reachable
- API is not externally usable because it serves a Render suspension page

## Required cleanup rule

If `swapgraph-market-vnext-api` cannot be unsuspended or made externally reachable quickly, replacement services should be created and cut over with agent-product names:
- `swapgraph-agent-barter-api`
- `swapgraph-agent-barter-ui`
- `swapgraph-agent-barter-operator`

If replacement happens, this document must be updated immediately and the older `swapgraph-market-vnext-*` services must be reclassified as legacy.
