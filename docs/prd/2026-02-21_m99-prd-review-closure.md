# M99 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Approved (implementation completed)

Purpose: provide a decision-by-decision closure list for M99 so implementation remains blocked until trust/safety contract boundaries are explicitly approved.

## Decision D1 — Scope namespace
- **Question:** introduce dedicated trust/safety scopes now or reuse existing scopes for first tranche?
- **Recommendation:** reuse `settlement:read` and `settlement:write` for initial implementation tranche.
- **Rationale:** avoids auth-validator churn in PRD-only phase while preserving strict auth gating.
- **Approval needed:** yes.

## Decision D2 — Signal taxonomy minimum
- **Question:** minimum signal categories required in M99 v1 contracts.
- **Recommendation:**
  - `fraud_value_anomaly`
  - `fraud_velocity_spike`
  - `fraud_cycle_abuse_pattern`
  - `ato_device_drift`
  - `ato_session_geo_impossible`
  - `ato_credential_reuse_suspected`
- **Approval needed:** yes.

## Decision D3 — Deterministic decision outcomes
- **Question:** what output set is allowed for first decision contracts?
- **Recommendation:** restrict to `allow`, `manual_review`, `block`.
- **Rationale:** keeps policy decisions composable and auditable across downstream workflows.
- **Approval needed:** yes.

## Decision D4 — Retention and redaction policy
- **Question:** what export controls are required for trust/safety evidence?
- **Recommendation:** retention-bound export with redaction hooks for sensitive subject metadata.
- **Approval needed:** yes.

## Decision D5 — Cross-workflow linkage
- **Question:** must trust/safety decisions link to dispute/reliability records in v1 contract?
- **Recommendation:** yes, include optional linkage references (`dispute_id`, `reliability_ref`) in decision records.
- **Approval needed:** yes.

## Decision D6 — Signed export continuity
- **Question:** should trust/safety exports require signed continuity metadata in first release?
- **Recommendation:** yes; signed export hash + pagination attestation continuity required.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M99 surfaces.
- **Recommendation:**
  - `trust_safety_signal_invalid`
  - `trust_safety_signal_invalid_timestamp`
  - `trust_safety_signal_subject_missing`
  - `trust_safety_decision_invalid`
  - `trust_safety_decision_invalid_timestamp`
  - `trust_safety_decision_subject_mismatch`
  - `trust_safety_decision_not_found`
  - `trust_safety_export_query_invalid`
  - `trust_safety_export_cursor_not_found`
- **Approval needed:** yes.

## PRD approval gate (M99)
M99 PRD is ready for implementation planning only when D1–D7 are explicitly approved or amended.
