# M108 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Draft for approval (PRD-only mode)

Purpose: close LP autonomy-policy decisions so automated LP behavior remains deterministic, safe, and auditable.

## Decision D1 — Policy precedence alignment
- **Question:** how should LP policy interact with trust/safety and commercial policy layers?
- **Recommendation:** enforce precedence `safety > trust > LP autonomy policy > commercial > preference`.
- **Approval needed:** yes.

## Decision D2 — Anti-farming control floor
- **Question:** minimum anti-farming controls required for first tranche.
- **Recommendation:** require all six controls in M108 PRD (`max_spread_bps`, `max_daily_value_usd`, `max_counterparty_exposure_usd`, `min_price_confidence_bps`, blocked-liquidity tiers, volatility mode behavior).
- **Approval needed:** yes.

## Decision D3 — Volatility mode behavior
- **Question:** canonical behavior when `high_volatility_mode` is active.
- **Recommendation:** deterministic operator-approved mode set (`tighten`, `pause`, `quote_only`) with no implicit fallback.
- **Approval needed:** yes.

## Decision D4 — Evaluation determinism
- **Question:** should equivalent input/policy always produce identical verdicts?
- **Recommendation:** yes, evaluation must be deterministic and idempotent with explicit reason-code lineage.
- **Approval needed:** yes.

## Decision D5 — Audit/export continuity
- **Question:** should LP decision audits require signed continuation guarantees?
- **Recommendation:** yes; signed export hash + attestation/checkpoint continuity required.
- **Approval needed:** yes.

## Decision D6 — Retention/redaction posture
- **Question:** should decision audit exports support retention and sensitive-field redaction hooks?
- **Recommendation:** yes; retention-bounded export plus deterministic redaction policy hooks required.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M108 surfaces.
- **Recommendation:**
  - `liquidity_policy_invalid`
  - `liquidity_policy_precedence_violation`
  - `liquidity_policy_spread_exceeded`
  - `liquidity_policy_exposure_exceeded`
  - `liquidity_policy_price_confidence_low`
  - `liquidity_policy_high_volatility_pause`
  - `liquidity_decision_audit_query_invalid`
- **Approval needed:** yes.

## PRD approval gate (M108)
M108 is ready for implementation planning only when D1–D7 are explicitly approved or amended.
