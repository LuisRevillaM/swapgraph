# M97 Staging evidence refresh + operator conformance runbook

## Purpose
Provide a deterministic operator procedure for refreshing staging proof bundles and recording signed evidence-manifest checkpoints after milestone verification.

## Preconditions
- Staging-only posture (`main` deploys to staging).
- Partner actor with `settlement:write` and `settlement:read` scopes.
- Latest milestone verification artifacts exist under `artifacts/milestones/Mxx/latest/*`.
- For integration milestones (M85/M86), set `INTEGRATION_ENABLED=1` only during controlled staging runs.

## Evidence bundle workflow
1. Execute milestone verification:
   - `npm run verify:mxx`
   - `node verify/runner.mjs milestones/Mxx.yaml`
2. Collect evidence files from `artifacts/milestones/Mxx/latest/*`.
3. Compute deterministic checksums:
   - `sha256sum <artifact files>`
4. Build/record a staging evidence bundle with operation `staging.evidence_bundle.record`:
   - include `milestone_id`, `runbook_ref`, `conformance_ref`, `release_ref`, `collected_at`.
   - include `evidence_items[]` with stable `artifact_ref`, `artifact_kind`, `sha256`, `captured_at`.
5. Re-run same idempotency key to confirm deterministic replay semantics.
6. Export and validate evidence continuity via `staging.evidence_bundle.export`:
   - first page with `limit`.
   - continuation with `cursor_after` + required `checkpoint_after`.
   - verify signed payload integrity and checkpoint chain continuity.

## Validation
- `npm run verify:m97`
- `node verify/runner.mjs milestones/M97.yaml`
- Confirm `artifacts/milestones/M97/latest/staging_evidence_conformance_output.json` includes:
  - deterministic `manifest_hash` and `checkpoint_hash` values,
  - continuation checkpoint enforcement (`staging_evidence_checkpoint_required` / mismatch proof),
  - signed export integrity + tamper-fail verification.

## Rollback / incident notes
- Do not run production mutations while collecting staging evidence.
- If evidence recording fails, retain raw artifact files and checksum logs for manual reconstruction.
- On checkpoint mismatch, do not overwrite prior bundles; open an incident note and rerun export with the correct continuation anchors.
