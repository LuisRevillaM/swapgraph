# SwapGraph Master Remaining Milestone Forecast (M71–M92)

Date: 2026-02-19
Status: Forecast baseline (single forward plan)

## Purpose
Provide one forward plan for **all remaining milestones** so execution can continue without re-specifying milestone intent/gates each time.

## Assumptions
- Current completed baseline: **M0–M70**.
- Execution style stays the same: **fixtures-first, deterministic, verifier-gated, direct-to-main**.
- Integration milestones remain explicitly operator-gated with `INTEGRATION_ENABLED=1`.
- Milestone count target to cover full v2.0 plan scope in this repo: **M71–M92**.

## Global Gate Taxonomy (applies to every milestone)
- **G1 Contract Gate**: PRD + API/spec/schema/example updates in repo.
- **G2 Deterministic Fixture Gate**: scenario + expected fixture + assertions artifact.
- **G3 Verifier Gate**: `npm run verify:mXX` passes.
- **G4 Runner Gate**: `node verify/runner.ts milestones/MXX.yaml` returns `overall=true`.
- **G5 Integrity Gate**: hash/signature/tamper-fail checks where payloads are signed.
- **G6 Authz Gate**: scope/tenancy/role enforcement proofs where endpoint is privileged.
- **G7 Continuity Gate**: attestation/checkpoint/retention proofs for paginated export surfaces.
- **G8 Integration Gate**: real operator proof required (`INTEGRATION_ENABLED=1`, live credentials/devices/tokens).
- **G9 Ops Gate**: explicit runbook + rollback/incident evidence for operational milestones.

> Default completion gate for all milestones: **G1+G2+G3+G4**, plus any milestone-specific gates below.

---

## Remaining Milestones (predicted)

### M71 — Diagnostics automation continuity-window policy hardening
- Add explicit continuation-window policy controls and deterministic expiry reasoning for automation continuity anchors.
- Gates: G1, G2, G3, G4, G5, G7.

### M72 — Automation execution receipt contract
- Introduce signed execution receipts per planned admin action (`request_hash` anchored) and verify replay-safe idempotency linkage.
- Gates: G1, G2, G3, G4, G5, G6.

### M73 — Automation execution journal export
- Add signed/paginated execution-journal export with attestation+checkpoint continuity and retention behavior.
- Gates: G1, G2, G3, G4, G5, G7.

### M74 — Governance rollback plan synthesis
- Generate deterministic rollback plans from execution journal and current policy state, with signed rollback plan hash.
- Gates: G1, G2, G3, G4, G5, G9.

### M75 — Governance simulation endpoint
- Add dry-run simulation contract for proposed controls/actions returning projected state transitions and risk warnings.
- Gates: G1, G2, G3, G4, G5.

### M76 — Commercial usage ledger normalization
- Normalize partner usage ledger model (quotas, unit accounting, settlement export usage) with signed exportable snapshots.
- Gates: G1, G2, G3, G4, G5, G6.

### M77 — Rev-share and billing statement exports
- Add signed billing/rev-share statement exports with deterministic period boundaries and reconciliation totals.
- Gates: G1, G2, G3, G4, G5, G7.

### M78 — SLA policy and breach-event contracts
- Define SLA policy objects and deterministic breach-event reason codes (latency, availability, dispute response windows).
- Gates: G1, G2, G3, G4, G6, G9.

### M79 — Partner dashboard summary APIs
- API contracts for partner dashboard summary surfaces (usage, completion, disputes, latency, SLA status).
- Gates: G1, G2, G3, G4, G6.

### M80 — Partner OAuth app registration + credential lifecycle
- Add OAuth client registration, rotation, revoke, and introspection contracts aligned to existing scope model.
- Gates: G1, G2, G3, G4, G6.

### M81 — Webhook reliability and dead-letter replay hardening
- Delivery-attempt ledger, retry policy metadata, dead-letter export + deterministic replay/backfill workflows.
- Gates: G1, G2, G3, G4, G5, G7, G9.

### M82 — Risk tier policy engine contract
- Add risk-tier policy objects (limits/throttles/escalation) and enforcement reason codes across write paths.
- Gates: G1, G2, G3, G4, G6.

### M83 — Dispute workflow and evidence bundles
- Dispute lifecycle API + signed evidence-bundle export contracts for support/compliance workflows.
- Gates: G1, G2, G3, G4, G5, G6, G9.

### M84 — Steam adapter contract hardening (fixture-only)
- Finalize Steam Tier-1 adapter contract shape and deterministic fixture harness for integration handoff.
- Gates: G1, G2, G3, G4, G6.

### M85 — Steam deposit-per-swap live proof
- Operator-gated real integration proof for deposit-per-swap settlement path with live evidence artifacts.
- Gates: G1, G3, G4, G8, G9.

### M86 — Steam Vault live proof
- Operator-gated real integration proof for Vault deposit/reserve/release/withdraw and instant-ready settlement path.
- Gates: G1, G3, G4, G8, G9.

### M87 — Transparency log publication contract
- Append-only transparency log publication and verification contracts linking receipts and governance artifacts.
- Gates: G1, G2, G3, G4, G5, G7.

### M88 — Unified inclusion-proof linkage
- Deterministic inclusion-proof chain across custody snapshots, transparency-log roots, and signed receipts.
- Gates: G1, G2, G3, G4, G5.

### M89 — Tier-2 adapter capability contract (cross-ecosystem preflight)
- Define second-ecosystem adapter capability declarations and transfer-primitive constraints.
- Gates: G1, G2, G3, G4, G6.

### M90 — Cross-adapter cycle semantics and receipts
- Cross-adapter proposal/settlement semantics with explicit non-atomicity disclosures and signed cross-adapter receipts.
- Gates: G1, G2, G3, G4, G5, G6.

### M91 — Reliability/SLO conformance pack
- SLO metric contracts, incident drill evidence contracts, replay robustness and recovery verification suite.
- Gates: G1, G2, G3, G4, G9.

### M92 — Full-plan conformance and release-readiness gate
- Final conformance matrix mapping v2.0 plan sections to artifacts/tests, with zero unresolved blockers in spec gaps.
- Gates: G1, G2, G3, G4, G5, G6, G7, G9 (+ G8 considered satisfied by M85/M86 evidence).

---

## Predicted End Condition
When **M92** passes, the repo has coverage across:
- protocol primitives + matching + settlement + custody,
- partner/auth/delegation/commercial governance,
- trust/safety/compliance export surfaces,
- integration proof milestones for Steam Tier-1,
- cross-ecosystem pilot contract surfaces,
- reliability and operational conformance artifacts.

## Execution Rule Going Forward
For each milestone above, continue current process unchanged:
1. implement scoped delta,
2. run `npm run verify:mXX`,
3. run `node verify/runner.ts milestones/MXX.yaml`,
4. commit + push to `main` only after both gates pass.
