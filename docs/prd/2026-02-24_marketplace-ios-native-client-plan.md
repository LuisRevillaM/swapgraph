# SwapGraph Marketplace iOS Native Client Plan

Date: 2026-02-24
Status: Draft v0.1
Track: Swift native iOS (SwiftUI first)

## Plan intent
Deliver a production-grade iOS client for the Marketplace experience defined in:
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
7. Push notifications for proposal and settlement events
8. Offline-capable read cache for key screens

## Non-goals (v1)
1. iPad-specific split layouts
2. App Clips
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
| IOS-T001 | Foundation | Bootstrap app shell with 5-tab navigation and feature flags |
| IOS-T002 | Foundation | Integrate token JSON and map to SwiftUI theme primitives |
| IOS-T003 | Foundation | Implement shared typography styles with readability floor checks |
| IOS-T004 | Foundation | Define domain models for intents/proposals/timeline/receipts |
| IOS-T005 | Foundation | Implement API client with auth headers, retries, idempotency helpers |
| IOS-T006 | Foundation | Add structured error model and fallback UI states |
| IOS-T007 | Foundation | Add analytics event client with schema validation hooks |
| IOS-T008 | Foundation | Add secure local persistence layer for cache/session state |
| IOS-T009 | Foundation | Add deep-link routing skeleton (proposal, active swap, receipt) |
| IOS-T010 | Foundation | Set up test harness: unit, snapshot, integration, UI smoke |
| IOS-T011 | Items | Build Items list/grid and demand indicators |
| IOS-T012 | Items | Build item card metadata layout (price, wear, float, demand) |
| IOS-T013 | Intents | Implement intent list with persistent "watching" state |
| IOS-T014 | Intents | Build structured intent composer sheet |
| IOS-T015 | Intents | Add intent create/edit/cancel flows with optimistic UX guards |
| IOS-T016 | Inbox | Implement proposal inbox list with explainability summary |
| IOS-T017 | Inbox | Build proposal ranking and sectioning presentation |
| IOS-T018 | ProposalDetail | Build exchange hero and participant cycle visual |
| IOS-T019 | ProposalDetail | Build explainability cards and rationale copy slots |
| IOS-T020 | ProposalDetail | Implement accept/decline actions with idempotent feedback |
| IOS-T021 | Active | Implement active swap header and progress bar |
| IOS-T022 | Active | Implement timeline event list with explicit wait reasons |
| IOS-T023 | Active | Add state-specific action affordances and disabled logic |
| IOS-T024 | Receipts | Build receipts list with status and metadata |
| IOS-T025 | Receipts | Build receipt detail and verification metadata view |
| IOS-T026 | Notifications | Add push notification intake and routing actions |
| IOS-T027 | Notifications | Add in-app notification preferences surface |
| IOS-T028 | Offline | Implement cache hydration and stale-state banners |
| IOS-T029 | Accessibility | VoiceOver labels, dynamic type behavior, focus order checks |
| IOS-T030 | Performance | Cold start, tab-switch, and list-scroll budget optimization |
| IOS-T031 | Security | Local storage hardening and auth/session threat checks |
| IOS-T032 | Release | Final parity audit vs web and release checklist closure |

## Milestone plan

### IOS-M0 - Planning confidence gate
Objective: close Phase 0 outputs with review sign-off.

Verification:
1. Task matrix completed and dependency-valid.
2. Traceability coverage is 100% for v1 requirements.
3. All high-risk tasks have mitigation and rollback notes.

DoD:
1. Planning sign-off recorded.
2. No unresolved blockers for implementation kickoff.

### IOS-M1 - Foundation and design-system parity
Objective: production-ready shell and tokenized UI primitives.

In-scope tasks:
- IOS-T001 through IOS-T010

Verification:
1. Token parity snapshot against design-spec export.
2. Navigation smoke tests for all five tabs.
3. API client integration tests for health/intents/proposals/timeline/receipts reads.

DoD:
1. G1, G3 partially pass for read surfaces.
2. Foundation code is reusable by all feature milestones.

### IOS-M2 - Items and Intents flow
Objective: users can browse inventory, post intents, and monitor watching state.

In-scope tasks:
- IOS-T011 through IOS-T015

Verification:
1. End-to-end flow: Items -> Composer -> Intent created -> Intents watching.
2. Validation tests for structured composer inputs.
3. Error/retry tests for intent submission failures.

DoD:
1. Median time-to-first-intent target instrumentation is live.
2. Explicit state messaging exists for empty/watching/error.

### IOS-M3 - Inbox and Proposal Detail
Objective: users can evaluate and act on proposals with clear rationale.

In-scope tasks:
- IOS-T016 through IOS-T020

Verification:
1. Inbox render tests for ranking and metadata integrity.
2. Proposal detail explains value delta/confidence/constraint fit.
3. Accept/decline idempotency behavior validated under retry.

DoD:
1. Explainability primitives always present on detail screen.
2. Decision actions produce deterministic user feedback.

### IOS-M4 - Active timeline and settlement clarity
Objective: users can track in-flight swaps with explicit next actions and wait reasons.

In-scope tasks:
- IOS-T021 through IOS-T023

Verification:
1. State machine coverage tests for accepted -> executing -> receipt path.
2. Timeout/unwind states show concrete reason and outcome.
3. Timeline timestamps and ordering validated.

DoD:
1. "Every state has next action or wait reason" invariant passes.
2. Timeline parity checklist passes against design spec.

### IOS-M5 - Receipts and proof presentation
Objective: users can inspect completed outcomes with clear verification context.

In-scope tasks:
- IOS-T024 through IOS-T025

Verification:
1. Receipts list/detail render checks with status variants.
2. Metadata completeness checks (date/type/verification/value delta).

DoD:
1. Receipt UX is coherent for success/failure/unwound scenarios.
2. Navigation path from Active -> Receipts is stable.

### IOS-M6 - Notifications and offline resilience
Objective: event-to-action flow works under push and intermittent connectivity.

In-scope tasks:
- IOS-T026 through IOS-T028

Verification:
1. Push notification routing tests (proposal, active swap, receipt).
2. Offline cache read behavior tests with stale-state signage.
3. Reconnect retry behavior for pending actions.

DoD:
1. Critical notifications route user to correct destination.
2. Offline mode supports read continuity for key surfaces.

### IOS-M7 - Accessibility, performance, and security hardening
Objective: close quality gates for launch readiness.

In-scope tasks:
- IOS-T029 through IOS-T032

Verification:
1. Accessibility audit report (VoiceOver + contrast + touch targets).
2. Performance budget report (cold start, list scroll, action latency).
3. Security checklist and storage/session checks.
4. Cross-platform UX parity audit with web track.

DoD:
1. Shared gates G4, G5, G8, G9 pass.
2. Launch recommendation is approved.

## Required plan artifacts (for confidence review)
1. Task matrix (`ios_task_matrix`) -> `docs/prd/2026-02-24_marketplace-ios-phase0-task-pack.md`
2. Dependency map (`ios_dependency_graph`) -> `docs/prd/2026-02-24_marketplace-ios-phase0-task-pack.md`
3. Verification map (`ios_verification_map`) -> `docs/prd/2026-02-24_marketplace-ios-phase0-task-pack.md`
4. Risk register (`ios_risk_register`) -> `docs/prd/2026-02-24_marketplace-ios-phase0-task-pack.md`
5. Parity checklist (`ios_web_parity_checklist`) -> `docs/prd/2026-02-24_marketplace-shared-check-catalog-and-parity-checklist.md`

## Exit criteria
1. All milestones IOS-M0 through IOS-M7 closed with explicit evidence.
2. No open P0/P1 defects in critical journeys.
3. Shared operating contract gates pass with no exceptions.
