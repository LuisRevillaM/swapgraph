# Market Trust Artifacts

## Purpose

This document narrows the meaning of trust-related outputs in SwapGraph.

The system should not use the word `proof` as a vague umbrella term. Instead, it should distinguish evidence, attestation, and guarantee.

This makes the market more credible and keeps receipts honest.

## Core Principle

SwapGraph should prove only what it can actually support.

The system can often support strong statements about:
- who acted
- what was produced
- what authorization was used
- what artifacts or hashes exist
- what a counterparty or verifier attested
- what payment reference or settlement reference exists

It usually cannot support universal claims that a business outcome was objectively correct in all contexts.

## Layer 1: Evidence

Evidence is the raw trace or artifact set associated with execution or settlement.

Examples:
- output artifacts
- hashes
- timestamps
- execution logs
- environment identifiers
- external payment reference ids
- grant consumption records
- benchmark or evaluation outputs
- signed machine-readable event records

Evidence is necessary but not always sufficient.

Evidence answers:
- what happened mechanically
- what artifacts exist
- when it happened
- what environment or grant was used

## Layer 2: Attestation

Attestation is a statement by a recognized actor that conditions were met.

Possible attesters:
- counterparty principal
- assigned verifier
- operator
- automated verifier agent under policy

Attestation answers:
- who says the obligation was met
- at what time
- under what verification policy
- with what evidence references

Attestation does not automatically imply financial backing.

## Layer 3: Guarantee

Guarantee is a stronger commitment.

A guarantor states that if certain obligations are not met or a plan fails under covered conditions, the guarantor will absorb or compensate part of the loss.

Guarantee answers:
- who bears specific failure risk
- under what conditions
- up to what limit
- with what compensation policy

Guarantee is optional and should be modeled explicitly.

## Relationship Between The Three Layers

The trust stack should be interpreted as:
- evidence records what happened
- attestation states that obligations were met according to a policy
- guarantee backs risk if things go wrong or are disputed

Receipts should bind these layers together rather than collapsing them into the word `proof`.

## What A Receipt Should Eventually Include

A receipt should reference:
- plan id and version
- completed and failed obligations
- evidence references
- attestation records
- settlement references
- guarantee references if any
- final state

A receipt should not imply more than its underlying artifacts support.

## Evidence Requirements By Leg Type

### Service delivery
Evidence may include:
- produced artifacts
- logs
- completion report
- evaluation output
- environment and grant usage

### Blueprint delivery
Evidence may include:
- artifact reference
- artifact hash
- delivery timestamp
- license or support metadata

### Cash leg
Evidence may include:
- payment rail
- reference id
- payer attestation
- payee attestation
- settlement timestamp

### Access grant leg
Evidence may include:
- grant id
- scope
- audience
- nonce
- consumed_at
- expiration

## Attestation Policies

A leg or plan should specify one of these attestation patterns:
- principal attestation only
- verifier attestation only
- principal plus verifier
- dual-counterparty attestation
- automated verifier plus human override

The policy should be explicit before execution starts.

## Guarantee Policies

Guarantee should be explicit and bounded.

Possible guarantee shapes:
- sponsor backs a balancing cash leg
- guarantor compensates one failed leg up to a cap
- operator guarantees replay protection and evidence continuity only
- marketplace itself guarantees nothing beyond logged and signed receipt integrity

This matters because not every trust surface should imply economic backing.

## Evidence Quality Tiers

It is useful to classify evidence quality.

Suggested tiers:
- `trace_only`: logs and metadata only
- `artifact_bound`: logs plus artifacts or hashes
- `counterparty_attested`: artifact-bound plus counterparty attestation
- `verifier_attested`: artifact-bound plus verifier attestation
- `guaranteed`: attested plus explicit guarantee coverage

This gives the market a more honest trust language than generic proof claims.

## Product Consequences

Public product language should shift from vague proof claims to concrete trust statements.

Examples:
- `evidence attached`
- `counterparty attested`
- `verifier attested`
- `guaranteed by sponsor`

That is clearer than saying everything is simply `proven`.

## Current Implementation Implications

Current market features already provide building blocks:
- execution grants
- payment proof records
- signed receipts
- moderation and trust state
- thread and system event records

The next step is to reframe these features under the narrower evidence/attestation/guarantee model rather than widening generic proof language.

## Summary

Trust in SwapGraph should be modeled as three distinct layers:
- evidence
- attestation
- guarantee

That gives the market a more credible foundation for receipts, settlement, and failure handling.
