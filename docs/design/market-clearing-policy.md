# Market Clearing Policy

## Purpose

This document defines how SwapGraph should score candidate opportunities and when it should treat clearing as continuous versus batch-oriented.

The policy goal is not to reward novelty. The goal is to prioritize opportunities that are most likely to clear, execute, verify, and settle without operator confusion.

## Core Rule

Candidate scoring should optimize for feasibility first.

The score should favor:
- completion probability
- trust confidence
- expected surplus

The score should penalize:
- verification burden
- coordination burden
- value spread imbalance

This can be summarized as:

`expected_surplus x completion_probability x trust_confidence`

minus:

`verification_cost + coordination_cost + value_spread_penalty`

## Direct Versus Cycle Clearing

### Continuous clearing

Use continuous clearing for:
- bilateral direct matches
- simple mixed two-party opportunities

Why:
- lower coordination cost
- easier acceptance collection
- lower risk of combinatorial thrash

### Batch-window clearing

Use batch-window clearing for:
- three-or-more participant cycles
- multi-party reciprocal barter
- mixed multi-party obligations where multiple participants must commit before materialization

Why:
- improves candidate density
- makes all-party acceptance easier to reason about
- prevents the system from over-optimizing for the first locally interesting edge

Current policy:
- cycle candidates use a `batch_window`
- default batch window is `60` seconds
- cycle materialization requires all participants to accept

## Feasibility Signals

Candidate scoring should draw from:
- matcher confidence
- trust confidence
- number of participants
- number and type of verification-heavy legs
- presence of cash or access-grant legs
- value spread

The system should not rank a clever cycle above a boring direct trade if the direct trade is substantially more likely to complete.

## Trust Confidence

Trust confidence should consider:
- whether participants have coherent identities
- whether trust or moderation state blocks a candidate
- eventually: historical completion rate, dispute rate, and verifier quality

In the current runtime, trust confidence is still heuristic but it is exposed explicitly in the candidate score breakdown.

## Verification Cost

Verification cost increases for:
- cash legs
- access grants
- blueprint delivery
- service delivery

This keeps the market from over-ranking candidates that look economically valid but are expensive to verify credibly.

## Output Requirements

Each candidate should expose:
- `score`
- `score_breakdown`
- `clearing_policy`
- explanation lines that tell the agent whether the opportunity is continuous or batch-cleared

## Summary

SwapGraph should not behave like a novelty engine.

It should behave like a feasibility-first clearing system:
- direct opportunities clear continuously
- multi-party cycles clear in batch windows
- candidate ranking should reflect expected completion, not only structural cleverness
