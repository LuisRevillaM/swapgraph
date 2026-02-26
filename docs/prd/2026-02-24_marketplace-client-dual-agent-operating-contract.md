# SwapGraph Marketplace Clients - Dual-Agent Operating Contract

Date: 2026-02-24
Status: Draft v0.1
Mode: Planning-only (no implementation in this artifact)

## Purpose
Define one shared operating contract for two parallel planning agents:
1. Swift native iOS client agent
2. Mobile-first web client agent

Both plans must use the same constraints, quality bars, verification model, and definition-of-done gates.

## Source inputs
- Design spec: `docs/design/MarketplaceClientDesignSpec.md`
- UX one-pager: `docs/brd/MarketplaceClientUXOnePager.md`
- Repo planning/verifier pattern: `PLAN.md`, `milestones/*.yaml`, `verify/*.sh`, `verify/runner.mjs`
- Existing API/schemas: `docs/spec/API.md`, `docs/spec/schemas/*`

## Shared hard constraints (non-negotiable)
1. Same UX contract across both clients.
2. Same design tokens and readability floor (`11.3px` equivalent minimum informational text).
3. Same API semantics and state machine semantics.
4. Same explainability primitives on proposals: value delta, confidence, constraint fit.
5. Same analytics taxonomy and funnel definitions.
6. Same reliability behavior: idempotent retries, explicit wait reasons, clear fallback states.
7. Same accessibility targets (WCAG AA baseline).
8. Same security/privacy posture for auth, local storage, and notification safety.

## Shared UX invariants
1. Intent creation is structured and fast (target: median under 60 seconds).
2. System is always matching; user does not manually run the matcher in product UX.
3. Every state has either a next action or a concrete wait reason.
4. Proposal detail must always explain why this proposal exists.
5. Timeline must always make settlement status and risk explicit.

## Shared architecture constraints
1. Thin client posture over existing platform APIs; no client-side business-rule forks.
2. Shared domain model names for: intent, proposal, participant, commit state, settlement state, receipt.
3. Single token source of truth from design spec export; platform adapters only transform format.
4. Event and metrics schema shared across clients; platform-specific fields allowed only under namespaced keys.

## Shared quality gates
Use these gates in both iOS and web milestone plans.

| Gate | What must be true | Evidence type |
|---|---|---|
| G0 | Task backlog is complete, dependency-ordered, and test-mapped | task matrix + dependency graph |
| G1 | Design-token parity with design spec | token parity report |
| G2 | UX parity on critical journeys | side-by-side parity checklist |
| G3 | API contract conformance | contract tests against runtime API |
| G4 | Accessibility baseline passes | a11y report + manual checklist |
| G5 | Performance budget passes | perf traces and threshold report |
| G6 | Analytics contract complete and validated | event catalog + sample payload validation |
| G7 | Offline/error/retry behavior validated | resilience test evidence |
| G8 | Security/privacy checks pass | threat checklist + secure storage proof |
| G9 | Release readiness and rollback plan approved | release checklist + rollback drill |

## Shared milestone template
Every milestone in both plans must include:
1. Objective
2. Scope
3. Non-goals
4. Task definitions (ID, owner role, dependency, acceptance criteria)
5. Verification steps (automated + manual)
6. Required artifacts
7. Definition of done (binary, testable)

## Shared task-definition schema (Phase 0 output)
Each agent must first produce tasks in this shape:

| Field | Required |
|---|---|
| Task ID | yes |
| Epic | yes |
| User-visible outcome | yes |
| Implementation notes | yes |
| Dependencies | yes |
| Risks | yes |
| Verification mapping (test/checklist IDs) | yes |
| Definition of done statement | yes |
| Estimated size (S/M/L) | yes |

## Shared confidence protocol (must pass before autopilot execution)
1. Traceability: every requirement from design + UX one-pager maps to at least one task.
2. Verification completeness: every task has explicit validation method.
3. Risk coverage: each high-risk item has mitigation and rollback.
4. Dependency integrity: no orphan critical path tasks.
5. Readability check: plans are explicit enough that another agent can execute without ambiguity.

## Agent kickoff prompts (copy/paste)
Use these prompts to start each planning agent.

### Prompt A (iOS)
"Produce a comprehensive Swift native iOS implementation plan for SwapGraph Marketplace using `docs/prd/2026-02-24_marketplace-ios-native-client-plan.md` structure and the dual-agent operating contract at `docs/prd/2026-02-24_marketplace-client-dual-agent-operating-contract.md`. Start with complete task definitions (ID/deps/DoD/verification mapping), then milestone sequencing. Do not change shared constraints."

### Prompt B (Web)
"Produce a comprehensive mobile-first web implementation plan for SwapGraph Marketplace using `docs/prd/2026-02-24_marketplace-web-mobile-first-client-plan.md` structure and the dual-agent operating contract at `docs/prd/2026-02-24_marketplace-client-dual-agent-operating-contract.md`. Start with complete task definitions (ID/deps/DoD/verification mapping), then milestone sequencing. Do not change shared constraints."
