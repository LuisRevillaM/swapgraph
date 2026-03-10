# Market vNext Agent Execution Plan

Canonical source of truth:
- `docs/source/SwapGraph_Agent_Market_Source_of_Truth_Mar2026.md`

## Purpose

Build SwapGraph into an agent-first clearing and execution system for multi-leg work.

The market is the intake.
The plan is the product.
The receipt is the trust asset.

Agents should continue working this plan until they can honestly support the source-of-truth claim that SwapGraph is a great marketplace for agents, backed by code, receipts, and evidence artifacts.

This plan is written so an autonomous agent can execute it without additional product decisions.

## Core Thesis

SwapGraph is not primarily a listing marketplace. It is a clearing and execution system that turns heterogeneous agent trades into explicit, settleable plans with evidence-backed receipts.

The system must support:
- direct paid work
- direct work plus balancing cash
- multi-party reciprocal cycles
- blueprint acquisition tied to execution and evidence
- scoped execution rights and outcome verification

## Built By Agents For Agents

This project is built by agents for agents.

Agent operability is a release requirement, not a marketing claim.

A feature is not complete because:
- the code compiles
- a schema validates
- a human can click through a UI

A feature is complete when a Codex-style agent can:
- discover how to use it from repo docs and scripts
- install dependencies from a clean checkout
- start the runtime
- execute the intended workflow through API or CLI
- verify the outcome
- write evidence
- continue to the next task without hidden human interpretation

If agents cannot run the system, the system is not agent-ready.

## Autonomous Execution Rule

Read this plan, then use the machine-readable plan manifest and dispatcher to execute tasks from `work/market-vnext/tasks` in dependency order.

Start here:

```bash
node scripts/run-market-vnext-agent-dispatch.mjs
```

Do not stop after partial implementation.
Do not stop after local success.
Do not stop because a subtask looks complete.

Stop only when one of these is true:
1. the final finish gate passes and all completion conditions are satisfied
2. a real blocker is encountered and recorded in the active task file and evidence artifact

## Execution Loop

1. Read this plan.
2. Run the dispatcher:
   - `node scripts/run-market-vnext-agent-dispatch.mjs`
3. If the dispatcher reports `complete: true`, stop.
4. If the dispatcher reports a `next_task`, execute that task.
5. Read only the files needed for that task.
6. Implement the task.
7. Run the task verifiers.
8. If verifiers fail, fix the task and rerun.
9. If the task cannot proceed because of a real blocker:
   - set `status: blocked`
   - write `blocker_note`
   - write the evidence artifact
   - stop
10. If the task verifiers pass:
   - write the evidence artifact
   - commit using the task's exact `commit_message`
   - update the task file with `status: done`, `completed_at`, and `commit`
11. Rerun the dispatcher:
   - `node scripts/run-market-vnext-agent-dispatch.mjs`
12. Continue until the dispatcher reports `complete: true` or a blocker is recorded.

This plan is intended to be self-orchestrating. A supervising human should only need to say:

`Start executing and do not stop until the finish gate passes or a real blocker is recorded.`

## Roles To Simulate During Development And Verification

Every major milestone must be exercised with explicit agent roles.

Required roles:
- `builder_agent`: implements tasks from this plan
- `seller_agent`: publishes capabilities, assets, or blueprints
- `buyer_agent`: posts wants and accepts plans
- `broker_agent`: computes candidates and assembles plans
- `sponsor_agent`: funds balancing money legs when needed
- `verifier_agent`: validates outputs, evidence, and receipts
- `operator_agent`: moderates, inspects, and resolves trust issues
- `adversary_agent`: attempts replay, invalid auth, invalid settlement, and leg-failure scenarios

## Product Model To Build Toward

The public surface is `/market/*`.
Legacy `swap-intents` and cycle machinery remain internal compatibility and computation layers until parity is complete.

The target public product model is:
- `Offer`
- `Need`
- `Match`
- `Plan`
- `Result`

Internal domain objects may remain more granular:
- `MarketListing`
- `MarketBlueprint`
- `MarketCandidate`
- `MarketExecutionPlan`
- `MarketTransferLeg`
- `ExecutionGrant`
- `Receipt`

## Mechanism Priorities

The next major work must favor mechanism design over more surface area.

Priority order:
1. obligation clarity
2. authorization and role separation
3. failure and unwind semantics
4. settlement and evidence semantics
5. typed ontology for matching quality
6. agent operability and end-to-end dogfooding
7. UI and publishing polish

## Economic And Execution Separation

The implementation must explicitly separate:

### Economic graph
Represents:
- principals
- obligations
- consideration
- dependency order
- settlement methods
- fallback and unwind rules

### Execution graph
Represents:
- agents
- humans
- tools
- workflows
- approvals
- verification steps

Receipts bind execution evidence back to economic obligations.

## Principal And Role Separation

The system must model these roles distinctly where applicable:
- `principal`
- `executor`
- `verifier`
- `sponsor`
- `broker`
- `guarantor`

An agent may be an executor without being the economic principal.
An org may be the principal while multiple agents or humans execute on its behalf.

## Credits And Instruments Policy

Do not let native credits dominate v1.

Allowed near-term settlement forms:
- external payment proof
- balancing cash legs
- sponsor-funded balancing legs
- narrow internal balances only where they are closed-loop and operationally necessary

Do not expand tradable credit systems until the obligation and settlement engine is strong.

## Trust Artifact Model

Do not use the word `proof` loosely.

Use three layers:
- `evidence`: logs, artifacts, hashes, timestamps, outputs
- `attestation`: counterparty or verifier states that conditions were met
- `guarantee`: a party financially or contractually backs the outcome

Receipts should reference these layers explicitly.

## Completion Conditions

The plan is complete only when all of these are true:

1. `/market/*` is the primary documented public surface.
2. Agents can install and run the system from a clean checkout using documented commands.
3. The market can represent direct, cycle, and mixed multi-leg commerce without requiring new users to touch `swap-intents`.
4. The system models economic principals separately from executors and can express verifier and sponsor roles where needed.
5. The system exposes candidates as obligation-graph opportunities, not just raw matcher outputs.
6. The system exposes execution plans with explicit obligations, leg dependencies, acceptance state, and settlement mode.
7. Failure, fallback, and unwind states are modeled explicitly enough that an agent can determine what happened next.
8. Blueprints are first-class, but are framed as subordinate to execution and evidence rather than as the product center.
9. The system provides evidence, attestation, and receipt semantics that are narrow and credible.
10. A Codex agent can run end-to-end direct, cycle, mixed, adversarial, and hosted/local smoke flows through API or CLI and produce machine-readable evidence.
11. The finish gate reports `complete: true`.

## Final Finish Gate

The canonical finish gate command is:

```bash
node scripts/run-market-vnext-finish-gate.mjs
```

The finish gate must output JSON with:
- `complete`
- `conditions`
- `unmet`
- `recommended_next_tasks`
- `checked_at`

The finish gate is the terminal stop condition for autonomous execution.
It must validate evidence artifacts and completed task records directly, not only file presence.

## Machine-Readable Entry Point

The plan manifest is:

```text
work/market-vnext/plan.json
```

The canonical dispatcher is:

```bash
node scripts/run-market-vnext-agent-dispatch.mjs
```

The dispatcher must:
- run the finish gate
- determine whether the plan is complete
- determine the next ready task if the plan is not complete
- return machine-readable JSON

An autonomous agent should be able to start by running the dispatcher and then keep rerunning it after each completed task without requiring a human to interpret the plan.

## Clean Checkout Dogfood Contract

A Codex agent must be able to execute this flow from a clean checkout:

```bash
npm ci
AUTHZ_ENFORCE=1 HOST=127.0.0.1 PORT=3005 STATE_BACKEND=json STATE_FILE=/tmp/swapgraph-market-vnext.json npm run start:api
node scripts/run-market-vnext-finish-gate.mjs
```

When the system is complete, additional scenario commands referenced by the gate must also pass.

## Task File Schema

Each task file in `work/market-vnext/tasks` must contain:

```yaml
id: M170-001
title: Define obligation graph and principal role model
status: ready
priority: p0
depends_on: []
summary: >
  Define the canonical economic graph, execution graph, and role model so later API and product work is aligned.
files_expected:
  - docs/design/market-obligation-graph.md
  - docs/spec/schemas/MarketExecutionPlanView.schema.json
acceptance_criteria:
  - Economic graph and execution graph are defined separately.
  - Principal, executor, verifier, sponsor, broker, and guarantor roles are defined.
verification:
  - node scripts/run-market-vnext-finish-gate.mjs
commit_message: "Define market obligation graph model"
evidence_file: docs/evidence/market-vnext/M170-001.json
```

## Task Status Model

Allowed task statuses:
- `todo`
- `ready`
- `in_progress`
- `blocked`
- `done`

## Blocker Protocol

A blocker is real only if it is one of these:
- missing credential or secret needed to continue
- external dependency or service outage
- repo conflict or unexpected state change that makes safe continuation ambiguous
- policy decision that changes architecture materially
- finish gate or verifier cannot run due to an environment constraint that the agent cannot solve locally

When blocked, the task file must be updated with:
- `status: blocked`
- `blocker_note`
- `blocked_at`
- `evidence_file`

## Evidence Artifacts

Each completed or blocked task writes a JSON artifact under:
- `docs/evidence/market-vnext/<task-id>.json`

The artifact must include:
- task id
- status
- files changed
- commands run
- exit codes
- summary
- commit sha if complete
- timestamp

## Milestones

### M170 — Mechanism And Role Model
- obligation graph model
- principal/executor/verifier/sponsor/broker/guarantor roles
- evidence/attestation/guarantee model
- failure/unwind state model

### M171 — Economic Graph / Execution Graph Split
- candidate and plan semantics rewritten around economic obligations
- execution mapping model introduced
- typed deliverable and proof requirements strengthened

### M172 — Market-Native Multi-Leg Clearing
- direct and cycle candidates expressed as obligation graphs
- batch clearing support for multi-party cycles
- candidate scoring weighted toward feasibility and completion probability

### M173 — Settlement And Fallback Hardening
- settlement modes tightened around cash, sponsorship, and narrow balances
- plan fallback/unwind behavior implemented
- adversarial and partial-failure scenarios strengthened

### M174 — Agent Dogfood And Finish Gate
- clean-checkout agent bootstrap
- multi-agent loops
- adversarial loops
- final finish gate and evidence bundle

### M175 — Product Surface Simplification
- external nouns simplified to Offer / Need / Match / Plan / Result
- UI and docs aligned to the new model
- blueprint presentation subordinated to execution and evidence

### M176 — Market-Primary Cutover
- `/market/*` is the documented public default
- legacy routes remain only as compatibility plumbing
- launch readiness report complete

## Immediate Build Order

The first tasks to execute are:
1. M170-001 define obligation graph and role model
2. M170-002 define failure, evidence, attestation, and guarantee semantics
3. M171-001 specify economic graph vs execution graph separation in API/domain terms
4. M174-001 add clean-checkout bootstrap and agent dogfood scripts
5. M174-002 harden the finish gate to check real completion conditions

## Notes For The Executing Agent

- Prefer small coherent commits.
- Reuse the existing market and legacy settlement machinery where possible.
- Do not widen scope just because the architecture can support it.
- Credits are intentionally deprioritized unless a task explicitly requires them.
- The goal is not maximum cleverness. The goal is a system that real agents can operate end to end.
