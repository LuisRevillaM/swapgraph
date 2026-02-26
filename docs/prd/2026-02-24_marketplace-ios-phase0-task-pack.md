# Marketplace iOS Phase 0 Task Pack

Date: 2026-02-24
Status: Draft v0.1 (execution-ready planning artifact)
Track: Swift native iOS
References:
- `docs/prd/2026-02-24_marketplace-ios-native-client-plan.md`
- `docs/prd/2026-02-24_marketplace-client-dual-agent-operating-contract.md`
- `docs/prd/2026-02-24_marketplace-shared-check-catalog-and-parity-checklist.md`

## A. Dependency-ordered task matrix (schema-complete)

| Order | Task ID | Epic | User-visible outcome | Implementation notes | Dependencies | Risks | Verification mapping | Definition of done | Size |
|---|---|---|---|---|---|---|---|---|---|
| 1 | IOS-T001 | Foundation | User can navigate 5-tab shell | Build SwiftUI root navigation, route stubs, feature flags | none | R-01,R-03 | SC-G0-01,SC-UX-03 | All 5 tabs accessible with deterministic routing | M |
| 2 | IOS-T004 | Foundation | Data renders consistently across screens | Define domain models for intent/proposal/timeline/receipt | IOS-T001 | R-02,R-03 | SC-API-01,SC-G0-01 | Shared model package compiles and used by all feature modules | M |
| 3 | IOS-T005 | Foundation | App can read/write platform APIs reliably | Implement API client, auth headers, idempotency keys, retries | IOS-T004 | R-02,R-04,R-09 | SC-API-01,SC-API-02,SC-API-03 | Health + intents + proposals + timeline + receipts API flows pass | L |
| 4 | IOS-T002 | Foundation | Visual system matches design tokens | Map token JSON to SwiftUI color/spacing/shadow constants | IOS-T001 | R-01 | SC-DS-01 | Token diff report shows no blocking drift | M |
| 5 | IOS-T003 | Foundation | Informational text remains readable | Implement typography styles and enforce floor at `--t-sm` equivalent | IOS-T002 | R-07 | SC-DS-02,SC-AX-01 | Text styles pass readability/contrast baseline | M |
| 6 | IOS-T006 | Foundation | Users see clear failures and recovery options | Add typed error model and reusable fallback UI states | IOS-T005 | R-03,R-04 | SC-API-04,SC-RL-02 | Standardized error patterns used in all flow surfaces | M |
| 7 | IOS-T007 | Foundation | Product funnel is measurable end-to-end | Add analytics event client with schema guardrails | IOS-T005 | R-10 | SC-AN-01,SC-AN-03 | Event emitter validates payloads and rejects invalid events | M |
| 8 | IOS-T008 | Foundation | Key screens remain useful during poor connectivity | Add persistence/cache layer for offline read continuity | IOS-T004 | R-06,R-09 | SC-RL-01,SC-SEC-01 | Cache hydrates and invalidates with deterministic policy | L |
| 9 | IOS-T009 | Foundation | Notification/deep-link entry opens correct destination | Add deep-link router for proposal/active/receipt routes | IOS-T001 | R-11 | SC-UX-02,SC-UX-03 | Links resolve to correct screen and entity reliably | M |
| 10 | IOS-T010 | Foundation | Changes are testable and regressions detectable | Configure XCTest, snapshots, integration and UI smoke harness | IOS-T001,IOS-T004,IOS-T005 | R-12 | SC-G0-01,SC-G0-02 | Test scaffolding runs in CI with baseline suite | M |
| 11 | IOS-T011 | Items | User sees inventory with demand signals | Build Items screen list/grid and demand banner | IOS-T002,IOS-T003,IOS-T004,IOS-T005 | R-03,R-08 | SC-UX-01,SC-PF-03 | Items render with correct sections and empty/error states | M |
| 12 | IOS-T012 | Items | Item cards are legible and scannable | Build card metadata layout (name, wear, price, demand, float) | IOS-T011 | R-07,R-08 | SC-DS-02,SC-AX-01 | Item cards pass readability and spacing checks | S |
| 13 | IOS-T013 | Intents | User sees standing intents and watch state | Build Intents screen with persistent watching indicators | IOS-T002,IOS-T003,IOS-T004,IOS-T005 | R-03 | SC-UX-01,SC-API-01 | Watching/no-match/matched states render with correct semantics | M |
| 14 | IOS-T014 | Intents | User can create intent through structured flow | Build composer sheet with required structured fields | IOS-T013 | R-03,R-07 | SC-UX-01,SC-DS-02 | Composer enforces required fields and constraints | M |
| 15 | IOS-T015 | Intents | User can create/edit/cancel intents confidently | Add intent mutations with optimistic updates + fallback guards | IOS-T014,IOS-T005,IOS-T006 | R-04,R-06 | SC-API-03,SC-RL-02 | Mutation retries are idempotent and user feedback stays consistent | L |
| 16 | IOS-T016 | Inbox | User can browse ranked proposal inbox | Build inbox list with proposal summaries | IOS-T002,IOS-T003,IOS-T004,IOS-T005 | R-03,R-08 | SC-UX-02,SC-PF-03 | Inbox shows ordered proposals with no clipped critical metadata | M |
| 17 | IOS-T017 | Inbox | User understands ranking and urgency quickly | Implement ranking presentation, sections, status cues | IOS-T016 | R-03 | SC-UX-02,SC-AN-02 | Ranking cues match API order and urgency policy | S |
| 18 | IOS-T018 | ProposalDetail | User sees give/get and cycle context clearly | Build proposal detail hero and participant cycle visual | IOS-T016,IOS-T004 | R-03,R-08 | SC-UX-02,SC-PF-02 | Detail screen renders all proposal entities without ambiguity | M |
| 19 | IOS-T019 | ProposalDetail | User can understand why proposal exists | Add explainability cards (value delta/confidence/constraint fit) | IOS-T018 | R-03,R-10 | SC-UX-02,SC-AN-01 | All three explanation primitives present for each proposal | S |
| 20 | IOS-T020 | ProposalDetail | User can accept/decline safely with reliable feedback | Implement decision actions with idempotent state handling | IOS-T018,IOS-T005,IOS-T006 | R-04,R-06 | SC-API-03,SC-UX-02 | Repeated submit attempts do not create divergent outcomes | M |
| 21 | IOS-T021 | Active | User can understand settlement progress at a glance | Build active swap header + progress bar | IOS-T004,IOS-T005 | R-03 | SC-UX-03 | Header and progress reflect canonical state machine | M |
| 22 | IOS-T022 | Active | User always sees explicit wait reason/next step | Build timeline event list with wait reason language | IOS-T021 | R-03,R-07 | SC-UX-03,SC-AX-02 | No active state lacks action/wait explanation | M |
| 23 | IOS-T023 | Active | User can take valid next actions only | Add state-aware action affordances and disabled states | IOS-T022,IOS-T020 | R-03,R-04 | SC-UX-03,SC-API-04 | Invalid actions are blocked with explicit reasons | M |
| 24 | IOS-T024 | Receipts | User can review completed outcomes | Build receipts list with status + key metadata | IOS-T004,IOS-T005 | R-03 | SC-UX-04,SC-API-01 | Receipts list matches API projection and filter semantics | M |
| 25 | IOS-T025 | Receipts | User can inspect proof metadata in detail | Build receipt detail verification metadata view | IOS-T024 | R-03,R-07 | SC-UX-04,SC-AX-01 | Detail view exposes verification context and value outcomes | S |
| 26 | IOS-T026 | Notifications | User receives actionable proposal/settlement alerts | Implement push intake and route mapping | IOS-T009,IOS-T005 | R-05,R-11 | SC-UX-02,SC-UX-03 | Push tap opens correct route and entity under app states | L |
| 27 | IOS-T027 | Notifications | User controls notification noise | Add in-app preferences for category and urgency | IOS-T026,IOS-T013 | R-05 | SC-AN-01,SC-RL-03 | Preferences persist and affect routing/filter behavior | M |
| 28 | IOS-T028 | Offline | User can read core screens when offline | Implement cache hydration + stale-state banners | IOS-T008,IOS-T011,IOS-T013,IOS-T016,IOS-T021,IOS-T024 | R-06,R-09 | SC-RL-01,SC-RL-03 | Offline read works for core tabs with explicit stale disclosure | L |
| 29 | IOS-T029 | Accessibility | Assistive-tech users can complete critical flows | VoiceOver labels, focus order, touch-target tuning | IOS-T011,IOS-T013,IOS-T016,IOS-T018,IOS-T021,IOS-T024 | R-07 | SC-AX-01,SC-AX-02,SC-AX-03 | Critical journeys are passable with assistive tooling | M |
| 30 | IOS-T030 | Performance | App remains responsive on target devices | Optimize startup/tab switch/list performance budgets | IOS-T011,IOS-T013,IOS-T016,IOS-T018,IOS-T021 | R-08 | SC-PF-01,SC-PF-02,SC-PF-03 | Perf budgets meet agreed thresholds on target profiles | M |
| 31 | IOS-T031 | Security | Session and local data handling are hardened | Enforce secure storage, auth boundaries, log redaction | IOS-T005,IOS-T008,IOS-T026 | R-09,R-11 | SC-SEC-01,SC-SEC-02,SC-SEC-03 | Security checklist passes with no high-severity findings | M |
| 32 | IOS-T032 | Release | Team has launch confidence with rollback | Execute final parity audit and release-readiness closeout | IOS-T029,IOS-T030,IOS-T031,IOS-T027,IOS-T028 | R-12 | SC-RR-01,SC-RR-02,SC-RR-03 | Launch checklist signed and rollback drill verified | M |

## B. Dependency graph (adjacency list)

- IOS-T001 -> IOS-T004, IOS-T002, IOS-T009, IOS-T010
- IOS-T004 -> IOS-T005, IOS-T008, IOS-T011, IOS-T013, IOS-T016, IOS-T021, IOS-T024
- IOS-T005 -> IOS-T006, IOS-T007, IOS-T010, IOS-T015, IOS-T020, IOS-T026, IOS-T031
- IOS-T002 -> IOS-T003, IOS-T011, IOS-T013, IOS-T016
- IOS-T003 -> IOS-T011, IOS-T013, IOS-T016
- IOS-T006 -> IOS-T015, IOS-T020
- IOS-T008 -> IOS-T028, IOS-T031
- IOS-T009 -> IOS-T026
- IOS-T010 -> (test harness dependency only)
- IOS-T011 -> IOS-T012, IOS-T028, IOS-T029, IOS-T030
- IOS-T013 -> IOS-T014, IOS-T027, IOS-T028, IOS-T029, IOS-T030
- IOS-T014 -> IOS-T015
- IOS-T015 -> (mutations feed later validation and release)
- IOS-T016 -> IOS-T017, IOS-T018, IOS-T028, IOS-T029, IOS-T030
- IOS-T018 -> IOS-T019, IOS-T020, IOS-T029, IOS-T030
- IOS-T020 -> IOS-T023
- IOS-T021 -> IOS-T022, IOS-T028, IOS-T029, IOS-T030
- IOS-T022 -> IOS-T023
- IOS-T024 -> IOS-T025, IOS-T028, IOS-T029
- IOS-T026 -> IOS-T027, IOS-T031
- IOS-T027 -> IOS-T032
- IOS-T028 -> IOS-T032
- IOS-T029 -> IOS-T032
- IOS-T030 -> IOS-T032
- IOS-T031 -> IOS-T032

## C. Verification map (check ID -> tasks)

| Check ID | Tasks mapped |
|---|---|
| SC-G0-01 | IOS-T001..IOS-T032 (schema completeness), IOS-T010 |
| SC-G0-02 | IOS-T001..IOS-T032 dependency DAG |
| SC-DS-01 | IOS-T002 |
| SC-DS-02 | IOS-T003, IOS-T012, IOS-T014 |
| SC-UX-01 | IOS-T011, IOS-T013, IOS-T014, IOS-T015 |
| SC-UX-02 | IOS-T016, IOS-T017, IOS-T018, IOS-T019, IOS-T020, IOS-T026 |
| SC-UX-03 | IOS-T021, IOS-T022, IOS-T023, IOS-T026 |
| SC-UX-04 | IOS-T024, IOS-T025 |
| SC-API-01 | IOS-T004, IOS-T005, IOS-T013, IOS-T024 |
| SC-API-02 | IOS-T005 |
| SC-API-03 | IOS-T005, IOS-T015, IOS-T020 |
| SC-API-04 | IOS-T006, IOS-T023 |
| SC-AN-01 | IOS-T007, IOS-T019, IOS-T027 |
| SC-AN-02 | IOS-T017 |
| SC-AN-03 | IOS-T007 |
| SC-RL-01 | IOS-T008, IOS-T028 |
| SC-RL-02 | IOS-T006, IOS-T015 |
| SC-RL-03 | IOS-T027, IOS-T028 |
| SC-AX-01 | IOS-T003, IOS-T012, IOS-T025, IOS-T029 |
| SC-AX-02 | IOS-T022, IOS-T029 |
| SC-AX-03 | IOS-T029 |
| SC-PF-01 | IOS-T030 |
| SC-PF-02 | IOS-T018, IOS-T030 |
| SC-PF-03 | IOS-T011, IOS-T016, IOS-T030 |
| SC-SEC-01 | IOS-T008, IOS-T031 |
| SC-SEC-02 | IOS-T005, IOS-T031 |
| SC-SEC-03 | IOS-T031 |
| SC-RR-01 | IOS-T032 |
| SC-RR-02 | IOS-T032 |
| SC-RR-03 | IOS-T032 |

## D. Risk register

| Risk ID | Description | Impact | Mitigation | Rollback trigger | Rollback action |
|---|---|---|---|---|---|
| R-01 | Token drift from design spec | High | Lock token export and parity diff in CI | SC-DS-01 fails twice in row | Freeze UI styling changes, re-sync token mapping |
| R-02 | API schema drift vs client models | High | Contract tests on each merge | SC-API-01 regression in critical route | Pin to last known contract and gate deploy |
| R-03 | State-machine semantics diverge from UX spec | High | Shared state glossary and parity reviews | SC-UX-03 or PC-06 fail | Revert to previous state renderer and re-validate |
| R-04 | Idempotency race on accept/decline or intent mutations | High | Enforce idempotency keys and replay tests | SC-API-03 failure | Disable optimistic mutation path temporarily |
| R-05 | Push notification reliability or routing mismatch | Medium | Route contract tests and fallback in-app inbox | Routing mismatch in smoke run | Fail open to in-app poll and disable deep-link action |
| R-06 | Offline cache serves stale-critical action context | High | Stale banners + action guards while stale | SC-RL-03 fail or stale action incident | Force online-only for action endpoints |
| R-07 | Accessibility regressions in dense cards | High | A11y checks on every feature milestone | SC-AX-01/02 fail | Block release and revert offending UI density changes |
| R-08 | Performance degradation on low-end devices | Medium | Perf budgets and list virtualization tuning | SC-PF-01/02/03 fail | De-scope heavy visuals and animation load |
| R-09 | Sensitive data exposure in local storage/logs | High | Secure storage boundaries + redaction policy | SC-SEC-01/03 fail | Purge sensitive cache fields and rotate session |
| R-10 | Analytics taxonomy drift from web | Medium | Shared catalog and payload validation | SC-AN-01 mismatch | Freeze analytics schema changes and hotfix mappings |
| R-11 | Deep-link misrouting or unsafe route handling | Medium | Strict route parsing + route tests | Misroute in smoke or security test | Disable affected deep-link route and patch |
| R-12 | Final parity sign-off not reached | High | Weekly parity board and blocking gate | SC-RR-03 fail | Hold release and run parity remediation sprint |

## E. Requirement traceability summary

| Requirement source | Coverage in iOS task IDs |
|---|---|
| Design spec: typography/readability/color system | IOS-T002, IOS-T003, IOS-T012, IOS-T029 |
| Design spec: 5-tab screen architecture | IOS-T001, IOS-T011, IOS-T013, IOS-T016, IOS-T021, IOS-T024 |
| Design spec: interaction pattern ("always running") | IOS-T013, IOS-T014, IOS-T015, IOS-T017 |
| Design spec: proposal explainability | IOS-T018, IOS-T019, IOS-T020 |
| Design spec: active timeline explicit wait reasons | IOS-T021, IOS-T022, IOS-T023 |
| Design spec: receipts and verification surface | IOS-T024, IOS-T025 |
| UX one-pager: intent in under 60 seconds | IOS-T011, IOS-T014, IOS-T015, IOS-T007 |
| UX one-pager: clear proposal rationale | IOS-T016, IOS-T019, IOS-T020 |
| UX one-pager: actionable status through settlement | IOS-T021, IOS-T022, IOS-T023, IOS-T026 |
| UX one-pager: fast refinement loop | IOS-T013, IOS-T014, IOS-T015, IOS-T017 |

## F. Phase 0 completion checklist

- [x] Dependency-ordered task matrix complete.
- [x] Each task includes dependencies, risks, checks, DoD, size.
- [x] Verification map complete.
- [x] Risk register complete with rollback triggers/actions.
- [x] Requirement traceability mapped to design + one-pager.
