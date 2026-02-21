# SwapGraph Next Batch Forecast (M98–M102)

Date: 2026-02-21

Goal: define the post-M97 tranche so all remaining v2 areas are fully PRD-scoped before official development starts.

## Operating mode (explicit)
- **This tranche is PRD-first and PRD-only until explicit approval for implementation.**
- No feature implementation starts from M98+ until PRD acceptance checkpoint is confirmed.

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

### M101 — Product-surface readiness contracts (**discovery-first PRD**)
- Contract surfaces required for web marketplace, iOS reference client, and embedded partner UI.
- Notification taxonomy/preferences + projection payloads + UI embed payload schemas.
- No client implementation in this milestone.

### M102 — Commercial packaging and policy contracts (**discovery-first PRD**)
- Transaction-fee, subscription tier, boost-priority, and quota/overage contract definitions.
- Safety invariant enforcement: no commercial bypass of trust/risk policy gates.
- No pricing rollout implementation in this milestone.

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

## Current review artifacts
- M98 closure checklist draft: `docs/prd/2026-02-21_m98-prd-review-closure.md`
- M99 closure checklist draft: `docs/prd/2026-02-21_m99-prd-review-closure.md`
- M100 closure checklist draft: `docs/prd/2026-02-21_m100-prd-review-closure.md`
- M101 closure checklist draft: `docs/prd/2026-02-21_m101-prd-review-closure.md`
- M102 closure checklist draft: `docs/prd/2026-02-21_m102-prd-review-closure.md`
