# SwapGraph v2.0 Conformance Matrix (M92)

M92_RELEASE_READY: true
M97_EVIDENCE_REFRESH_READY: true

This matrix maps v2.0 plan gates and milestone tranches to deterministic, verifier-backed artifacts in this repo.

## Gate Coverage

| Gate | Requirement | Evidence |
|---|---|---|
| G1 | Fixtures-first deterministic contracts | `verify/m71.sh` … `verify/m92.sh`, `artifacts/milestones/*/latest/*` |
| G2 | Spec/schema/manifest coherence | `docs/spec/schemas/*.schema.json`, `docs/spec/api/manifest.v1.json`, `scripts/validate-schemas.mjs`, `scripts/validate-api-contract.mjs` |
| G3 | Auth + idempotency enforcement | `src/core/authz.mjs`, `scripts/validate-api-auth.mjs`, per-milestone idempotency replay fixtures |
| G4 | Signed integrity exports | policy integrity signing paths in `src/crypto/policyIntegritySigning.mjs` + signed export scenarios (M87–M91) |
| G5 | Chain continuity / inclusion integrity | M87 transparency chain, M88 inclusion-proof linkage artifacts |
| G6 | Cross-ecosystem adapter safety contracts | M89 Tier-2 capability/preflight + M90 cross-cycle semantics/receipts |
| G7 | Governance + compliance evidence continuity | M71–M83 governance/dispute/export hardening artifacts |
| G8 | Integration-gated live proof evidence | M85/M86 with `INTEGRATION_ENABLED=1` runbooks + verifier artifacts |
| G9 | Reliability and recovery conformance | M91 SLO/drill/replay contracts + signed conformance export |
| G10 | Staging evidence-manifest checkpoint continuity | M97 staging evidence bundle contracts + runbook pack + signed checkpoint-gated export artifacts |

## Milestone Coverage Summary

- M71–M75: governance diagnostics execution attestation hardening tranche.
- M76–M83: commercial, SLA, OAuth, webhook reliability, risk-tier, disputes.
- M84–M86: Steam adapter contract + integration-gated live proof evidence.
- M87–M90: transparency, inclusion linkage, Tier-2 capabilities, cross-cycle semantics.
- M91: reliability/SLO conformance pack.
- M92: full-plan conformance and release-readiness gate.
- M93–M95: compensation lifecycle extension (cases, ledger, dispute-linkage continuity).
- M96: reliability auto-remediation planning contract.
- M97: staging evidence-manifest checkpoint contract + operator conformance runbook pack.

## Release-Readiness Assertions

- ✅ All milestone descriptors exist for M71–M97 (`docs/prd/Mxx.md`, `milestones/Mxx.yaml`, `verify/mxx.sh`).
- ✅ Deterministic verification artifacts exist for M71–M97 under `artifacts/milestones/Mxx/latest/*`.
- ✅ Spec gaps are closed to zero unresolved blocker state for this tranche.
- ✅ `BLOCKERS.md` indicates no active blockers.
