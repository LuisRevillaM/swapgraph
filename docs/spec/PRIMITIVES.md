# SwapGraph v2.0 — Canonical primitives (v1)

This repo is **API-first**.
Every client (web marketplace, iOS, partner integrations, agents) is a thin layer over these primitives.

## Stable primitives

### ActorRef
Represents who initiated an action.
- `type`: `user | partner | agent`
- `id`: stable identifier in SwapGraph

### AssetRef
Normalized reference to a platform-native asset.
- Must retain platform-native identifiers (Steam: `app_id`, `context_id`, `asset_id`, `class_id`, `instance_id`).
- Must include `proof` pointer(s) when used in SwapIntents.

### InventorySnapshot
Point-in-time verified view of assets for a platform connection.
- Used for matching + dispute resolution.
- Has `verification_method` + a `trust_score` input (freshness + API confidence).

### SwapIntent
Core unit of liquidity.
- `offer`: array of AssetRef (bundles allowed)
- `want_spec`: set-based structured want
- `value_band`: min/max value with pricing provenance
- constraints are explicit and user-owned (never overridden)

### CycleProposal
Executable multi-party proposal found by matching.
- ordered participants
- explainability + confidence
- fee preview

### Commit (two-phase)
Phase 1: accept/decline (idempotent)
Phase 2: ready (once all accept)

### SettlementTimeline
State machine for escrow + execution + unwind.

### SwapReceipt
Canonical proof of completion or unwind.
- includes asset identifiers + timestamps + transaction refs (where available)
- includes a SwapGraph signature (`signature`) and optional transparency-log inclusion.

## Protocol invariants (non-negotiable)
- **Constraints are never overridden**.
- **Only one active reservation per intent**.
- **Idempotent mutations** (safe under retries).
- **Critical state transitions are auditable** (append-only events).
