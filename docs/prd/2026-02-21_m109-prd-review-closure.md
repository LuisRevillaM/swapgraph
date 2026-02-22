# M109 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Approved and implemented (fixtures-first, verifier-closed on 2026-02-22)

Purpose: close partner LP onboarding/governance decisions with deterministic implementation coverage and verifier-backed evidence.

## Decision D1 — Segment taxonomy adoption
- **Question:** which segmentation framework governs partner LP onboarding?
- **Recommendation:** adopt BRD-04 segment model (`S0`..`S3`) as the initial governance baseline.
- **Approval needed:** yes.

## Decision D2 — Eligibility gate minimum
- **Question:** minimum eligibility checks required for onboarding/promotion.
- **Recommendation:** require trust/safety baseline, reliability baseline, export/audit conformance, and no unresolved critical violations.
- **Approval needed:** yes.

## Decision D3 — Rollout gating model
- **Question:** should rollout be capability-family gated by segment?
- **Recommendation:** yes; capability-gated rollout matrix is required and must be explicit in contract projections.
- **Approval needed:** yes.

## Decision D4 — Downgrade/offboarding authority
- **Question:** should severe incidents trigger automatic downgrade paths?
- **Recommendation:** yes, deterministic downgrade/offboarding triggers with explicit operator authority chain.
- **Approval needed:** yes.

## Decision D5 — Commercial visibility boundary
- **Question:** what commercial internals are exposed to partner LPs?
- **Recommendation:** expose effective policy outputs only in first tranche; internal pricing internals remain non-contractual.
- **Approval needed:** yes.

## Decision D6 — Promotion evidence requirement
- **Question:** what evidence is required for partner segment promotion?
- **Recommendation:** require two consecutive compliant review windows plus remediation closure for prior critical findings.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M109 surfaces.
- **Recommendation:**
  - `partner_liquidity_provider_invalid`
  - `partner_liquidity_provider_not_found`
  - `partner_liquidity_provider_eligibility_failed`
  - `partner_liquidity_provider_rollout_blocked`
  - `partner_liquidity_provider_downgrade_required`
- **Approval needed:** yes.

## PRD approval gate (M109)
M109 was approved for implementation after D1–D7 and is now implementation-closed.

## Implementation closure evidence
- `npm run verify:m109` exits 0.
- `node verify/runner.mjs milestones/M109.yaml` returns `overall=true`.
- Canonical output hash locked in `fixtures/release/m109_expected.json` and artifacts published under `artifacts/milestones/M109/latest/*`.
