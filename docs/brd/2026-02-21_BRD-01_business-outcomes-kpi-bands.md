# BRD-01 — Business outcomes and KPI target bands (Web-first)

Date: 2026-02-21  
Status: Draft for approval (PRD-only mode, no implementation)

## Purpose
Define the business outcome model and KPI target bands that should guide M100 metric contracts and M101 web-first discovery decisions.

## Scope
- Business outcomes and KPI targets for the next delivery phase.
- Web-first focus for product-surface prioritization.
- Partner and safety guardrails to prevent growth-only optimization.

Out of scope:
- API schema definitions (handled in PRDs).
- UI implementation and production rollout.

## North-star and supporting outcomes
### North-star (recommended)
- **Weekly successful swaps per active trader (WSAT)**

### Supporting outcome pillars
1. **Activation velocity**: inventory awakening → first intent.
2. **Match confidence**: proposal viewed → accepted.
3. **Execution reliability**: accepted → completed.
4. **Trust-preserving growth**: growth without safety regressions.

## KPI target bands (proposed)
> These are provisional business bands for approval; they are not implementation constraints yet.

| KPI | Definition | Green | Yellow | Red |
|---|---|---:|---:|---:|
| WSAT (north-star) | Successful swaps / active traders (weekly) | >= 1.50 | 1.00–1.49 | < 1.00 |
| Fill rate 7d (bps) | Accepted proposals / eligible intents | >= 4500 | 3000–4499 | < 3000 |
| Proposal accept rate (bps) | Accepted / viewed proposals | >= 3500 | 2200–3499 | < 2200 |
| Settlement completion rate (bps) | Completed / accepted cycles | >= 9200 | 8500–9199 | < 8500 |
| Time-to-first-intent (p75) | Minutes from inventory awakening to first intent | <= 20 | 21–45 | > 45 |
| Manual-review rate (bps) | Manual review decisions / trust decisions | <= 1200 | 1201–2200 | > 2200 |
| Confirmed abuse rate (per 1k intents) | Confirmed abuse incidents per 1000 intents | <= 2.0 | 2.1–4.0 | > 4.0 |
| Refund/unwind rate (bps) | Refund or unwind cycles / completed cycles | <= 150 | 151–300 | > 300 |

## Web-first prioritization guidance
Order of execution for business impact:
1. **Activation loop**: inventory awakening and intent composition.
2. **Decision loop**: proposal explainability and acceptance confidence.
3. **Execution loop**: settlement timeline clarity and reassurance.
4. **Trust/social loop**: receipt sharing with privacy-safe defaults.

## Guardrails (non-negotiable)
- Trust/safety regressions veto growth optimizations.
- No commercial optimization may bypass trust/safety policy outcomes.
- KPI reporting must preserve partner/tenant data boundaries.

## Dependencies
- M99 (trust/safety decision contracts)
- M100 (metrics contract surfaces)
- M101 (web-first product-surface discovery)

## Open business decisions for approval
1. Confirm WSAT as canonical north-star vs fill-rate-first framing.
2. Approve initial KPI bands or adjust for conservative rollout.
3. Confirm growth-vs-safety escalation policy when metrics conflict.

## Approval gate
BRD-01 is accepted when north-star choice, KPI bands, and growth/safety tradeoff policy are explicitly approved.
