# SwapGraph Next Batch Forecast (M98–M102)

Date: 2026-02-21

Goal: define the post-M97 tranche so all remaining v2 areas are fully PRD-scoped before official development starts.

Update (2026-02-21): M98, M99, M100, M101, and M102 implementations have been completed with verifier closure.

## Operating mode (explicit)
- **This tranche started PRD-first and is now implementation-active through M102.**
- M98–M102 implementation closure is complete; LP subsystem work (`M103+`) is now the next execution target.

## Source anchors (v2)
- API/event residuals: v2 section 11 (`docs/source/SwapGraph_System_Plan_v2.0_Feb2026.md`)
- Monetization/packaging residuals: v2 section 12
- Metrics/network-health residuals: v2 section 13
- Continuous workstreams (trust/safety, UX, reliability): v2 section 14
- Product surfaces (web/iOS/embedded): v2 section 4 and Appendix E/F

## Batch intent
- Keep fixtures-first, deterministic, verifier-gated discipline as the eventual implementation path.
- Convert remaining v2 residual scope into explicit milestone definitions.
- Use two PRD depth levels:
  - **Implementation-ready PRD**: concrete contract surface + verifier acceptance.
  - **Discovery-first PRD**: explicit scope, constraints, and closure questions; no implementation yet.

## Milestone definitions

### M98 — API + event surface completion contracts (**implementation-ready PRD**)
- Close remaining illustrative API/event coverage gaps as explicit contracts.
- Target surfaces:
  - `platform-connections`
  - `inventory snapshots/assets`
  - canonical disputes facade
  - event types: `proposal.cancelled`, `cycle.failed`, `user.reliability_changed`

### M99 — Trust & safety risk-signal contracts (**implementation-ready PRD**)
- Deterministic fraud/ATO signal recording + policy decision contracts.
- Signed trust/safety decision export and reason-code lineage.

### M100 — Metrics and network health contracts (**implementation-ready PRD**)
- Deterministic metric surfaces for north star, funnel, partner/API, and safety metrics.
- Signed metrics export + continuity/tamper checks.

### M101 — Product-surface readiness contracts (**implemented, fixtures-first**)
- Implemented contract surfaces for web marketplace, iOS reference client, and embedded partner UI readiness.
- Includes notification taxonomy/preferences + projection payload contracts + partner UI capability/bundle payload schemas.
- Closure evidence: `npm run verify:m101`, `node verify/runner.mjs milestones/M101.yaml`, and `artifacts/milestones/M101/latest/*`.

### M102 — Commercial packaging and policy contracts (**implemented, fixtures-first**)
- Implemented transaction-fee, subscription tier, boost guardrail, and quota/overage contract surfaces.
- Implemented deterministic policy evaluation precedence (`safety>trust>commercial>preference`) and non-bypass invariants.
- Implemented signed policy export continuation with attestation/checkpoint continuity and tamper-fail verification.
- Closure evidence: `npm run verify:m102`, `node verify/runner.mjs milestones/M102.yaml`, and `artifacts/milestones/M102/latest/*`.

## PRD completion checklist (required per milestone)
Each M98–M102 PRD must include:
1. Objective + scope + explicit non-goals.
2. Contract surface inventory (operation IDs / event types / object schemas).
3. Auth/scope and idempotency requirements.
4. Deterministic reason-code taxonomy.
5. Acceptance criteria + verifier gate expectation.
6. Open questions and resolution owner.

## Official development entry gate
Official development for M98+ starts only when:
- PRDs M98–M102 are accepted as source-of-truth,
- unresolved scope questions are explicitly resolved or deferred,
- execution order is approved.

## Cross-agent handoff recommendation
- Handoff + web-first BRD/discovery split guidance: `docs/prd/2026-02-21_handoff-web-first_brd-vs-discovery.md`
- BRD-01 (business outcomes + KPI bands): `docs/brd/2026-02-21_BRD-01_business-outcomes-kpi-bands.md`
- BRD-02 (trust/safety operating policy): `docs/brd/2026-02-21_BRD-02_trust-safety-operating-policy.md`
- BRD-03 (commercial packaging strategy): `docs/brd/2026-02-21_BRD-03_commercial-packaging-strategy.md`
- BRD-04 (partner segmentation/rollout strategy): `docs/brd/2026-02-21_BRD-04_partner-segmentation-rollout-strategy.md`
- Web-first discovery brief pack (D-W1..D-W5): `docs/prd/2026-02-21_web-first-discovery-brief-pack_D-W1-D-W5.md`
- Cross-agent approval board: `docs/prd/2026-02-21_cross-agent-approval-board_M98-M102.md`
- Additive LP subsystem PRD tranche (M103–M110): `docs/prd/2026-02-21_master-liquidity-provider-subsystem_M103-M110.md`
- LP subsystem approval board: `docs/prd/2026-02-21_cross-agent-approval-board_M103-M110.md`
- LP closure checklists (M103–M110): `docs/prd/2026-02-21_m103-prd-review-closure.md` … `docs/prd/2026-02-21_m110-prd-review-closure.md`
- LP proposed review baseline: `docs/prd/2026-02-21_m103-m110-proposed-review-baseline.md`
- BRD index: `docs/brd/README.md`

## Current review artifacts
- M98 closure checklist draft: `docs/prd/2026-02-21_m98-prd-review-closure.md`
- M99 closure checklist draft: `docs/prd/2026-02-21_m99-prd-review-closure.md`
- M100 closure checklist draft: `docs/prd/2026-02-21_m100-prd-review-closure.md`
- M101 closure checklist approved/implemented: `docs/prd/2026-02-21_m101-prd-review-closure.md`
- M102 closure checklist approved/implemented: `docs/prd/2026-02-21_m102-prd-review-closure.md`
