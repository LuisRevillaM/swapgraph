# PLAN — SwapGraph
AUTOPILOT_APPROVED: false
PROJECT_KEY: swapgraph
REPO_PATH: /workspace/projects/swapgraph

## Goal
Ship a **Steam-only MVP** that can:
- sync inventory,
- create listings with structured want specs + value tolerance bands,
- propose **3-cycles** with explainability,
- execute via **escrow deposit → batch release**,
- generate receipts + dispute artifacts,
while preserving the product pillars (certainty, fairness, safety, trader-native UX).

## Key constraints (hard)
- **Official rails only**. No account swaps, no credential transfers beyond platform auth.
- **No fiat custody / cash-out** in MVP.
- Cross-ecosystem support is adapter-based and **compliance-gated**.

## MVP decision: trade holds / locked items
Plan v1.3 states (Steam-first escrow section):
> Items with trade holds/locks excluded in MVP (or require explicit longer timeline).

**Default for MVP implementation (recommended):** exclude holds/locks from being listable/executable.
We still store `tradable_at` / `trade_hold_days` so we can add a “slow lane” later if we choose.

## Milestones (draft)
- [ ] M0 — Repo bootstrap + verification harness + plan imported
- [ ] M1 — Steam adapter v0: connect + inventory sync + tradability checks (no settlement)
- [ ] M2 — Listings: want_spec schema + CRUD + validation
- [ ] M3 — Matching: edge build + cycle detection (len<=3) + scoring + explainability blob
- [ ] M4 — Cycle inbox: propose/reserve/accept/decline + expiration
- [ ] M5 — Settlement simulator: escrow.pending→ready→executing + unwind rules (no Steam integration)
- [ ] M6 — Steam escrow integration proof gate (operator run required)
- [ ] M7 — Trust/Safety: reliability score + limits + disputes + admin minimum
- [ ] M8 — Monetization surfaces: fee breakdown + Pro entitlements + boost guardrails

## Source
- `docs/source/LATEST.md` (currently v2.0)
