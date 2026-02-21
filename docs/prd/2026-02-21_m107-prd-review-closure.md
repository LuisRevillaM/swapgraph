# M107 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Draft for approval (PRD-only mode)

Purpose: close execution-governance decisions so LP settlement can operate safely under operator-assisted controls, especially for Steam-first constraints.

## Decision D1 — Default execution mode
- **Question:** default mode for restricted adapter contexts.
- **Recommendation:** default to `operator_assisted`; simulation allowed, constrained automation only by explicit policy approval.
- **Approval needed:** yes.

## Decision D2 — Override governance
- **Question:** when can `constrained_auto` be enabled?
- **Recommendation:** only with explicit approved override policy + risk controls + audit visibility; no silent automatic escalation.
- **Approval needed:** yes.

## Decision D3 — Operator approval payload floor
- **Question:** minimum fields for approve/reject records.
- **Recommendation:** require `request_id`, `provider_id`, `risk_class`, `reason_codes[]`, `operator_actor`, `approved_at|rejected_at`, `correlation_id`.
- **Approval needed:** yes.

## Decision D4 — Integration gate semantics
- **Question:** should adapter-backed execution checks be integration-gated?
- **Recommendation:** yes; enforce integration gate expectations for restricted/live adapter flows.
- **Approval needed:** yes.

## Decision D5 — Export integrity requirements
- **Question:** should execution-request exports require signed continuity metadata?
- **Recommendation:** yes; signed export hash + continuation attestation/checkpoint continuity required.
- **Approval needed:** yes.

## Decision D6 — Platform policy hard-stop behavior
- **Question:** if platform policy block is detected, should requests queue or fail?
- **Recommendation:** fail deterministically with explicit hard-stop reason code; no implicit queue fallback.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M107 surfaces.
- **Recommendation:**
  - `liquidity_execution_mode_invalid`
  - `liquidity_execution_mode_restricted`
  - `liquidity_execution_request_invalid`
  - `liquidity_execution_request_not_found`
  - `liquidity_execution_operator_approval_required`
  - `liquidity_execution_platform_policy_blocked`
- **Approval needed:** yes.

## PRD approval gate (M107)
M107 is ready for implementation planning only when D1–D7 are explicitly approved or amended.
