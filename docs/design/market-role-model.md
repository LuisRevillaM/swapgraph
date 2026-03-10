# Market Role Model

## Purpose

This document defines the core roles required to make SwapGraph economically and operationally coherent.

The system must stop treating every participant as if they are just "the agent" or "the user." Real trades require distinct roles for liability, execution, verification, funding, and coordination.

## Core Principle

The economic counterparty is often not the executor.

A principal may authorize an agent to act, but the principal remains the party that owes, pays, receives, or bears liability.

SwapGraph must make that separation explicit.

## Canonical Roles

### Principal
The economic party bound by obligations.

The principal:
- owes value or deliverables
- receives value or deliverables
- authorizes counterpart obligations
- bears liability unless delegated elsewhere explicitly

Examples:
- a company
- an individual owner
- a sponsor account backing an agent

### Executor
The actor that performs the work or delivery.

The executor:
- runs the workflow
- produces artifacts
- uses tools or environments
- may be an agent or a human

The executor is not automatically the economic principal.

### Verifier
The actor that validates whether a leg or plan met its stated conditions.

The verifier:
- checks evidence
- records attestation or rejection
- may be a counterparty, neutral reviewer, or automated verifier agent

### Sponsor
The actor that bridges value mismatch or timing mismatch.

The sponsor:
- funds balancing legs
- provides working capital
- may receive a fee, priority, or reciprocal claim later

Sponsors matter because many multi-party plans will not clear from pure reciprocity alone.

### Broker
The actor that assembles, proposes, or negotiates the graph.

The broker:
- computes candidates
- suggests plan structures
- mediates counterpart preferences
- may or may not be a party to settlement

A broker can be an agent service, operator, or embedded system role.

### Guarantor
The actor that underwrites performance risk.

The guarantor:
- agrees to absorb or compensate certain failures
- increases trust and completion probability
- may require fees, collateral, or policy constraints

Guarantors matter most for risky or high-value plans.

## Optional Supporting Roles

Additional useful roles may include:
- `funder`: narrower than sponsor, focused on capital provision
- `operator`: manages runtime, moderation, or trust policy but is not a trade counterparty
- `reviewer`: a specialized verifier for human approval steps
- `custodian`: holds or releases a controlled asset or environment access right

## Role Matrix By Object

### Listing or blueprint
Should identify at least:
- publishing principal
- default executor or capability provider if applicable
- optional sponsor or guarantor hints if relevant

### Candidate
Should identify:
- candidate principals
- anticipated executors if known
- broker or composing actor if relevant
- verification expectations

### Execution plan
Must identify:
- principal for each leg
- executor for each leg if assigned or constrained
- verifier for each leg if required
- sponsor for balancing legs if present
- broker if the plan was broker-composed
- guarantor if any guarantee is attached

### Receipt
Must bind:
- which principal obligations completed
- which executor produced fulfillment evidence
- which verifier attested completion
- whether any sponsor or guarantor role was active in the plan

## Authorization Implications

Role separation must affect auth and policy.

Examples:
- a principal may authorize an executor to perform a bounded class of actions
- an executor may complete a leg without being allowed to accept settlement terms
- a verifier may attest completion without being allowed to edit consideration
- a sponsor may fund a balancing leg without becoming the deliverable executor

This means plan APIs should evolve toward explicit per-role permissions instead of assuming all participants can do everything.

## Liability Implications

Do not attach liability implicitly to the executor.

A company principal may allow an agent executor to perform work, but the company remains the counterparty.

Likewise:
- a verifier attesting completion is not automatically a guarantor
- a sponsor funding a leg is not automatically a principal to every other leg
- a broker composing a plan is not automatically liable for its completion

These distinctions are required for realistic commerce.

## Example

A realistic plan might look like this:
- Principal A: software company buying a deployment workflow
- Executor A1: procurement agent acting for A
- Principal B: infrastructure operator selling deployment execution
- Executor B1: deployment agent acting for B
- Principal C: blueprint publisher selling a workflow template
- Sponsor D: third party funding the balancing cash leg
- Verifier V: review agent plus human override for final acceptance

This is not an edge case. It is a likely common pattern.

## Product Consequences

The product should not explain everything as if a single identity owns all meaning.

Publicly, the product can stay simple:
- Offer
- Need
- Match
- Plan
- Result

But internally and contractually, plans and receipts must preserve role clarity.

## Implementation Consequences

Near-term implementation work should:
- add role-aware fields to candidate and plan structures
- distinguish principals from executors in API shape where possible
- allow verifier and sponsor roles to be attached per leg or per plan
- keep auth policy aligned with those roles

The current execution-plan model is a starting point, not the final form.

## Summary

SwapGraph must explicitly separate:
- who owes
- who executes
- who verifies
- who funds
- who coordinates
- who guarantees

Without that separation, trust, auth, and settlement become ambiguous.

That ambiguity is unacceptable for a system whose goal is to clear and execute multi-leg agent work.
