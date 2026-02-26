# Steam Live Readiness Checklist (Friends Pilot)

Date: 2026-02-24  
Owner: Product + Platform Ops  
Status: Ready for execution

## 1) Goal
Run a controlled friends pilot with real CS2 items and realistic settlement behavior, then graduate to true Steam-transfer automation.

## 2) Important current-state truth
- Steam adapter contract/preflight surfaces are still fixture-labeled (`integration_mode: fixture_only`) in the contract service and schemas:
  - `src/service/steamAdapterContractService.mjs` (contract/preflight normalization)
  - `docs/spec/schemas/SteamTier1AdapterPreflightResponse.schema.json`
- M85/M86 "live" paths are operator-attested proof capture with integration gate + scope enforcement:
  - `src/service/steamAdapterLiveProofService.mjs`
  - `ops/M85_LIVE_PROOF_RUNBOOK.md`
  - `ops/M86_VAULT_LIVE_PROOF_RUNBOOK.md`

This means: you can run a high-quality staging pilot now, but fully automated Steam API execution still needs additional implementation.

## 3) What is already passing in this repo
- `npm run verify:m84` -> pass
- `INTEGRATION_ENABLED=1 npm run verify:m85` -> pass
- `INTEGRATION_ENABLED=1 npm run verify:m86` -> pass

These three are the mandatory baseline gate set for a friends pilot.

## 4) Friends pilot (S0) checklist

### A. Pilot guardrails (must pass before any friend session)
- [ ] Staging-only environment confirmed.
- [ ] Invite-only participant list (5-15 users).
- [ ] Explicit pilot consent script prepared (no deception around value risk).
- [ ] Pseudonymous display mode enabled in both clients (hide public handle by default).
- [ ] Integration gate default is OFF outside controlled test windows (`INTEGRATION_ENABLED` unset).

Go/No-Go:
- GO only if all five boxes are complete.

### B. Account and inventory prep
- [ ] Create dedicated test Steam accounts for pilot participants (do not share credentials).
- [ ] Ensure Steam Guard/mobile-auth requirements are satisfied per account.
- [ ] Seed each test account with a small, bounded inventory budget (low-risk item set).
- [ ] Record seed manifest (account alias -> asset ids -> cost basis) in internal ops sheet.

Go/No-Go:
- GO only if each participant has at least 2 tradable assets and alias mapping is complete.

### C. Contract + preflight setup (platform readiness)
- [ ] Upsert Steam tier1 contract with required settlement mode and `dry_run_only=false` for pilot partner.
- [ ] Run preflight with realistic cycle parameters (`asset_count`, `settlement_mode`, `dry_run=false`).
- [ ] Confirm preflight returns `ready=true` and no `reason_code`.

Validation commands:
- `npm run verify:m84`
- `INTEGRATION_ENABLED=1 npm run verify:m85`
- `INTEGRATION_ENABLED=1 npm run verify:m86`

Go/No-Go:
- GO only if all three commands pass and latest artifacts are generated under `artifacts/milestones/M84|M85|M86/latest`.

### D. Session execution (friends playthrough)
- [ ] Run 3 journey scripts with each participant:
  - post intent
  - review/accept proposal
  - follow active timeline to receipt
- [ ] Capture operator evidence refs for each settlement event.
- [ ] Record M85/M86 live proof events with stable idempotency keys.
- [ ] Replay same idempotency keys once to verify deterministic replay behavior.

Go/No-Go:
- GO if at least 10 successful end-to-end cycles complete with no P0/P1 issues.

### E. Evidence and audit closure
- [ ] Build and record staging evidence bundles (`staging.evidence_bundle.record`) per runbook.
- [ ] Validate signed export continuity chain via M97 flow.
- [ ] Archive all run artifacts and checksums.

Validation commands:
- `npm run verify:m97`
- `node verify/runner.mjs milestones/M97.yaml`

Go/No-Go:
- GO only if M97 passes and checkpoint continuity is valid.

## 5) Product quality success metrics for this pilot
- Median time to first completed swap under 15 minutes.
- Proposal accept/decline confusion rate below 10%.
- Active timeline "what happens next" comprehension above 80% (post-session survey).
- Zero unresolved P0/P1 defects in pilot-critical flows.

## 6) What is still missing for true Steam-live automation

These are implementation tasks, not just runbook tasks:
- [ ] Real Steam connector worker(s) for inventory sync + trade-offer create/monitor.
- [ ] Credential/secret management for partner Steam credentials and rotation.
- [ ] Reconciliation loop between Steam execution status and settlement state transitions.
- [ ] Contract/preflight model graduation from fixture-only labeling to real live integration states.
- [ ] Production incident controls: automatic circuit breaker, replay-safe retries, operator takeover path.

## 7) Recommendation
- Run the friends pilot now using the S0 checklist above.
- Treat that pilot as UX + operations validation.
- Start a dedicated follow-on milestone for true Steam transfer automation immediately after pilot evidence review.

