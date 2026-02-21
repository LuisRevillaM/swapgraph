# M98 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Draft for approval (PRD-only mode)

Purpose: provide a decision-by-decision closure list for M98 so implementation stays blocked until scope is explicitly approved.

## Decision D1 — Scope model for new APIs
- **Question:** introduce new scopes (`platform_connections:*`, `inventory:*`, `disputes:*`) or reuse existing scopes?
- **Recommendation:** reuse `settlement:read` and `settlement:write` in M98.
- **Rationale:** keeps auth-validator compatibility and minimizes scope-churn risk during PRD-only tranche.
- **Approval needed:** yes.

## Decision D2 — Dispute facade ownership
- **Question:** should `/disputes` become a new standalone model or a facade over current dispute lifecycle model?
- **Recommendation:** facade over existing dispute lifecycle model; single source of truth.
- **Rationale:** avoids dual-write semantics and conflicting dispute states.
- **Approval needed:** yes.

## Decision D3 — Event ordering semantics
- **Question:** enforce global ordering guarantees for new event types?
- **Recommendation:** no global ordering guarantee; preserve current deterministic envelope + at-least-once + consumer dedupe by `event_id`.
- **Rationale:** aligned with existing event architecture and avoids introducing brittle global-order assumptions.
- **Approval needed:** yes.

## Decision D4 — Event payload minimums
- **Question:** minimum required fields for new event payloads.
- **Recommendation:**
  - `proposal.cancelled`: `proposal_id`, `cycle_id`, `reason_code`, `cancelled_at`
  - `cycle.failed`: `cycle_id`, `from_state`, `reason_code`, `failed_at`
  - `user.reliability_changed`: `user_id`, `from_tier`, `to_tier`, `reason_code`, `changed_at`
- **Approval needed:** yes.

## Decision D5 — Inventory contract boundaries
- **Question:** include valuation and mutable metadata writes in M98 inventory contracts?
- **Recommendation:** no; keep to snapshot recording + asset list projection only.
- **Rationale:** preserves narrow contract scope and keeps M98 focused on v2 residual closure.
- **Approval needed:** yes.

## Decision D6 — Canonical reason-code floor
- **Question:** minimal deterministic reason-code set required to avoid implementation ambiguity.
- **Recommendation:**
  - `platform_connection_invalid`
  - `platform_connection_invalid_timestamp`
  - `inventory_snapshot_invalid`
  - `inventory_snapshot_invalid_timestamp`
  - `inventory_asset_query_invalid`
  - `dispute_facade_invalid`
  - `dispute_not_found`
- **Approval needed:** yes.

## PRD approval gate (M98)
M98 PRD is ready for implementation planning only when D1–D6 are explicitly approved or amended.
