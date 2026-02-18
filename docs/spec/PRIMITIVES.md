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

### CustodySnapshot
Deterministic point-in-time custody commitment for vault/deposit holdings.
- includes `snapshot_id`, `recorded_at`, `leaf_count`, and Merkle `root_hash`
- includes canonical holding entries (`holding_key`, `leaf_hash`, `holding`)
- is suitable for offline inclusion verification.

### CustodyInclusionProof
Deterministic proof that a specific custody holding is included in a published snapshot root.
- includes leaf metadata (`holding_key`, `leaf_hash`, `leaf_index`)
- includes ordered sibling path (`siblings[]` with `left|right` positions)
- verifies to snapshot `root_hash` with stable hashing rules.

### VaultHolding
Canonical lifecycle record for a vaulted holding.
- states: `available -> reserved -> available|withdrawn`
- owner-scoped withdraw semantics (only owner can withdraw)
- reservation lock semantics (reserved holdings are not withdrawable)

### VaultEvent
Append-only lifecycle events for vault transitions.
- `vault.deposit_confirmed`
- `vault.holding_reserved`
- `vault.holding_released`
- `vault.holding_withdrawn`

## Protocol invariants (non-negotiable)
- **Constraints are never overridden**.
- **Only one active reservation per intent**.
- **Idempotent mutations** (safe under retries).
- **Critical state transitions are auditable** (append-only events).
