# M85 Steam deposit-per-swap live proof runbook (staging)

## Purpose
Capture operator-attested live evidence for Steam Tier-1 deposit-per-swap settlement while preserving deterministic proof artifacts.

## Preconditions
- Staging-only environment.
- `INTEGRATION_ENABLED=1` exported for verification runs.
- Partner actor has `settlement:write` scope.
- Steam Tier-1 adapter contract exists for partner and supports `deposit_per_swap` with `dry_run_only=false`.

## Execution
1. Upsert/read adapter contract and run preflight for deposit-per-swap readiness.
2. Capture live evidence refs (trade-offer evidence URL, receipt evidence URL, operator reference).
3. Record live proof via `adapter.steam_tier1.live_proof.deposit_per_swap.record` with idempotency key.
4. Re-run same idempotency key to verify deterministic replay semantics.
5. Archive verifier artifacts from `artifacts/milestones/M85/latest/*`.

## Validation
- `INTEGRATION_ENABLED=1 npm run verify:m85`
- `INTEGRATION_ENABLED=1 node verify/runner.ts milestones/M85.yaml`
- Confirm `steam_deposit_per_swap_live_proof_output.json` contains at least one `integration_mode=live` proof and a stable `proof_hash`.

## Rollback / Incident Notes
- If live proof capture fails, do not mutate production contracts.
- Disable integration gate by unsetting `INTEGRATION_ENABLED` to prevent accidental writes.
- Re-run with a new idempotency key only after root-cause notes are captured in incident log.
