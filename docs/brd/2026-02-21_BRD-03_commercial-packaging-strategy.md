# BRD-03 — Commercial packaging strategy and pricing guardrails

Date: 2026-02-21  
Status: Draft for approval (PRD-only mode, no implementation)

## Purpose
Define first-release commercial packaging intent so M102 contracts are driven by explicit business strategy rather than ad hoc policy tuning.

## Scope
- Transaction fee strategy (base + modifiers).
- Subscription tier strategy (benefits, limits, constraints).
- Boost/priority strategy with fairness controls.
- Quota/overage strategy and billing posture.

Out of scope:
- Payment gateway implementation.
- Final public price publication.
- Jurisdiction-specific tax/legal implementation details.

## Packaging principles (recommended)
1. **Safety before monetization**: commercial levers never bypass trust/safety outcomes.
2. **Value-aligned pricing**: monetization should map to measurable partner value.
3. **Predictable economics**: avoid surprising fee jumps and opaque penalties.
4. **Fair marketplace behavior**: boosts can prioritize visibility, not violate matching/settlement invariants.

## Initial packaging model (proposed)
| Package | Target partner profile | Core benefits | Guardrails |
|---|---|---|---|
| Starter | low-volume/new partners | baseline API + basic reporting | strict quota, conservative trust thresholds |
| Growth | scaling partners | higher quota, advanced reporting, workflow controls | trust milestones required for higher caps |
| Scale | high-volume mature partners | premium throughput, deeper audit/export access | strict safety posture, operational readiness checks |

## Monetization levers (proposed)
### Transaction fee
- Base transaction fee with transparent modifier categories (volume, risk posture, support tier).
- Fee policy outputs should be deterministic and explainable in partner reads.

### Subscription tiers
- Subscription controls access to capabilities and quota envelopes.
- Subscription **does not** override trust/safety restrictions.

### Boost/priority
- Boost affects ranking/priority only within fairness and integrity bounds.
- No boost can force unsafe or policy-disallowed outcomes.

### Quota/overage
- Quota bands by package with explicit overage behavior.
- Overage handling should be deterministic: throttle, queue, or deny with reason codes.

## Pricing guardrails
- Cap monthly effective fee volatility for a partner unless explicit policy notice window is met.
- Require explainable policy-evaluation outputs for every denial/throttle due to commercial rules.
- Preserve partner-level visibility into effective policy (without exposing sensitive internal pricing internals).

## Dependencies
- M102 PRD (`docs/prd/M102.md`)
- BRD-02 trust/safety policy (`docs/brd/2026-02-21_BRD-02_trust-safety-operating-policy.md`)
- BRD-04 partner segmentation (`docs/brd/2026-02-21_BRD-04_partner-segmentation-rollout-strategy.md`)

## Open business decisions for approval
1. Approve initial package taxonomy (Starter/Growth/Scale) or rename/restructure.
2. Approve boost commercialization policy boundaries.
3. Approve quota-overage default behavior (throttle vs queue vs deny by segment).
4. Approve partner-visible pricing transparency depth for v1 contracts.

## Approval gate
BRD-03 is accepted when package strategy, monetization levers, and pricing guardrails are explicitly approved and mapped to M102 contract boundaries.
