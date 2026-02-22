# M106 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Approved and implemented (fixtures-first, verifier-closed on 2026-02-22)

Purpose: close listing/decision contract decisions so house LP participation is explicit, explainable, and auditable.

## Decision D1 — LP decision endpoint strategy
- **Question:** reuse user commit accept/decline endpoints or define LP-specific decision contracts?
- **Recommendation:** define LP-specific decision endpoints; keep user endpoints unchanged.
- **Rationale:** avoids actor-policy ambiguity and preserves clean contract lineage.
- **Approval needed:** yes.

## Decision D2 — Idempotency scope model
- **Question:** how should LP decision idempotency be scoped?
- **Recommendation:** scope to `provider_id + operation_id + proposal_id + idempotency_key`.
- **Approval needed:** yes.

## Decision D3 — Explanation payload minimum
- **Question:** minimum explanation fields required on LP accept/decline.
- **Recommendation:** require `decision_reason_codes[]`, `policy_ref`, `confidence_score_bps`, `risk_tier_snapshot`, `correlation_id`.
- **Approval needed:** yes.

## Decision D4 — Policy precedence
- **Question:** can LP policy allow decisions that trust/safety policy would block?
- **Recommendation:** no; trust/safety outcomes are hard precedence over LP decision contracts.
- **Approval needed:** yes.

## Decision D5 — Event publication floor
- **Question:** what event visibility is required for LP listing/decision actions?
- **Recommendation:** publish deterministic LP listing and decision events with existing envelope semantics.
- **Approval needed:** yes.

## Decision D6 — Missing-policy behavior
- **Question:** if policy reference is missing/invalid, allow fallback behavior?
- **Recommendation:** deny deterministically with stable reason code; no implicit allow fallback.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M106 surfaces.
- **Recommendation:**
  - `liquidity_listing_invalid`
  - `liquidity_listing_policy_violation`
  - `liquidity_listing_not_found`
  - `liquidity_decision_invalid`
  - `liquidity_decision_policy_missing`
  - `liquidity_decision_not_found`
- **Approval needed:** yes.

## PRD approval gate (M106)
M106 is ready for implementation planning only when D1–D7 are explicitly approved or amended.

## Implementation closure evidence
- `npm run verify:m106` exits 0.
- `node verify/runner.mjs milestones/M106.yaml` returns `overall=true`.
- Canonical output hash locked in `fixtures/release/m106_expected.json` and artifacts published under `artifacts/milestones/M106/latest/*`.
