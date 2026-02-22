# SwapGraph Next Batch Forecast (M93–M97)

Date: 2026-02-20

Goal: define the next five-milestone tranche after M92, preserving fixtures-first verification, deterministic artifacts, and per-milestone proof gates.

## M93 — Cross-adapter compensation case contract
- Add idempotent case create/read/update contracts for cross-adapter discrepancy outcomes (building from M90 `discrepancy_code` + `compensation_required`).
- Deterministic reason-code policy for case states (`open`, `approved`, `rejected`, `resolved`).

## M94 — Compensation ledger + signed export
- Add deterministic compensation ledger entries and signed paginated export with continuation anchors.
- Include tamper-fail signature/hash verification in fixture scenarios.

## M95 — Dispute ↔ compensation linkage workflow
- Link M83 dispute lifecycle to compensation cases/ledger with deterministic status transitions.
- Enforce policy constraints and auditable linkage records.

## M96 — Reliability auto-remediation planning contract
- Extend M91 reliability signals into deterministic auto-remediation plan suggestions.
- Add signed remediation-plan export with strict idempotency and scope checks.

## M97 — Staging evidence refresh + operator conformance runbook pack
- Refresh operator runbooks/evidence contracts for current `main` head.
- Add deterministic evidence manifest/checkpoint contract for staging proof bundles.

## Execution discipline (unchanged)
For each milestone M93–M97:
1. `docs/prd/Mxx.md` finalized first
2. Scoped implementation
3. `npm run verify:mxx`
4. `node verify/runner.mjs milestones/Mxx.yaml`
5. Commit/push only when both gates pass
