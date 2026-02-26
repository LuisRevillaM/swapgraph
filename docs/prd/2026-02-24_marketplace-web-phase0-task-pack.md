# Marketplace Web Phase 0 Task Pack

Date: 2026-02-24
Status: Draft v0.1 (execution-ready planning artifact)
Track: Mobile-first web
References:
- `docs/prd/2026-02-24_marketplace-web-mobile-first-client-plan.md`
- `docs/prd/2026-02-24_marketplace-client-dual-agent-operating-contract.md`
- `docs/prd/2026-02-24_marketplace-shared-check-catalog-and-parity-checklist.md`

## A. Dependency-ordered task matrix (schema-complete)

| Order | Task ID | Epic | User-visible outcome | Implementation notes | Dependencies | Risks | Verification mapping | Definition of done | Size |
|---|---|---|---|---|---|---|---|---|---|
| 1 | WEB-T001 | Foundation | User can navigate 5-tab mobile shell | Build app shell and tab nav with route stubs | none | R-01,R-03 | SC-G0-01,SC-UX-03 | All 5 tabs accessible with deterministic mobile routing | M |
| 2 | WEB-T004 | Foundation | Data renders consistently across screens | Define domain models + API DTO mappers | WEB-T001 | R-02,R-03 | SC-API-01,SC-G0-01 | Shared model layer used by all route modules | M |
| 3 | WEB-T005 | Foundation | App can read/write platform APIs reliably | Implement fetch client, auth headers, idempotency/retry | WEB-T004 | R-02,R-04,R-09 | SC-API-01,SC-API-02,SC-API-03 | Core read/write API flows pass integration harness | L |
| 4 | WEB-T002 | Foundation | Visual system matches design tokens | Build token pipeline JSON -> CSS vars/theme objects | WEB-T001 | R-01 | SC-DS-01 | Token diff report shows no blocking drift | M |
| 5 | WEB-T003 | Foundation | Informational text remains readable | Implement typography/readability utilities with floor checks | WEB-T002 | R-07 | SC-DS-02,SC-AX-01 | Type/contrast baseline passes shared check | M |
| 6 | WEB-T006 | Foundation | Users see clear failures and recovery options | Add global error and fallback-state surfaces | WEB-T005 | R-03,R-04 | SC-API-04,SC-RL-02 | Standardized error states used across routes | M |
| 7 | WEB-T007 | Foundation | Product funnel is measurable end-to-end | Add analytics client with event schema guards | WEB-T005 | R-10 | SC-AN-01,SC-AN-03 | Invalid events blocked; valid events emitted deterministically | M |
| 8 | WEB-T008 | Foundation | State remains coherent during route/action churn | Define state boundaries and cache ownership rules | WEB-T004 | R-03,R-06 | SC-G0-02,SC-RL-01 | Store boundaries documented and enforced in modules | M |
| 9 | WEB-T009 | Foundation | URL/deep-link entry opens correct destination | Implement route and deep-link handling for core entities | WEB-T001 | R-11 | SC-UX-02,SC-UX-03 | URLs resolve consistently with entity context | M |
| 10 | WEB-T010 | Foundation | Regressions are detectable before merge | Configure unit/component/integration/e2e smoke harness | WEB-T001,WEB-T004,WEB-T005 | R-12 | SC-G0-01,SC-G0-02 | CI test scaffolding exists and runs baseline suite | M |
| 11 | WEB-T011 | Items | User sees inventory with demand signals | Build mobile-first Items screen and demand banner | WEB-T002,WEB-T003,WEB-T004,WEB-T005 | R-03,R-08 | SC-UX-01,SC-PF-03 | Items render correctly with empty/loading/error states | M |
| 12 | WEB-T012 | Items | Item cards are legible and scannable | Build card metadata layout and sorting controls | WEB-T011 | R-07,R-08 | SC-DS-02,SC-AX-01 | Cards pass readability and tap-target checks | S |
| 13 | WEB-T013 | Intents | User sees standing intents and watch state | Build Intents screen with persistent watching state | WEB-T002,WEB-T003,WEB-T004,WEB-T005 | R-03 | SC-UX-01,SC-API-01 | Watching/no-match/matched states are explicit | M |
| 14 | WEB-T014 | Intents | User can create intent through structured flow | Build composer drawer/modal with field validation | WEB-T013 | R-03,R-07 | SC-UX-01,SC-DS-02 | Composer blocks malformed intents and explains why | M |
| 15 | WEB-T015 | Intents | User can create/edit/cancel intents confidently | Add mutations with optimistic updates and fallback guards | WEB-T014,WEB-T005,WEB-T006 | R-04,R-06 | SC-API-03,SC-RL-02 | Mutation retries are idempotent and user-safe | L |
| 16 | WEB-T016 | Inbox | User can browse ranked proposal inbox | Build proposal inbox list and summary cards | WEB-T002,WEB-T003,WEB-T004,WEB-T005 | R-03,R-08 | SC-UX-02,SC-PF-03 | Inbox renders ranked proposals with stable metadata | M |
| 17 | WEB-T017 | Inbox | User understands ranking and urgency quickly | Add ranking, sections, urgency/expiry cues | WEB-T016 | R-03 | SC-UX-02,SC-AN-02 | Ranking visuals match sort semantics and urgency policy | S |
| 18 | WEB-T018 | ProposalDetail | User sees give/get and cycle context clearly | Build detail hero and cycle graph visualization | WEB-T016,WEB-T004 | R-03,R-08 | SC-UX-02,SC-PF-02 | Proposal detail fully renders cycle and participant context | M |
| 19 | WEB-T019 | ProposalDetail | User can understand why proposal exists | Add explainability cards (value delta/confidence/constraint fit) | WEB-T018 | R-03,R-10 | SC-UX-02,SC-AN-01 | All three explanation primitives always present | S |
| 20 | WEB-T020 | ProposalDetail | User can accept/decline safely with reliable feedback | Implement decision actions with idempotent handling | WEB-T018,WEB-T005,WEB-T006 | R-04,R-06 | SC-API-03,SC-UX-02 | Duplicate actions do not diverge server/client outcomes | M |
| 21 | WEB-T021 | Active | User can understand settlement progress at a glance | Build active header + progress indicator | WEB-T004,WEB-T005 | R-03 | SC-UX-03 | Header/progress align to canonical settlement state | M |
| 22 | WEB-T022 | Active | User always sees explicit wait reason/next step | Build timeline with wait reason language | WEB-T021 | R-03,R-07 | SC-UX-03,SC-AX-02 | No active state lacks clear action/wait reason | M |
| 23 | WEB-T023 | Active | User can take valid next actions only | Add state-aware action affordances and disabled states | WEB-T022,WEB-T020 | R-03,R-04 | SC-UX-03,SC-API-04 | Invalid actions are blocked with explicit reason UI | M |
| 24 | WEB-T024 | Receipts | User can review completed outcomes | Build receipts list with status and metadata | WEB-T004,WEB-T005 | R-03 | SC-UX-04,SC-API-01 | Receipts list aligns with API projection semantics | M |
| 25 | WEB-T025 | Receipts | User can inspect proof metadata in detail | Build receipt detail verification metadata view | WEB-T024 | R-03,R-07 | SC-UX-04,SC-AX-01 | Receipt detail exposes verification and value outcome context | S |
| 26 | WEB-T026 | Notifications | User receives actionable proposal/settlement alerts | Implement web push handling and in-app route mapping | WEB-T009,WEB-T005 | R-05,R-11 | SC-UX-02,SC-UX-03 | Push click lands on correct entity/route | L |
| 27 | WEB-T027 | Notifications | User controls notification noise | Add notification preferences and quiet-hours controls | WEB-T026,WEB-T013 | R-05,R-10 | SC-AN-01,SC-RL-03 | Preferences persist and alter delivery/routing behavior | M |
| 28 | WEB-T028 | Offline | User can read core screens when offline | Add service worker/IndexedDB cache + stale banners | WEB-T008,WEB-T011,WEB-T013,WEB-T016,WEB-T021,WEB-T024 | R-06,R-09,R-13 | SC-RL-01,SC-RL-03 | Core tabs remain readable offline with stale disclosure | L |
| 29 | WEB-T029 | Accessibility | Assistive-tech users can complete critical flows | Keyboard nav, labels, focus order, touch-target checks | WEB-T011,WEB-T013,WEB-T016,WEB-T018,WEB-T021,WEB-T024 | R-07 | SC-AX-01,SC-AX-02,SC-AX-03 | Critical journeys pass accessibility baseline | M |
| 30 | WEB-T030 | Performance | Mobile experience remains responsive | Optimize LCP/INP/TBT and list interaction latency | WEB-T011,WEB-T013,WEB-T016,WEB-T018,WEB-T021 | R-08,R-14 | SC-PF-01,SC-PF-02,SC-PF-03 | Perf budgets pass on target device/network profiles | M |
| 31 | WEB-T031 | Security | Session and local data handling are hardened | Enforce storage hardening, CSRF/session checks, redaction | WEB-T005,WEB-T028,WEB-T026 | R-09,R-13 | SC-SEC-01,SC-SEC-02,SC-SEC-03 | Security checklist passes with no high-severity findings | M |
| 32 | WEB-T032 | Release | Team has launch confidence with rollback | Final parity audit and release readiness closeout | WEB-T029,WEB-T030,WEB-T031,WEB-T027,WEB-T028 | R-12 | SC-RR-01,SC-RR-02,SC-RR-03 | Release checklist signed and rollback drill verified | M |

## B. Dependency graph (adjacency list)

- WEB-T001 -> WEB-T004, WEB-T002, WEB-T009, WEB-T010
- WEB-T004 -> WEB-T005, WEB-T008, WEB-T011, WEB-T013, WEB-T016, WEB-T021, WEB-T024
- WEB-T005 -> WEB-T006, WEB-T007, WEB-T010, WEB-T015, WEB-T020, WEB-T026, WEB-T031
- WEB-T002 -> WEB-T003, WEB-T011, WEB-T013, WEB-T016
- WEB-T003 -> WEB-T011, WEB-T013, WEB-T016
- WEB-T006 -> WEB-T015, WEB-T020
- WEB-T008 -> WEB-T028
- WEB-T009 -> WEB-T026
- WEB-T010 -> (test harness dependency only)
- WEB-T011 -> WEB-T012, WEB-T028, WEB-T029, WEB-T030
- WEB-T013 -> WEB-T014, WEB-T027, WEB-T028, WEB-T029, WEB-T030
- WEB-T014 -> WEB-T015
- WEB-T016 -> WEB-T017, WEB-T018, WEB-T028, WEB-T029, WEB-T030
- WEB-T018 -> WEB-T019, WEB-T020, WEB-T029, WEB-T030
- WEB-T020 -> WEB-T023
- WEB-T021 -> WEB-T022, WEB-T028, WEB-T029, WEB-T030
- WEB-T022 -> WEB-T023
- WEB-T024 -> WEB-T025, WEB-T028, WEB-T029
- WEB-T026 -> WEB-T027, WEB-T031
- WEB-T027 -> WEB-T032
- WEB-T028 -> WEB-T031, WEB-T032
- WEB-T029 -> WEB-T032
- WEB-T030 -> WEB-T032
- WEB-T031 -> WEB-T032

## C. Verification map (check ID -> tasks)

| Check ID | Tasks mapped |
|---|---|
| SC-G0-01 | WEB-T001..WEB-T032 (schema completeness), WEB-T010 |
| SC-G0-02 | WEB-T001..WEB-T032 dependency DAG |
| SC-DS-01 | WEB-T002 |
| SC-DS-02 | WEB-T003, WEB-T012, WEB-T014 |
| SC-UX-01 | WEB-T011, WEB-T013, WEB-T014, WEB-T015 |
| SC-UX-02 | WEB-T016, WEB-T017, WEB-T018, WEB-T019, WEB-T020, WEB-T026 |
| SC-UX-03 | WEB-T021, WEB-T022, WEB-T023, WEB-T026 |
| SC-UX-04 | WEB-T024, WEB-T025 |
| SC-API-01 | WEB-T004, WEB-T005, WEB-T013, WEB-T024 |
| SC-API-02 | WEB-T005 |
| SC-API-03 | WEB-T005, WEB-T015, WEB-T020 |
| SC-API-04 | WEB-T006, WEB-T023 |
| SC-AN-01 | WEB-T007, WEB-T019, WEB-T027 |
| SC-AN-02 | WEB-T017 |
| SC-AN-03 | WEB-T007 |
| SC-RL-01 | WEB-T008, WEB-T028 |
| SC-RL-02 | WEB-T006, WEB-T015 |
| SC-RL-03 | WEB-T027, WEB-T028 |
| SC-AX-01 | WEB-T003, WEB-T012, WEB-T025, WEB-T029 |
| SC-AX-02 | WEB-T022, WEB-T029 |
| SC-AX-03 | WEB-T029 |
| SC-PF-01 | WEB-T030 |
| SC-PF-02 | WEB-T018, WEB-T030 |
| SC-PF-03 | WEB-T011, WEB-T016, WEB-T030 |
| SC-SEC-01 | WEB-T028, WEB-T031 |
| SC-SEC-02 | WEB-T005, WEB-T031 |
| SC-SEC-03 | WEB-T031 |
| SC-RR-01 | WEB-T032 |
| SC-RR-02 | WEB-T032 |
| SC-RR-03 | WEB-T032 |

## D. Risk register

| Risk ID | Description | Impact | Mitigation | Rollback trigger | Rollback action |
|---|---|---|---|---|---|
| R-01 | Token drift from design spec | High | Lock token export and parity diff in CI | SC-DS-01 fails twice in row | Freeze styling changes and re-sync token pipeline |
| R-02 | API schema drift vs client mappings | High | Contract tests on each merge | SC-API-01 regression in critical route | Pin to last known contract and gate deploy |
| R-03 | State-machine semantics diverge from UX spec | High | Shared state glossary and parity reviews | SC-UX-03 or PC-06 fail | Revert state renderer and re-validate |
| R-04 | Idempotency race on accept/decline or intent mutations | High | Enforce idempotency keys and replay tests | SC-API-03 failure | Disable optimistic mutation path temporarily |
| R-05 | Web push deliverability/permission degradation | Medium | Permission fallback + in-app inbox and email hook | Push acceptance drops below target | Shift critical alerts to in-app/email fallback mode |
| R-06 | Offline cache serves stale-critical action context | High | Stale banners + action guards while stale | SC-RL-03 fail or stale action incident | Force online-only for action endpoints |
| R-07 | Accessibility regressions in dense cards | High | A11y checks on each feature milestone | SC-AX-01/02 fail | Block release and revert dense UI changes |
| R-08 | Performance degradation on constrained devices | High | Perf budgets + code splitting + list tuning | SC-PF checks fail | De-scope heavy visuals and optional animations |
| R-09 | Sensitive data exposure in storage/logs | High | Storage minimization + redaction + session checks | SC-SEC-01/03 fail | Purge unsafe cache fields and rotate sessions |
| R-10 | Analytics taxonomy drift from iOS | Medium | Shared catalog + payload schema guard | SC-AN-01 mismatch | Freeze analytics changes and hotfix mappings |
| R-11 | Deep-link or route parser misrouting | Medium | Strict route parsing and route tests | Misroute in smoke or security test | Disable affected route pattern and patch |
| R-12 | Final parity sign-off not reached | High | Weekly parity board and blocking gate | SC-RR-03 fail | Hold release and run parity remediation sprint |
| R-13 | Service worker cache poisoning/mis-versioning | High | Cache versioning, integrity checks, scoped caches | Offline inconsistencies/security alert | Disable SW and force network mode until fixed |
| R-14 | INP regressions from main-thread overload | Medium | Interaction profiling and lazy hydration | SC-PF-02 fail on target profile | Ship simplified interaction path and defer heavy work |

## E. Requirement traceability summary

| Requirement source | Coverage in web task IDs |
|---|---|
| Design spec: typography/readability/color system | WEB-T002, WEB-T003, WEB-T012, WEB-T029 |
| Design spec: 5-tab screen architecture | WEB-T001, WEB-T011, WEB-T013, WEB-T016, WEB-T021, WEB-T024 |
| Design spec: interaction pattern ("always running") | WEB-T013, WEB-T014, WEB-T015, WEB-T017 |
| Design spec: proposal explainability | WEB-T018, WEB-T019, WEB-T020 |
| Design spec: active timeline explicit wait reasons | WEB-T021, WEB-T022, WEB-T023 |
| Design spec: receipts and verification surface | WEB-T024, WEB-T025 |
| UX one-pager: intent in under 60 seconds | WEB-T011, WEB-T014, WEB-T015, WEB-T007 |
| UX one-pager: clear proposal rationale | WEB-T016, WEB-T019, WEB-T020 |
| UX one-pager: actionable status through settlement | WEB-T021, WEB-T022, WEB-T023, WEB-T026 |
| UX one-pager: fast refinement loop | WEB-T013, WEB-T014, WEB-T015, WEB-T017 |

## F. Phase 0 completion checklist

- [x] Dependency-ordered task matrix complete.
- [x] Each task includes dependencies, risks, checks, DoD, size.
- [x] Verification map complete.
- [x] Risk register complete with rollback triggers/actions.
- [x] Requirement traceability mapped to design + one-pager.
