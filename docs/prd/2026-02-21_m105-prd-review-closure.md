# M105 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Approved and implemented (fixtures-first, verifier-closed on 2026-02-22)

Purpose: close LP inventory/reservation lifecycle decisions to guarantee fulfillment and avoid reservation conflicts.

## Decision D1 — Lifecycle modeling strategy
- **Question:** introduce new holding status enum immediately or derive `in_settlement` from existing reservation/settlement binding fields?
- **Recommendation:** keep existing vault status compatibility first; derive settlement-bound state from `reservation_id` + `settlement_cycle_id` in first tranche.
- **Approval needed:** yes.

## Decision D2 — Reservation batch semantics
- **Question:** batch reserve/release should be all-or-nothing or per-item deterministic outcomes?
- **Recommendation:** per-item deterministic outcomes with aggregate summary; no ambiguous partial behavior.
- **Approval needed:** yes.

## Decision D3 — Conflict invariant
- **Question:** can an asset have multiple active LP/user reservations?
- **Recommendation:** no; one active reservation per asset across all listing paths.
- **Approval needed:** yes.

## Decision D4 — Ownership binding
- **Question:** how to validate LP reservation authority?
- **Recommendation:** reservation context must bind `provider_id`, `owner_actor`, `holding_id`, and cycle context.
- **Approval needed:** yes.

## Decision D5 — Settlement compatibility
- **Question:** should LP inventory contracts align with current settlement leg binding model?
- **Recommendation:** yes; LP binding contracts must remain compatible with existing timeline leg + vault binding semantics.
- **Approval needed:** yes.

## Decision D6 — Reconciliation export integrity
- **Question:** must LP reconciliation exports include signed continuity/checkpoints?
- **Recommendation:** yes; signed export with continuation attestation/checkpoint parity required.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M105 surfaces.
- **Recommendation:**
  - `liquidity_inventory_snapshot_invalid`
  - `liquidity_inventory_asset_not_found`
  - `liquidity_inventory_reservation_conflict`
  - `liquidity_inventory_reservation_context_mismatch`
  - `liquidity_inventory_not_available`
  - `liquidity_inventory_reconciliation_query_invalid`
- **Approval needed:** yes.

## PRD approval gate (M105)
M105 is ready for implementation planning only when D1–D7 are explicitly approved or amended.

## Implementation closure evidence
- `npm run verify:m105` exits 0.
- `node verify/runner.mjs milestones/M105.yaml` returns `overall=true`.
- Canonical output hash locked in `fixtures/release/m105_expected.json` and artifacts published under `artifacts/milestones/M105/latest/*`.
