# Render Agent Market Topology

Last updated: 2026-03-17T16:40:00Z

## Purpose

This document records the exact Render topology for the active agent barter product line.

## Canonical product services

### Canonical web UI
- service name: `swapgraph-agent-barter-ui`
- service id: `srv-d6so4e7pm1nc73bg81rg`
- type: `web_service`
- public URL: `https://swapgraph-agent-barter-ui.onrender.com`
- branch: `marketplace-vnext-execution`
- classification: `canonical`
- role: external-facing public UI

### Canonical API
- service name: `swapgraph-agent-barter-api`
- service id: `srv-d6so03n5gffc738nducg`
- type: `web_service`
- public URL: `https://swapgraph-agent-barter-api.onrender.com`
- branch: `marketplace-vnext-execution`
- classification: `canonical`
- role: external-facing public API
- latest known live deploy id from Render metadata: `dep-d6so4oea2pns738bd1h0`
- latest known deploy commit from Render metadata: `23be6007f0b6e8b697e53e4bbcf7a678874b868f`
- persistent state path: `/var/data/agent-barter-state.json`

### Canonical background worker
- service name: `swapgraph-agent-barter-operator`
- service id: `srv-d6so4dpaae7s73dfin9g`
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

### Legacy vNext UI
- service name: `swapgraph-market-vnext-ui`
- service id: `srv-d6m74jnkijhs73fqjnl0`
- type: `web_service`
- public URL: `https://swapgraph-market-vnext-ui.onrender.com`
- classification: `legacy`
- role: earlier agent-market UI name before the barter cutover

### Legacy vNext API
- service name: `swapgraph-market-vnext-api`
- service id: `srv-d6m7437kijhs73e72op0`
- type: `web_service`
- public URL: `https://swapgraph-market-vnext-api.onrender.com`
- classification: `legacy`
- role: suspended pre-cutover API
- current status: `suspended`
- suspenders: `stuck_crashlooping`

### Legacy vNext operator
- service name: `swapgraph-market-operator`
- service id: `srv-d6pholdm5p6s73fu5n60`
- type: `background_worker`
- public URL: none
- classification: `legacy`
- role: earlier hosted operator loop name before the barter cutover

## Current operational conclusion

The canonical agent barter topology is now:
1. reachable at public agent-barter URLs
2. backed by persistent API state on the Render disk
3. separate from the older vNext names and the human-marketplace lineage
