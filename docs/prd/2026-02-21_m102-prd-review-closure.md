# M102 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Approved and implemented (fixtures-first)

Purpose: record approved M102 decisions and implementation closure for commercial packaging/policy contracts.

## Decision D1 — Policy precedence
- **Question:** canonical policy precedence order.
- **Recommendation:** enforce fixed precedence: `safety > trust > commercial > preference`.
- **Approval needed:** no (approved).

## Decision D2 — Boost guardrail semantics
- **Question:** what can boosts influence in first contract release?
- **Recommendation:** boosts affect ranking/priority only; no constraint, trust, or settlement safety bypass.
- **Approval needed:** no (approved).

## Decision D3 — Subscription cap safety invariants
- **Question:** can subscription upgrades unlock higher risk caps directly?
- **Recommendation:** no; cap increases require trust milestones independent of subscription state.
- **Approval needed:** no (approved).

## Decision D4 — Partner pricing visibility boundary
- **Question:** expose full internal pricing internals vs effective policy outputs.
- **Recommendation:** expose effective policy outputs in first release; internal pricing internals remain non-contractual.
- **Approval needed:** no (approved).

## Decision D5 — Export integrity requirements
- **Question:** should commercial policy export require signed continuity metadata in first release?
- **Recommendation:** yes; signed export hash + attestation/checkpoint continuity required.
- **Approval needed:** no (approved).

## Decision D6 — Scope model
- **Question:** new commercial scopes now vs reuse existing scopes in first tranche.
- **Recommendation:** reuse `settlement:read` and `settlement:write` for first tranche.
- **Approval needed:** no (approved with scope-migration gate before external rollout).

## Decision D7 — Canonical reason-code floor
- **Question:** minimal deterministic reason-code set for M102 contracts.
- **Recommendation:**
  - `commercial_policy_invalid`
  - `commercial_policy_invalid_timestamp`
  - `commercial_policy_precedence_violation`
  - `commercial_policy_safety_bypass_denied`
  - `commercial_policy_trust_gate_denied`
  - `commercial_policy_boost_guardrail_denied`
  - `commercial_policy_quota_exceeded`
  - `commercial_policy_export_query_invalid`
  - `commercial_policy_export_cursor_not_found`
- **Approval needed:** no (approved).

## Decision D8 — Mobile monetization contract note
- **Question:** should App Store constraints be encoded as contract-level constraints in first tranche?
- **Recommendation:** yes, as non-executable policy notes attached to subscription/entitlement contract objects.
- **Approval needed:** no (approved).

## Implementation closure gate (M102)
M102 implementation closure is achieved when:
- `npm run verify:m102` exits 0.
- `node verify/runner.mjs milestones/M102.yaml` returns `overall=true`.
- Artifacts are present under `artifacts/milestones/M102/latest/*`.
