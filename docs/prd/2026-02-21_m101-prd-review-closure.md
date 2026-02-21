# M101 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Draft for approval (PRD-only mode)

Purpose: close discovery decisions for product-surface readiness contracts before any implementation planning.

## Decision D1 — Notification taxonomy floor
- **Question:** minimum required notification types for first contract release.
- **Recommendation:**
  - `proposal.created`
  - `proposal.expiring`
  - `settlement.deposit_required`
  - `settlement.deposit_deadline_approaching`
  - `cycle.executing`
  - `cycle.completed`
  - `cycle.failed`
  - `refund.completed`
  - `intent.demand_signal`
- **Approval needed:** yes.

## Decision D2 — Preference control minimum
- **Question:** mandatory preference controls in first contract release.
- **Recommendation:** quiet-hours window, urgency threshold, category opt in/out, demand-signal opt in/out.
- **Approval needed:** yes.

## Decision D3 — Projection boundary model
- **Question:** allow client-specific projection endpoints or enforce unified contract projections?
- **Recommendation:** enforce unified client-agnostic projections for web/iOS/partner surfaces.
- **Approval needed:** yes.

## Decision D4 — Embedded UI contract boundary
- **Question:** bundle capabilities and payload in one endpoint or split contract?
- **Recommendation:** split into capabilities endpoint + surface bundle endpoint.
- **Approval needed:** yes.

## Decision D5 — Scope model
- **Question:** introduce dedicated notification/product scopes now or reuse existing scopes in first tranche.
- **Recommendation:** reuse `settlement:read/write` and `receipts:read` for first tranche.
- **Approval needed:** yes.

## Decision D6 — Privacy posture for receipt-share projection
- **Question:** should receipt share projection include public-safe defaults in v1?
- **Recommendation:** yes; require privacy-safe payload defaults with explicit toggle metadata.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimal deterministic reason-code set for M101 surfaces.
- **Recommendation:**
  - `notification_preferences_invalid`
  - `notification_preferences_invalid_timestamp`
  - `notification_inbox_query_invalid`
  - `product_projection_query_invalid`
  - `settlement_timeline_not_found`
  - `receipt_share_not_found`
  - `partner_ui_surface_unknown`
- **Approval needed:** yes.

## PRD approval gate (M101)
M101 PRD is ready for implementation planning only when D1–D7 are explicitly approved or amended.
