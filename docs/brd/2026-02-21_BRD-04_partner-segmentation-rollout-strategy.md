# BRD-04 — Partner segmentation and rollout strategy

Date: 2026-02-21  
Status: Draft for approval (PRD-only mode, no implementation)

## Purpose
Define partner segmentation and phased rollout policy so other agents can execute predictable onboarding, gating, and expansion decisions.

## Scope
- Partner segment definitions and eligibility criteria.
- Feature/access rollout matrix by segment.
- Rollback and escalation triggers.
- Operational readiness requirements for segment upgrades.

Out of scope:
- Individual partner commercial negotiation terms.
- Production migration implementation details.

## Segmentation model (proposed)
| Segment | Description | Typical volume | Operational expectation |
|---|---|---|---|
| S0 Internal | internal testing / synthetic traffic | minimal | strict operator supervision |
| S1 Design Partner | high-touch early external partner | low–moderate | weekly review and manual controls |
| S2 Verified Partner | validated partner with stable operations | moderate–high | policy compliance + SLA adherence |
| S3 Scaled Partner | mature high-volume partner | high | hardened reliability and governance posture |

## Eligibility gates (proposed)
- Trust/safety baseline achieved (per BRD-02).
- Reliability and webhook health above agreed thresholds.
- Audit/export conformance posture acceptable.
- No unresolved critical policy violations in recent window.

## Rollout matrix (proposed)
| Capability family | S0 | S1 | S2 | S3 |
|---|---:|---:|---:|---:|
| Core settlement/read contracts | ✅ | ✅ | ✅ | ✅ |
| Advanced diagnostics/governance exports | ✅ | ✅ (limited) | ✅ | ✅ |
| Trust/safety automated policy decisions | ✅ | ✅ (guarded) | ✅ | ✅ |
| Commercial packaging controls (M102) | ⚠️ internal-only | ⚠️ pilot subset | ✅ | ✅ |
| Embedded/UI payload contracts (M101) | ✅ | ✅ pilot | ✅ | ✅ |

## Upgrade/downgrade policy (recommended)
- Upgrades require passing eligibility gates for two consecutive review windows.
- Downgrades can be automatic on severe trust/reliability incidents.
- Re-upgrade requires remediation evidence and review sign-off.

## Rollback triggers (recommended)
- Safety incident spike above defined red band.
- Reliability degradation beyond agreed threshold windows.
- Material partner policy violations or abuse findings.

## Dependencies
- BRD-01 KPI governance (`docs/brd/2026-02-21_BRD-01_business-outcomes-kpi-bands.md`)
- BRD-02 trust/safety operating policy (`docs/brd/2026-02-21_BRD-02_trust-safety-operating-policy.md`)
- BRD-03 commercial packaging strategy (`docs/brd/2026-02-21_BRD-03_commercial-packaging-strategy.md`)
- M101/M102 PRDs (`docs/prd/M101.md`, `docs/prd/M102.md`)

## Open business decisions for approval
1. Approve segment taxonomy (S0–S3) and criteria.
2. Approve capability gating matrix per segment.
3. Approve upgrade/downgrade cadence and rollback authority.
4. Approve minimum evidence required for segment promotion.

## Approval gate
BRD-04 is accepted when segments, eligibility criteria, rollout matrix, and rollback governance are explicitly approved.
