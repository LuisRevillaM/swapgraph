# PLAN — SwapGraph
AUTOPILOT_APPROVED: true
PROJECT_KEY: swapgraph
REPO_PATH: /workspace/projects/swapgraph

## Goal
Implement **SwapGraph v2.0** as an **API-first multi-reciprocity swap clearing network**:
- partners/marketplaces/agents can submit **SwapIntents** ("I have X, I want Y, under constraints")
- SwapGraph returns **CycleProposals** (2–3 party initially)
- SwapGraph coordinates **commit → custody/settlement → receipts** where rails exist (Steam-first)
- the web marketplace + native iOS client are **reference clients** built on the same primitives

## Hard constraints
- Official transfer rails only. **No account swapping** / credential-transfer workflows.
- **No cash-out rails in v1** (no fiat balances, no withdrawals).
- Ecosystems without legitimate transfer primitives are **partnership-gated + legally reviewed**.

## Delivery rule (spec-first)
Every milestone must have:
- a crisp spec (`docs/prd/Mx.md`)
- a contract (`milestones/Mx.yaml`)
- a verifier (`npm run verify:mx`) that produces artifacts under `artifacts/milestones/Mx/latest/*`

No milestone is “done” unless `node verify/runner.mjs milestones/Mx.yaml` passes.

## Milestones (aligned to plan v2.0)
- [ ] M0 — Repo bootstrap + verification harness + plan imported
- [ ] M1 — One platform API (internal dogfood)
  - canonical schemas for SwapIntent/CycleProposal/Commit/Receipt/etc.
  - idempotency rules + structured errors
  - event envelope + webhook/stream event taxonomy (spec + fixtures)
- [ ] M2 — Developer Preview: intents in, proposals out
  - ingest intents (fixtures first)
  - matching worker produces 2–3 party CycleProposals + explainability + fee preview stub
  - proposal delivery contract (polling + webhook payloads)
- [ ] M3 — Commit handshake + reservation locks
  - two-phase commit semantics (accept/decline → ready)
  - conflict-free reservations (one active reservation per intent)
  - idempotent mutations + auditable logs
- [ ] M4 — Steam-first settlement (Tier 1) — simulation-first
  - settlement timeline state machine + unwind rules
  - signed receipts + transparency log scaffolding (verifiable)
- [ ] M5 — Steam-first settlement (Tier 1) — operator integration proof gate
  - real Steam trade-offer based deposit-per-swap escrow flow
  - requires `INTEGRATION_ENABLED=1`
- [ ] M6 — Vault + proof-of-custody
  - optional Vault deposits + instant settlement eligibility
  - proof-of-custody snapshots + inclusion proofs (initial version)
- [ ] M7 — Partner program (commercial + SLA)
  - partner auth/scopes/quotas
  - webhook signing + replay + dashboards (minimum)
- [ ] M8 — Cross-ecosystem pilot (adapter-gated)
  - 2nd ecosystem adapter (Tier 2) + cross-adapter proposal semantics

## Source
- `docs/source/LATEST.md` (currently v2.0)
