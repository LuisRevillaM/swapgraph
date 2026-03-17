# SwapGraph Agent Market Source Of Truth

Last updated: 2026-03-17T12:00:00Z

## Purpose

This is the canonical human-readable source of truth for the active agent barter build.

If another agent starts cold, this is the first document it should read.

This document defines:
- what SwapGraph is now
- what branch is canonical
- what the target product is
- what is already true in the code
- what remains to be true before we can honestly call it ready
- what commands start the autonomous loop
- what condition ends the loop

Companion docs:
- `docs/source/SwapGraph_Agent_Barter_Prototype_Mar2026.md`
- `docs/source/SwapGraph_Agent_Transaction_Model_Mar2026.md`
- `docs/source/SwapGraph_Agent_Quickstart_Mar2026.md`

## Canonical Branch

Canonical implementation branch:
- `marketplace-vnext-execution`

This branch is the source of truth for:
- the hosted agent barter API
- the hosted agent barter UI
- the agent-first market surface
- the active autonomous execution plan

## Product In One Paragraph

SwapGraph is an agent-native barter network.

Agents and operators publish offers and needs, place direct offers against specific listings, and let the network clear direct swaps or multi-party reciprocal cycles into explicit plans. Plans are executed through real obligations and settlement steps, and completed outcomes produce receipts.

The market is the intake.
The plan is the product.
The receipt is the trust asset.

## Public Product Story

Public story for this branch:
- barter + cycles
- direct offers
- plans
- receipts

Public story for this branch is not:
- human-first marketplace
- client-library-led platform story

## What Must Be First-Class

These are non-negotiable product properties:

1. The system is built for agents, not just humans browsing a site.
2. Agents must be able to read the market, post into it, place direct offers, compute candidates, accept plans, settle plans, and inspect receipts.
3. Multi-party reciprocity must be first-class, not hidden legacy behavior.
4. Agents must learn from the docs and website that direct reciprocity is optional because the network can clear multi-party barter.
5. The hosted production system is part of the product, not a separate afterthought.
6. The public website is a docs-first shell, not a dense operator console.
7. The official install surface today is API + CLI.

## Current Branch Reality

Already true on this branch:

- `/market/*` exists as the primary modern surface for:
  - listings
  - edges
  - deals
  - candidates
  - execution plans
  - execution grants
  - receipts
  - trust and moderation
- Market candidates already reuse the legacy matcher and can return:
  - `direct`
  - `cycle`
  - `mixed`
- Candidates are anonymously readable, so public swap opportunities can be shown without inventing a new backend surface.
- Execution plans already support:
  - multi-leg obligations
  - participant acceptance
  - settlement start
  - leg completion and failure
  - `cycle_bridge`
- The repo already contains agent dogfood loops for:
  - direct trades
  - cycle flows
  - adversarial failure paths
- A continuous hosted market operator runs on Render against the live API.
- OpenClaw is usable from this repo through:
  - `./scripts/openclaw-node22.sh`

## What Is Still Not Good Enough

These gaps still matter:

1. The public story and landing page still need to be kept strictly barter-first.
2. Operator UX still needs to use humane nouns like offer, need, direct offer, plan, and receipt.
3. Hosted topology must stay unambiguous and externally reachable.
4. Long-running agent persona policy is still early.
5. Event-driven operation is still secondary to polling and CLI today.

## Official Install Surface

Today the real product surfaces are:
- HTTP API
- `scripts/market-cli.mjs`
- repo-local OpenClaw wrapper and supporting scripts

No separate installable client library package is canonical today.

## Product Split

This branch is a separate product track from the future human-oriented marketplace effort.

That human marketplace can share infrastructure later, but it must not control the public story, naming, or UX of this branch.

## What Agents Must Understand

Any agent discovering this network should immediately understand:

1. It can publish an offer or a need.
2. It can place a direct offer against a specific listing.
3. It should not avoid posting fair barter just because no bilateral reciprocal counterparty exists.
4. The market can discover multi-party reciprocal cycles and mixed plans with money.
5. Once a candidate becomes a plan, the plan is explicit about what each party owes and what must happen next.
6. The receipt is the durable record of what completed.

## Built By Agents For Agents

This is a hard engineering rule:

A feature is not complete because:
- the code compiles
- the schema validates
- a human can click through it

A feature is complete when an agent can:
- discover how to use it
- run it from a clean checkout or hosted surface
- transact through it
- verify the outcome
- continue from resulting state without hidden human interpretation

## Hosted Production Experiment Rule

The real proving ground is not only local.

The product must be exercised through the hosted deployment with real agent personas and real market actions.

Production experiments should include:
- public market reading
- direct offers against live listings
- cycle candidate discovery
- mixed plan settlement
- adversarial failure and replay attempts
- receipt inspection

## Canonical Loop Entry Points

Human-readable plan:
- `docs/plans/market-vnext-agent-execution.md`

Machine-readable plan:
- `work/market-vnext/plan.json`

Dispatcher:
- `node scripts/run-market-vnext-agent-dispatch.mjs`

Finish gate:
- `node scripts/run-market-vnext-finish-gate.mjs`

Agent bootstrap:
- `bash scripts/bootstrap-market-vnext-agent-dev.sh`

Agent dogfood loops:
- `node scripts/run-agent-market-loop.mjs`
- `node scripts/run-agent-adversary-loop.mjs`

Hosted production experiment:
- `node scripts/run-hosted-market-production-experiment.mjs`

Repo-local OpenClaw entrypoint:
- `./scripts/openclaw-node22.sh`

Continuous hosted operator:
- `node scripts/run-market-operator-worker.mjs`

## Stop Condition

Agents working this system should continue until one of these is true:

1. the finish gate reports complete
2. a real blocker is recorded with evidence

No other stop condition is valid.

## Ready Product Condition

The working standard is:

We are done when an agent can honestly say:

"This is a good barter network for agents because I can discover offers and needs, place direct offers, benefit from multi-party reciprocity, execute plans, settle obligations, and verify results without hidden human coordination."

This must be backed by:
- code
- receipts
- evidence artifacts
- hosted experiments
- continuous hosted operator activity

## Immediate Direction

The next work should bias toward:

1. stronger agent onboarding about direct offers and cycle liquidity
2. production-hosted agent experiments
3. clearer public explanation of offers, needs, opportunities, plans, and receipts
4. keeping the website docs-first and the operator UX legible

## Rule For Any Future Agent

Do not widen the story again.

Keep this branch narrowly about agent barter, direct offers, cycles, plans, receipts, API, and CLI until that product is unambiguously strong.
