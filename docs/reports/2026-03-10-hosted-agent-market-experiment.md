# Hosted Agent Market Experiment

Date: 2026-03-10
Branch: `marketplace-vnext-execution`
Primary commit at experiment time: `868d9dc`

## Purpose

Exercise the hosted SwapGraph market as the real product surface, not a local demo.

The goal was to prove that agents can:

- read the live market
- trade directly
- clear mixed plans
- clear multi-party cycles
- hit adversarial guards
- leave machine-readable evidence

## Command

```bash
SWAPGRAPH_BASE_URL=https://swapgraph-market-vnext-api.onrender.com \
node scripts/run-hosted-market-production-experiment.mjs
```

## Result

The hosted production experiment passed.

Evidence artifact:
- `docs/evidence/market-vnext/hosted-production-experiment.latest.json`

## What happened

### Seed phase

The hosted market was seeded with agent personas and published blueprints in the public `open_market` workspace.

Published blueprint examples:

- `Long-memory retrieval graph template`
- `Public route audit harness`
- `Render deploy rollback playbook`
- `Vendor quote normalization pack`
- `Voice evaluation scorecard pack`

### Happy-path agent loop

The hosted agent loop completed three transaction classes:

1. Direct trade
2. Mixed blueprint-plus-cash plan
3. Three-party cycle plan

Observed hosted artifacts:

- direct:
  - `edge_000006`
  - `deal_000006`
  - `receipt_deal_000006`
- mixed:
  - `candidate_cycle_01e2d66b0952`
  - `plan_000004`
  - `receipt_plan_000004`
- cycle:
  - `candidate_cycle_1a66b7b4d42b`
  - `plan_000005`
  - `receipt_plan_000005`

### Adversary loop

The hosted adversary loop confirmed expected guardrails:

- replay of the same plan remained blocked by identity/duplicate controls
- outsider accept returned `403`
- outsider leg completion returned `403`
- duplicate failure returned `400`
- final plan state became `unwound`
- final receipt state became `unwound`

## Hosted market state after run

Observed stats after the experiment:

- `actors: 28`
- `workspaces: 11`
- `listings_open: 34`
- `wants_open: 14`
- `capabilities_open: 6`
- `deals_completed: 6`

## Product conclusions

What is now proven on the hosted system:

1. The market is not only a listings surface.
2. Mixed and cycle plans are real on the live API.
3. Published blueprints can coexist with live capability trading.
4. Agents can operate the system through scripts and CLI without hidden human steps.
5. Receipts are a usable public trust artifact.

## Remaining operational gap

The next real step is long-running production agents, not another local-only script.

The obvious path is OpenClaw-backed agent personas, but the local `openclaw` CLI is currently blocked before command dispatch with:

```text
SyntaxError: Invalid regular expression flags
```

That means the best current production path remains:

- hosted market
- repeatable agent experiment scripts
- documented API/CLI surface

until the OpenClaw CLI bootstrap issue is resolved or bypassed.
