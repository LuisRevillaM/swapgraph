# M86 Steam Vault live proof runbook (staging)

## Purpose
Capture operator-attested live evidence for Steam Tier-1 Vault settlement lifecycle while preserving deterministic proof artifacts.

## Preconditions
- Staging-only environment.
- `INTEGRATION_ENABLED=1` exported for verification runs.
- Partner actor has `settlement:write` and `vault:write` scopes.
- Steam Tier-1 adapter contract exists for partner, supports `vault_escrow` (or `hybrid`), and has `dry_run_only=false`.

## Execution
1. Upsert/read adapter contract and run preflight for vault readiness.
2. Capture lifecycle evidence refs for `deposit`, `reserve`, `release`, and `withdraw` events.
3. Record vault live proof via `adapter.steam_tier1.live_proof.vault.record` with idempotency key.
4. Re-run same idempotency key to confirm replay semantics.
5. Capture deterministic checksums (`sha256sum`) for `artifacts/milestones/M86/latest/*` evidence files.
6. Record/update staging evidence bundle manifest via `staging.evidence_bundle.record` (M97 contract) using this runbook as `runbook_ref`.
7. Archive verifier artifacts from `artifacts/milestones/M86/latest/*`.

## Validation
- `INTEGRATION_ENABLED=1 npm run verify:m86`
- `INTEGRATION_ENABLED=1 node verify/runner.mjs milestones/M86.yaml`
- Confirm `steam_vault_live_proof_output.json` includes at least one `integration_mode=live` proof with complete lifecycle events and stable `proof_hash`.

## Rollback / Incident Notes
- If vault live proof capture fails, do not mutate production contracts.
- Disable integration gate by unsetting `INTEGRATION_ENABLED` to prevent accidental writes.
- Re-run with a fresh idempotency key only after incident notes capture the failure mode and evidence links.
