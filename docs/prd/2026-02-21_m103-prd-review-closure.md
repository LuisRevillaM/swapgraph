# M103 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Draft for approval (PRD-only mode)

Purpose: close foundational LP identity/disclosure decisions so M103 can act as a stable base for M104–M110.

## Decision D1 — Actor model strategy
- **Question:** add a new `ActorRef.type=liquidity_provider` now, or preserve existing actor types and add LP attribution objects?
- **Recommendation:** preserve `ActorRef` (`user|partner|agent`) and introduce `LiquidityProviderRef` linked to `owner_actor`.
- **Rationale:** avoids immediate auth-validator and actor-type breakage while making LP identity explicit.
- **Approval needed:** yes.

## Decision D2 — Scope namespace strategy
- **Question:** create `liquidity:*` scopes now vs reuse existing scope families first?
- **Recommendation:** reuse `settlement:read`/`settlement:write` in first implementation tranche.
- **Rationale:** keeps `validate-api-auth` compatibility and reduces auth churn risk.
- **Approval needed:** yes.

## Decision D3 — Disclosure minimum
- **Question:** what disclosure fields are mandatory for LP identity?
- **Recommendation:** require `provider_type`, `is_automated`, `is_house_inventory`, `label_required`, and human-readable disclosure text via persona/profile.
- **Approval needed:** yes.

## Decision D4 — Attribution propagation floor
- **Question:** where must LP attribution appear at minimum?
- **Recommendation:** `SwapIntent`, `CycleProposal.participants[]`, and `SwapReceipt` projections must all include LP attribution when applicable.
- **Approval needed:** yes.

## Decision D5 — Registry ownership semantics
- **Question:** who may register/manage LP records in first tranche?
- **Recommendation:** partner-admin ownership in first tranche; optional user-self LP profile deferred.
- **Approval needed:** yes.

## Decision D6 — Event contract additions
- **Question:** add LP-specific events now?
- **Recommendation:** yes, add LP lifecycle/disclosure events (non-global ordering; existing at-least-once + dedupe semantics retained).
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M103 surfaces.
- **Recommendation:**
  - `liquidity_provider_invalid`
  - `liquidity_provider_not_found`
  - `liquidity_provider_type_invalid`
  - `liquidity_provider_actor_mismatch`
  - `liquidity_provider_persona_invalid`
  - `liquidity_provider_disclosure_required`
- **Approval needed:** yes.

## PRD approval gate (M103)
M103 is ready for implementation planning only when D1–D7 are explicitly approved or amended.
