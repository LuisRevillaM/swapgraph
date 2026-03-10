# Market Failure Semantics

## Purpose

This document defines how SwapGraph should represent failure, fallback, substitution, unwind, and terminal outcomes for multi-leg market plans.

The goal is not to make failure disappear. The goal is to make failure explicit, bounded, and explainable enough that principals, executors, verifiers, and operators know what happened and what the system expects next.

## Core Principle

A graph is not safe because it is clever.
A graph is safe because failure semantics are explicit before execution starts.

Every plan must answer:
- what can fail
- when a failure becomes terminal
- what can be retried
- what can be substituted
- what must be unwound
- what evidence is required to justify the chosen outcome

## Plan-Level State Model

The plan-level state machine should be interpreted as:
- `proposed`
- `balanced`
- `pending_participant_acceptance`
- `authorized`
- `ready_for_settlement`
- `settlement_in_progress`
- `partially_complete`
- `verified`
- `completed`
- `failed`
- `cancelled`
- `unwound`

### Proposed
The graph exists as a candidate or early plan draft but has not been accepted.

### Balanced
The system has determined that obligations and consideration can clear under the modeled assumptions.

### Pending participant acceptance
The graph is structurally valid but has not yet been accepted by all required principals.

### Authorized
Required grants, approvals, deposits, or funding preconditions are satisfied.

### Ready for settlement
The plan is accepted and authorized, and execution may begin.

### Settlement in progress
One or more blocking legs have started.

### Partially complete
At least one blocking leg completed, but the plan is not yet fully settled.
This state is critical for understanding unwind or compensation obligations.

### Verified
Execution evidence has been reviewed and the required attestation threshold has been met.
This may coincide with completion in simple plans but should be modeled separately.

### Completed
All blocking obligations required for completion are satisfied and the terminal receipt can be issued.

### Failed
A blocking leg failed and the plan cannot reach completion under the current version.
Failure does not imply unwind already occurred.

### Cancelled
The plan was intentionally terminated before meaningful execution progress.

### Unwound
The plan previously entered execution or partial completion, and the system applied its fallback or reversal policy to reach a bounded terminal state.

## Leg-Level State Model

Legs should support at least these states conceptually:
- `pending`
- `authorized`
- `started`
- `delivered`
- `accepted`
- `failed`
- `compensated`
- `substituted`

The current runtime may implement a smaller subset first, but the semantics should align with this target.

### Pending
No execution has started.

### Authorized
The leg is approved and any required grants or funding preconditions are in place.

### Started
Execution or transfer is underway.

### Delivered
The nominal output or transfer has been produced.
This is not the same as acceptance.

### Accepted
The required principal or verifier accepted the delivered leg.

### Failed
The leg could not fulfill its obligation under the current path.

### Compensated
The original obligation failed, but a compensating outcome was provided under policy.

### Substituted
The leg completed through an allowed substitute deliverable or route.

## Failure Categories

Failure should not be a single bucket.

Required categories:
- `authorization_failure`
- `counterparty_non_response`
- `execution_error`
- `verification_failure`
- `evidence_missing`
- `payment_failure`
- `grant_expired`
- `resource_unavailable`
- `policy_blocked`
- `timeout`
- `counterparty_dispute`

These categories matter because different categories imply different fallback and unwind behavior.

## Fallback Policy

Every plan should declare a fallback policy before execution starts.

Fallback policy should answer:
- which legs are substitutable
- which failures permit retry
- who may approve substitution
- what compensation is required if a blocking leg fails after another leg already completed
- when the plan must unwind rather than retry or substitute

## Unwind Rules

Unwind is not the same as failure.

Unwind is the bounded closure path after failure in a partially complete plan.

Examples:
- reverse a cash leg if the corresponding service leg cannot complete
- issue compensation instead of literal reversal if reversal is impossible
- void an unconsumed execution grant
- record that a blueprint delivery cannot be revoked and therefore requires compensating consideration instead

A plan should specify whether each leg is:
- reversible
- compensable
- substitutable
- irrevocable

That distinction is mandatory for credible settlement behavior.

## Blocking And Non-Blocking Legs

The plan must distinguish:
- blocking legs: required for completion
- non-blocking legs: useful or contractual, but not terminal-state blockers

A non-blocking leg may fail without necessarily forcing the whole plan into `failed`.
A blocking leg failure requires one of:
- substitution
- compensation path
- unwind
- terminal failure

## Partial Completion Semantics

Partial completion is not an implementation detail. It is a first-class state.

Example:
- cash leg completed
- service leg failed

The system must then know:
- whether cash should be reversed
- whether a sponsor or guarantor steps in
- whether compensation is owed instead
- whether the verifier must attest that the unwind completed

Without this, receipts become misleading.

## Retry Rules

Retry should be constrained by policy.

A leg should define:
- whether retry is allowed
- maximum retry count
- whether retry requires counterparty or verifier approval
- whether retry changes deadlines or compensation obligations

Not every failure should go straight to retry. Some failures should go directly to `failed` or `policy_blocked`.

## Substitution Rules

Substitution should be explicit, not improvised.

A substitutable leg should define:
- allowed substitute types
- who may approve substitution
- whether valuation delta is allowed
- whether re-verification is required

Substitution is especially important for service and asset classes where exact original fulfillment may become unavailable.

## Receipts Under Failure

Receipts should not exist only for happy-path completion.

The system should eventually support terminal receipts for:
- completed
- failed
- unwound
- compensated

A failure receipt should say:
- which obligations completed
- which failed
- what unwind or compensation path occurred
- what evidence and attestation supported that result

That keeps the trust surface honest.

## Current Implementation Implications

The current execution-plan runtime already supports:
- per-leg completion
- per-leg failure
- plan-level failure
- terminal completion receipts

Future work should extend this into:
- partial completion state
- unwind policy fields
- substitution and compensation fields
- terminal failure and unwind receipts

The runtime now exposes the first concrete subset of that model:
- plan state may move to `partially_complete` when one blocking leg finishes before others
- plan state may move to `unwound` after partial completion plus blocking failure
- leg state may move to `compensated` for reversed money-like legs
- leg state may move to `substituted` when an alternate deliverable is accepted
- participant-visible receipts may exist for `completed`, `compensated`, or `unwound` terminal outcomes

## Summary

SwapGraph must treat failure as a designed part of settlement, not an afterthought.

A strong graph market needs:
- explicit plan states
- explicit leg states
- explicit failure categories
- explicit fallback and unwind rules
- receipts that can honestly represent non-happy-path outcomes
