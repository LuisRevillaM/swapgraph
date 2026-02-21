# BRD Index — SwapGraph

Purpose: business decision layer that complements PRDs.  
Mode: PRD-only for implementation; BRDs define business posture and constraints for cross-agent handoff.

## Current BRDs
- `2026-02-21_BRD-01_business-outcomes-kpi-bands.md`
  - North-star + KPI target bands + growth/safety guardrails.
- `2026-02-21_BRD-02_trust-safety-operating-policy.md`
  - Trust/safety operating posture, review SLAs, and escalation policy.
- `2026-02-21_BRD-03_commercial-packaging-strategy.md`
  - Packaging strategy, monetization levers, and pricing guardrails.
- `2026-02-21_BRD-04_partner-segmentation-rollout-strategy.md`
  - Partner segmentation, eligibility gates, rollout matrix, rollback policy.

## Suggested review order
1. BRD-01 (outcomes/KPIs)
2. BRD-02 (trust/safety operating posture)
3. BRD-04 (partner segmentation + rollout)
4. BRD-03 (commercial strategy, constrained by BRD-02/04)

## PRD linkage
- M99 ↔ BRD-02
- M100 ↔ BRD-01
- M101 ↔ BRD-01 + BRD-04 + discovery pack
- M102 ↔ BRD-01 + BRD-02 + BRD-03 + BRD-04
- M109 ↔ BRD-02 + BRD-03 + BRD-04
- M110 ↔ BRD-01 + BRD-04 + discovery pack
