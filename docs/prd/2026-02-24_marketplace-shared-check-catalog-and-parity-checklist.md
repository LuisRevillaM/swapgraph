# Marketplace Clients Shared Check Catalog and Parity Checklist

Date: 2026-02-24
Status: Phase 0 execution artifact
Applies to:
- `docs/prd/2026-02-24_marketplace-ios-native-client-plan.md`
- `docs/prd/2026-02-24_marketplace-web-mobile-first-client-plan.md`

## Shared check catalog (must be used by both agent plans)

| Check ID | Gate | Check | Evidence required |
|---|---|---|---|
| SC-G0-01 | G0 | Task schema completeness | Task matrix lint report (all required fields) |
| SC-G0-02 | G0 | Dependency graph acyclic | DAG validation report |
| SC-DS-01 | G1 | Design token parity | Token diff report against design spec export |
| SC-DS-02 | G1 | Readability floor | Text-size and contrast audit report |
| SC-UX-01 | G2 | Journey J1: first intent under 60s median | Funnel trace and timing report |
| SC-UX-02 | G2 | Journey J2: proposal decision clarity | Usability checklist + event proof |
| SC-UX-03 | G2 | Journey J3: active timeline clarity | State labeling checklist |
| SC-UX-04 | G2 | Journey J4: receipt clarity | Receipt UX checklist |
| SC-API-01 | G3 | API schema conformance | Contract test report |
| SC-API-02 | G3 | Auth scope conformance | Scope matrix + request proof |
| SC-API-03 | G3 | Idempotency replay handling | Replay test report |
| SC-API-04 | G3 | Error envelope consistency | Error contract snapshot report |
| SC-AN-01 | G6 | Event taxonomy coverage | Event catalog coverage matrix |
| SC-AN-02 | G6 | Funnel ordering correctness | Ordered event sequence report |
| SC-AN-03 | G6 | Analytics payload schema validity | Payload validation report |
| SC-RL-01 | G7 | Offline read continuity | Offline scenario test report |
| SC-RL-02 | G7 | Retry/backoff behavior | Retry scenario evidence |
| SC-RL-03 | G7 | Stale-data signaling | UI stale-state checklist |
| SC-AX-01 | G4 | Contrast/readability conformance | Accessibility report |
| SC-AX-02 | G4 | Assistive semantics/focus order | Accessibility report |
| SC-AX-03 | G4 | Touch target size baseline | Accessibility report |
| SC-PF-01 | G5 | Startup performance budget | Perf trace report |
| SC-PF-02 | G5 | Interaction latency budget | Perf trace report |
| SC-PF-03 | G5 | Long-list scroll performance | Perf trace report |
| SC-SEC-01 | G8 | Secure local storage | Security checklist evidence |
| SC-SEC-02 | G8 | Session/auth boundary controls | Security checklist evidence |
| SC-SEC-03 | G8 | Privacy and log redaction | Security checklist evidence |
| SC-RR-01 | G9 | Release checklist closure | Signed release checklist |
| SC-RR-02 | G9 | Rollback drill viability | Rollback drill evidence |
| SC-RR-03 | G9 | iOS/web parity sign-off | Final parity checklist sign-off |

## Shared parity checklist (critical journeys and behavior)
Both agents must complete this checklist before release sign-off.

| ID | Parity item | Expected parity outcome |
|---|---|---|
| PC-01 | Five-tab IA (Items, Intents, Inbox, Active, Receipts) | Same conceptual IA and label intent |
| PC-02 | First-intent flow | Same structured fields and validation semantics |
| PC-03 | "System always running" model | No manual run button in product UX |
| PC-04 | Proposal explanation primitives | Value delta, confidence, constraint fit always present |
| PC-05 | Accept/decline semantics | Same idempotent behavior and user feedback states |
| PC-06 | Active timeline wait reasons | Same explicit wait reason semantics |
| PC-07 | Receipt metadata | Same status/date/type/verification/value metadata semantics |
| PC-08 | Error envelope rendering | Same high-level reason classes and retry affordances |
| PC-09 | Analytics event names | Same base taxonomy and funnel sequence |
| PC-10 | Offline stale banner semantics | Same stale-state disclosure behavior |
| PC-11 | Security posture | Equivalent session/storage/privacy guarantees |
| PC-12 | Accessibility floor | Equivalent readability and assistive behavior baseline |

## Required sign-off roles
1. Product/UX lead
2. iOS planning agent owner
3. Web planning agent owner
4. API/platform owner
5. QA/reliability owner
