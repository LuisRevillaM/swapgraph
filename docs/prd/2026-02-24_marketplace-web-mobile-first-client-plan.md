# SwapGraph Marketplace Mobile-First Web Client Plan

Date: 2026-02-24
Status: Draft v0.1
Track: Responsive mobile-first web app

## Plan intent
Deliver a production-grade mobile-first web client for the Marketplace experience defined in:
- `docs/design/MarketplaceClientDesignSpec.md`
- `docs/brd/MarketplaceClientUXOnePager.md`

This plan inherits all constraints in:
- `docs/prd/2026-02-24_marketplace-client-dual-agent-operating-contract.md`

## Scope (v1 release)
1. Items
2. Intents
3. Inbox
4. Proposal Detail
5. Active
6. Receipts
7. Web push notification channel (plus email fallback policy hook)
8. PWA baseline with offline read continuity

## Non-goals (v1)
1. Desktop-only advanced layout mode
2. Public SEO landing/content pages
3. In-app messaging/chat
4. Dark mode divergence from design direction

## Phase 0 - Task-definition sprint (must complete first)
Objective: produce high-confidence, dependency-ordered task backlog before implementation.

### Required outputs
1. Task matrix using shared schema from operating contract.
2. Requirement traceability table (design spec section -> task IDs).
3. Verification map (task IDs -> test/check IDs).
4. Risk register with mitigation and rollback per high-risk item.

### Seed task inventory for agent refinement

| ID | Epic | Task |
|---|---|---|
| WEB-T001 | Foundation | Bootstrap app shell with 5-tab mobile navigation |
| WEB-T002 | Foundation | Implement token pipeline (design JSON -> CSS variables/theme objects) |
| WEB-T003 | Foundation | Implement typography/readability utility classes and checks |
| WEB-T004 | Foundation | Define shared domain models and API DTO mappers |
| WEB-T005 | Foundation | Build API client with auth headers, retries, idempotency helpers |
| WEB-T006 | Foundation | Build global error and fallback-state handling surfaces |
| WEB-T007 | Foundation | Implement analytics client and event schema guards |
| WEB-T008 | Foundation | Set up state management and cache boundaries |
| WEB-T009 | Foundation | Set up app routing and deep-link support |
| WEB-T010 | Foundation | Set up test harness: unit, component, integration, e2e smoke |
| WEB-T011 | Items | Build mobile-first Items screen and demand banner |
| WEB-T012 | Items | Build item cards with readable metadata and sorting controls |
| WEB-T013 | Intents | Build Intents screen with persistent watching states |
| WEB-T014 | Intents | Build structured intent composer drawer/modal |
| WEB-T015 | Intents | Implement intent create/edit/cancel flows with optimistic UX guards |
| WEB-T016 | Inbox | Build proposal inbox list and ranking presentation |
| WEB-T017 | Inbox | Implement explainability summary and card metadata |
| WEB-T018 | ProposalDetail | Build exchange hero and cycle graph visualization |
| WEB-T019 | ProposalDetail | Build explainability cards and rationale copy slots |
| WEB-T020 | ProposalDetail | Implement accept/decline actions with idempotent feedback |
| WEB-T021 | Active | Build active swap header and progress indicator |
| WEB-T022 | Active | Build timeline list with explicit wait reasons |
| WEB-T023 | Active | Implement state-specific action affordances and disabled logic |
| WEB-T024 | Receipts | Build receipts list and status signaling |
| WEB-T025 | Receipts | Build receipt detail and verification metadata view |
| WEB-T026 | Notifications | Implement web push event handling and in-app routing |
| WEB-T027 | Notifications | Implement notification preferences and quiet-hours controls |
| WEB-T028 | Offline | Implement service worker/IndexedDB read cache and stale banners |
| WEB-T029 | Accessibility | Keyboard navigation, screen-reader labels, touch-target checks |
| WEB-T030 | Performance | LCP/INP/TBT optimization for mobile devices |
| WEB-T031 | Security | Storage hardening, CSRF/session checks, auth boundary tests |
| WEB-T032 | Release | Final parity audit vs iOS and release checklist closure |

## Milestone plan

### WEB-M0 - Planning confidence gate
Objective: close Phase 0 outputs with review sign-off.

Verification:
1. Task matrix completed and dependency-valid.
2. Traceability coverage is 100% for v1 requirements.
3. All high-risk tasks have mitigation and rollback notes.

DoD:
1. Planning sign-off recorded.
2. No unresolved blockers for implementation kickoff.

### WEB-M1 - Foundation and design-system parity
Objective: production-ready shell and tokenized UI primitives.

In-scope tasks:
- WEB-T001 through WEB-T010

Verification:
1. Token parity snapshot against design-spec export.
2. Routing smoke tests for all five tabs.
3. API client integration tests for health/intents/proposals/timeline/receipts reads.

DoD:
1. G1, G3 partially pass for read surfaces.
2. Foundation code is reusable by all feature milestones.

### WEB-M2 - Items and Intents flow
Objective: users can browse inventory, post intents, and monitor watching state.

In-scope tasks:
- WEB-T011 through WEB-T015

Verification:
1. End-to-end flow: Items -> Composer -> Intent created -> Intents watching.
2. Validation tests for structured composer inputs.
3. Error/retry tests for intent submission failures.

DoD:
1. Median time-to-first-intent target instrumentation is live.
2. Explicit state messaging exists for empty/watching/error.

### WEB-M3 - Inbox and Proposal Detail
Objective: users can evaluate and act on proposals with clear rationale.

In-scope tasks:
- WEB-T016 through WEB-T020

Verification:
1. Inbox render tests for ranking and metadata integrity.
2. Proposal detail explains value delta/confidence/constraint fit.
3. Accept/decline idempotency behavior validated under retry.

DoD:
1. Explainability primitives always present on detail screen.
2. Decision actions produce deterministic user feedback.

### WEB-M4 - Active timeline and settlement clarity
Objective: users can track in-flight swaps with explicit next actions and wait reasons.

In-scope tasks:
- WEB-T021 through WEB-T023

Verification:
1. State machine coverage tests for accepted -> executing -> receipt path.
2. Timeout/unwind states show concrete reason and outcome.
3. Timeline timestamps and ordering validated.

DoD:
1. "Every state has next action or wait reason" invariant passes.
2. Timeline parity checklist passes against design spec.

### WEB-M5 - Receipts and proof presentation
Objective: users can inspect completed outcomes with clear verification context.

In-scope tasks:
- WEB-T024 through WEB-T025

Verification:
1. Receipts list/detail render checks with status variants.
2. Metadata completeness checks (date/type/verification/value delta).

DoD:
1. Receipt UX is coherent for success/failure/unwound scenarios.
2. Navigation path from Active -> Receipts is stable.

### WEB-M6 - Notifications and offline resilience
Objective: event-to-action flow works under push and intermittent connectivity.

In-scope tasks:
- WEB-T026 through WEB-T028

Verification:
1. Push routing tests (proposal, active swap, receipt).
2. Offline cache read behavior tests with stale-state signage.
3. Reconnect retry behavior for pending actions.

DoD:
1. Critical notifications route user to correct destination.
2. Offline mode supports read continuity for key surfaces.

### WEB-M7 - Accessibility, performance, and security hardening
Objective: close quality gates for launch readiness.

In-scope tasks:
- WEB-T029 through WEB-T032

Verification:
1. Accessibility audit report (keyboard, screen reader, contrast, touch targets).
2. Performance budget report (mobile LCP/INP/TBT and interaction latency).
3. Security checklist and storage/session checks.
4. Cross-platform UX parity audit with iOS track.

DoD:
1. Shared gates G4, G5, G8, G9 pass.
2. Launch recommendation is approved.

## Required plan artifacts (for confidence review)
1. Task matrix (`web_task_matrix`) -> `docs/prd/2026-02-24_marketplace-web-phase0-task-pack.md`
2. Dependency map (`web_dependency_graph`) -> `docs/prd/2026-02-24_marketplace-web-phase0-task-pack.md`
3. Verification map (`web_verification_map`) -> `docs/prd/2026-02-24_marketplace-web-phase0-task-pack.md`
4. Risk register (`web_risk_register`) -> `docs/prd/2026-02-24_marketplace-web-phase0-task-pack.md`
5. Parity checklist (`ios_web_parity_checklist`) -> `docs/prd/2026-02-24_marketplace-shared-check-catalog-and-parity-checklist.md`

## Exit criteria
1. All milestones WEB-M0 through WEB-M7 closed with explicit evidence.
2. No open P0/P1 defects in critical journeys.
3. Shared operating contract gates pass with no exceptions.
