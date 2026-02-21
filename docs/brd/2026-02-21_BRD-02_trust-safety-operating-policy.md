# BRD-02 — Trust & safety operating policy (Web-first phase)

Date: 2026-02-21  
Status: Draft for approval (PRD-only mode, no implementation)

## Purpose
Define operating policy for trust/safety decisions so M99 contracts are governed by clear business posture, manual-review capacity, and escalation rules.

## Scope
- Decision policy posture (`allow`, `manual_review`, `block`).
- Manual-review operations and SLA expectations.
- Escalation, appeals, and partner communication expectations.
- Safety-over-growth precedence rules.

Out of scope:
- Fraud model training/tuning.
- Manual-review tooling implementation.
- Production enforcement rollout.

## Policy posture (recommended)
1. **Safety and trust override growth/commercial goals.**
2. **Deterministic default behavior** for equivalent signal sets.
3. **Explainable decisions** with stable reason-code taxonomy.
4. **Least surprise for users/partners** (clear action + next steps).

## Decision ladder (recommended)
| Outcome | Typical trigger profile | Required metadata |
|---|---|---|
| `allow` | Low severity + low confidence risk, no hard-stop signals | reason codes, signal refs, confidence score |
| `manual_review` | Medium severity or confidence ambiguity, conflicting signals | reason codes, review priority, SLA target |
| `block` | High severity/high confidence or hard-stop abuse patterns | reason codes, block duration/policy, appeal route |

## Manual-review operating envelope (proposed)
- **Queue SLO:** 95% of review cases triaged within 4h (business hours) / 12h (off-hours).
- **Critical-case SLO:** 95% triaged within 1h.
- **Backlog control:** if queue exceeds target for 2 consecutive windows, tighten signal thresholds and reduce non-critical review inflow.

## Escalation and appeals (recommended)
- Provide deterministic appeal intake with correlation IDs.
- Appeals for blocked cases require documented reason-code review.
- Partner-facing communication should include: decision class, top reason code family, and next-action requirements.

## Safety invariants (non-bypass)
- Commercial tier/boost/quota policy cannot override `block` decisions.
- Subscription upgrades cannot auto-clear trust restrictions.
- High-risk trust posture can reduce available commercial actions.

## Operating KPIs (policy health)
- Manual-review rate (bps)
- Review-to-allow / review-to-block ratios
- False-positive proxy rate (appeal overturn rate)
- Confirmed abuse rate per 1k intents
- Time-to-resolution for reviewed and appealed decisions

## Dependencies
- M99 PRD (`docs/prd/M99.md`) for contract surfaces.
- BRD-01 for KPI band governance.
- M102 for commercial non-bypass policy precedence.

## Open business decisions for approval
1. Confirm manual-review capacity assumptions and SLA windows.
2. Confirm appeal transparency depth for partner-facing responses.
3. Confirm block-duration policy model (fixed bands vs adaptive).

## Approval gate
BRD-02 is accepted when decision posture, review SLAs, escalation/appeal model, and non-bypass safety invariants are explicitly approved.
