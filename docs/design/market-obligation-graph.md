# Market Obligation Graph

## Purpose

This document defines the canonical structure of a trade in SwapGraph.

The core primitive is not a listing, an edge, or even a match. The core primitive is an obligation graph.

An obligation graph answers five questions:
- who is economically responsible
- who receives consideration
- what each party owes
- what depends on what
- what evidence or settlement is required before the graph can be considered complete

This document separates the economic graph from the execution graph so the system can reason clearly about liability, fulfillment, and proof.

## Core Thesis

A proposed trade is useful only if it can become a settleable structure.

That means a trade must move through these stages:
- market intake
- candidate discovery
- obligation graph proposal
- participant acceptance
- execution mapping
- settlement and evidence collection
- receipt issuance

The market is the intake.
The plan is the product.
The receipt is the trust asset.

## Canonical Objects

The public market layer continues to expose:
- offers and needs through listings and blueprints
- matches through candidates
- accepted trades through execution plans
- proof through receipts

Internally, those objects should be understood as follows:

### Candidate
A candidate is a proposed obligation graph.

It is not final execution state.
It is a structured hypothesis that a set of obligations can clear together.

A candidate must express:
- participating principals
- what each principal would owe
- what each principal would receive
- balancing cash or credit legs if required
- dependency structure
- why the graph is valid
- what remains to be accepted or authorized

### Execution plan
An execution plan is an accepted, versioned obligation graph with execution mapping.

It must express:
- the economic obligations
- the assigned executors or execution policy for each obligation
- authorization requirements
- verification requirements
- settlement mode
- fallback and unwind rules
- current state

### Receipt
A receipt is an evidence bundle bound to completed obligations.

A receipt does not assert universal truth.
It binds:
- evidence
- attestation
- settlement state
- the obligation graph version that completed

## Economic Graph

The economic graph is the contractual and settlement-facing structure.

It represents:
- principals
- obligations between principals
- consideration between principals
- dependency ordering
- fallback and unwind policies
- settlement requirements

It does not need to expose every internal workflow step.

### Economic graph nodes
Economic graph nodes represent principals and economically meaningful assets or claims.

Examples:
- a company principal
- an individual principal
- a sponsor principal
- a blueprint asset
- a service deliverable
- a cash balancing obligation

### Economic graph edges
Economic graph edges represent obligations or consideration.

Examples:
- principal A owes service X to principal B
- principal B owes cash Y to principal C
- principal C owes blueprint Z to principal A

### Economic graph leg
A leg is one atomic obligation inside the graph.

Each leg should include:
- leg id
- principal from
- principal to
- obligation type
- consideration or deliverable reference
- settlement method
- verification requirement
- blocking vs non-blocking status
- dependencies on other legs
- fallback or substitution policy

## Execution Graph

The execution graph is the operational fulfillment structure.

It represents:
- executors
- agents
- humans
- tools
- approvals
- workflows
- verifier actions

The execution graph may be richer than the economic graph.

Example:
- economic graph says principal A owes translation service to principal B
- execution graph says agent T drafts, human R reviews, verifier V signs off, and toolchain C produces artifacts

The counterparty may only need the economic graph and the final evidence, not the full internal workflow.

## Why The Separation Matters

Without the separation, the system confuses:
- who is liable
- who executed
- who verified
- who funded
- who authorized

That leads to bad settlement semantics.

The economic graph is what clears.
The execution graph is how fulfillment happens.
Receipts bind execution evidence back to economic obligations.

## Candidate Shape In Obligation Terms

A candidate should be interpreted as:
- a proposed economic graph
- with a preview of obligation legs
- a list of participating principals
- an explainable reason the graph clears
- an expected settlement and verification burden
- a confidence estimate driven by feasibility, not novelty

A candidate is `interesting` only if it is also plausibly `clearable`.

## Execution Plan Shape In Obligation Terms

An execution plan should contain:
- graph id and version
- participant principals
- assigned or permitted executors for each leg
- role matrix for each leg
- acceptance matrix
- authorization requirements
- settlement method per leg or plan
- fallback and unwind rules
- evidence and attestation requirements
- current state

The current implementation already contains:
- transfer legs
- acceptance state
- settlement policy
- receipt binding

Future work should strengthen those fields into a more explicit obligation model rather than replacing them entirely.

## Plan States

The plan-level state machine should eventually be interpreted as:
- proposed
- balanced
- pending_participant_acceptance
- ready_for_settlement
- settlement_in_progress
- partially_complete
- verified
- completed
- failed
- cancelled
- unwound

Not all of these states must ship at once, but the model should reserve room for them.

## Leg States

Leg-level states should eventually support:
- pending
- authorized
- started
- delivered
- accepted
- failed
- compensated
- substituted

The current `pending/completed/failed` model is a minimal subset, not the end state.

## Settlement Semantics

Money is not the whole trade. It is one leg type.

A graph may include:
- asset transfer
- service delivery
- blueprint delivery
- cash payment
- narrow balance transfer
- access grant
- verification-only leg

This is why mixed plans are first-class and why cycle discovery matters.

## Example

Consider three principals:
- principal A wants deployment work
- principal B wants a blueprint
- principal C wants cash

The economic graph could be:
- A owes cash to C
- C owes blueprint to B
- B owes deployment work to A

The execution graph could be:
- B uses an agent swarm to perform deployment
- C delivers the blueprint artifact through a hosted copy workflow
- verifier V checks deployment logs and blueprint integrity

The receipt should bind:
- deployment artifacts and attestations
- blueprint artifact reference and hash
- cash payment reference
- the completed plan id and graph version

## Implementation Consequences

This model implies:
- candidates should not be treated as mere preview cards
- execution plans should grow toward obligation-first semantics
- role separation must be made explicit in plan and leg structures
- settlement must follow the economic graph, not arbitrary execution detail
- receipts should bind to graph completion, not only to a generic terminal state

## Non-goals

This document does not specify:
- matching heuristics in full detail
- credit system design
- UI wording
- moderation workflows

Those belong in separate documents.

## Summary

The canonical unit of commerce in SwapGraph is an obligation graph.

- Candidate = proposed obligation graph
- Execution plan = accepted, versioned obligation graph with execution mapping
- Receipt = evidence bundle bound to completed obligations
