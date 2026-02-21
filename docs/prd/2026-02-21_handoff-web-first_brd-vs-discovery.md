# SwapGraph Handoff Recommendations — PRD / BRD / Discovery Split (Web-first)

Date: 2026-02-21  
Status: Recommendation pack (PRD-only mode; no implementation)

## Why this exists
This document is for cross-agent handoff: other agents should be able to run and extend the system by relying on explicit contract PRDs, while business intent and UI exploration are captured separately where they belong.

## Operating posture
- Keep **PRD-only mode** for implementation planning until approval.
- Treat M98–M102 PRDs + closure checklists as canonical technical scope.
- Add a lightweight **BRD layer** for business decisions that should not be hardcoded as API contracts.
- Add focused **discovery briefs** for UX/product-surface opportunities (starting with web).

## Recommended split by area
| Area | Primary artifact | Why |
|---|---|---|
| API/event completion (M98) | Implementation-ready PRD | Contract precision + deterministic verifier plan are the main risk reducers |
| Trust/safety signals + decisions (M99) | Implementation-ready PRD + BRD guardrails | API semantics are technical; risk appetite/ops posture are business decisions |
| Metrics/network health (M100) | Implementation-ready PRD + BRD targets | Metric contracts are technical; KPI targets/thresholds are business |
| Product surfaces (M101) | Discovery-first PRD + UX discovery briefs | Need to test user behavior/experience before locking implementation |
| Commercial packaging (M102) | BRD-first + discovery-first PRD | Packaging, pricing, and tier boundaries are business model decisions first |

## What should be BRD (recommended)
1. **Business outcomes + KPI target bands**
   - North-star metric priority and target ranges
   - Funnel targets and acceptable tradeoffs
2. **Trust/safety operating policy**
   - Risk tolerance, manual-review budget, escalation SLAs
3. **Commercial packaging strategy**
   - Tier design, fee strategy, quota/overage policy intent
4. **Partner segmentation + rollout strategy**
   - Which partner segments get which features first, and under what guardrails

## What deserves dedicated discovery (recommended)
1. **Web-first UX loop discovery** (before UI build)
2. **Notification fatigue vs urgency policy validation**
3. **Receipt sharing/privacy behavior**
4. **Embedded partner UI ergonomics**

## Web-first discovery recommendation (my intuition)
Prioritize discovery in this order:
1. **Inventory awakening → first intent created**
   - Goal: reduce time-to-first-intent and confusion around value/swapability.
2. **Proposal inbox → accept confidence**
   - Goal: improve accept rate by clear explainability/trust cues.
3. **Settlement timeline → completion confidence**
   - Goal: reduce drop-off at deposit/execution steps with clearer progress/risk messaging.
4. **Receipt share card + privacy controls**
   - Goal: improve trust and viral proof without privacy regressions.

## Suggested discovery brief pack (for M101 follow-on)
- `D-W1`: Inventory awakening and intent composition
- `D-W2`: Proposal card explainability and decision UX
- `D-W3`: Settlement checklist/timeline reassurance UX
- `D-W4`: Receipt share/privacy decision UX
- `D-W5`: Notification preferences and anti-spam defaults

Each brief should include: hypothesis, target cohort, success metric, failure criteria, and go/no-go recommendation.

## Seed artifacts added (2026-02-21)
- BRD-01: `docs/brd/2026-02-21_BRD-01_business-outcomes-kpi-bands.md`
- BRD-02: `docs/brd/2026-02-21_BRD-02_trust-safety-operating-policy.md`
- Discovery pack: `docs/prd/2026-02-21_web-first-discovery-brief-pack_D-W1-D-W5.md`

## Cross-agent handoff acceptance
Before implementation approval for M98+:
1. M98–M102 closure checklists are approved (or amended/approved).
2. BRD decisions are recorded for KPI targets, trust policy posture, and packaging strategy.
3. Discovery brief owners are assigned for web-first sequence (D-W1..D-W5).
4. Execution order (contracts first vs discovery first where needed) is explicitly approved.
