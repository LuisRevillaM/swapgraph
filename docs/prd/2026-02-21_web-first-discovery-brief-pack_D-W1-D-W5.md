# Web-first discovery brief pack — D-W1 to D-W5

Date: 2026-02-21  
Status: Draft for cross-agent execution planning (PRD-only mode)

## Purpose
Define focused discovery briefs so UI/product opportunities are tested before implementation decisions are locked.

## D-W1 — Inventory awakening and intent composition
- **Hypothesis:** clearer inventory awakening + suggested first-intent scaffolding reduces time-to-first-intent.
- **Target cohort:** new or reactivated users with synced inventory.
- **Primary success metric:** p75 time-to-first-intent (minutes).
- **Secondary metrics:** intent completion rate, abandonment in composer.
- **Failure criteria:** no meaningful p75 improvement or increased malformed intent rates.
- **Output artifact:** recommendation on minimum projection fields and onboarding copy primitives.

## D-W2 — Proposal card explainability and decision UX
- **Hypothesis:** higher explainability density (why matched, confidence, value framing) increases proposal accept rate without increasing post-accept cancellations.
- **Target cohort:** users with active proposal inbox volume.
- **Primary success metric:** proposal accept rate (bps).
- **Secondary metrics:** proposal dwell time, cancel-after-accept rate.
- **Failure criteria:** acceptance uplift paired with higher unwind/cancellation rates.
- **Output artifact:** approved proposal card information hierarchy for web-first MVP.

## D-W3 — Settlement timeline reassurance UX
- **Hypothesis:** a clearer timeline/checklist lowers settlement drop-off and support confusion.
- **Target cohort:** users with accepted proposals entering settlement.
- **Primary success metric:** accept-to-complete conversion (bps).
- **Secondary metrics:** step-level drop-off rate, status-refresh churn.
- **Failure criteria:** no completion improvement or increased user confusion signals.
- **Output artifact:** timeline/checklist content model and notification trigger recommendations.

## D-W4 — Receipt share and privacy decision UX
- **Hypothesis:** privacy-safe default share cards increase trust and optional sharing without privacy complaints.
- **Target cohort:** users with newly completed receipts.
- **Primary success metric:** safe-share adoption rate.
- **Secondary metrics:** privacy-toggle edits, support/privacy complaint incidence.
- **Failure criteria:** sharing uplift accompanied by privacy complaints or regret indicators.
- **Output artifact:** receipt-share metadata requirements and privacy default recommendations.

## D-W5 — Notification preferences and anti-spam defaults
- **Hypothesis:** better preference controls (quiet hours + urgency threshold + category controls) reduce notification fatigue while preserving critical action completion.
- **Target cohort:** active users receiving proposal/settlement notifications.
- **Primary success metric:** reduction in mute/disable actions.
- **Secondary metrics:** completion of critical actions after notification delivery.
- **Failure criteria:** reduced notifications with degraded settlement completion.
- **Output artifact:** default preference policy and taxonomy adjustments for M101 contracts.

## Common execution template (for every discovery brief)
1. Hypothesis and counter-hypothesis
2. Cohort definition and sample-size expectation
3. Success/failure thresholds
4. Risks and ethical/safety checks
5. Recommendation: ship / iterate / stop

## Handoff recommendation
Assign a primary owner per brief plus QA reviewer; require written go/no-go recommendation before UI implementation tickets are opened.
