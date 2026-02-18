# SwapGraph v2.0 — Spec gaps / decisions log

This file converts the **v2.0 plan** into a **decision list**.
Each item here must become at least one of:
- explicit spec text (`docs/spec/*.md` and/or `docs/spec/schemas/*.json`),
- milestone acceptance criteria (`docs/prd/Mx.md`),
- automated verification (`verify/mx.*` + required artifacts).

---

## P0 — must resolve to make the agent-loop reliable (M1–M3)

1) **Schema versioning strategy**
- Plan says “stable object schemas” + versioned, backward compatible.
- Decide: how we version (field `schema_version`? OpenAPI versioning? JSON Schema `$id` only?).
- Verification target: examples validate; breaking changes require a new version file.

2) **Canonical primitives completeness (what’s in v1)**
- v2.0 names: `SwapIntent`, `CycleProposal`, `Commit`, `SettlementTimeline`, `SwapReceipt`.
- Decide if v1 also includes: `ActorRef`, `TradingPolicy`, `EventEnvelope`, `ErrorResponse`.
- Verification target: a “schema manifest” listing required primitives exists and is enforced.

3) **Idempotency semantics (exact)**
- Plan requires idempotency keys for all mutations.
- Decide:
  - idempotency key scope (per actor? per endpoint? per day?),
  - response replay rules,
  - error behavior when key reused with different payload.
- Verification target: deterministic scenario tests for accept/decline + intent create.

4) **Event model for webhooks + streams**
- Plan includes webhooks, streams, and replay from checkpoints.
- Decide:
  - event envelope fields (event_id, type, occurred_at, correlation_id, actor, payload, signature),
  - ordering guarantees (none vs per-cycle),
  - replay checkpoint format.
- Verification target: generated event logs can be replayed to reconstruct state.

5) **Structured errors + reason codes**
- We need stable errors for partners and for the agent’s own verification.
- Decide error codes for:
  - schema invalid,
  - constraint violation,
  - reservation conflict,
  - proposal expired,
  - idempotency conflict,
  - settlement blocked,
  - integration-required.

6) **Two-phase commit contract (exact state machine)**
- Plan: Accept → Ready once all participants accept.
- Decide:
  - can a participant cancel after accept?
  - how/when reservations are acquired + released,
  - timeouts and expiry semantics.
- Verification target: scenario suite that asserts “one active reservation per intent” + release on decline/expiry.

7) **Receipt signatures (v1 crypto scope)**
- Plan: signed receipts + public key set endpoint; rotation/revocation.
- Decide what “v1 crypto” actually means:
  - simple Ed25519 signing in-app (dev) vs HSM-backed (later),
  - how we publish verification keys (JWKS-like JSON),
  - what fields are signed.
- Verification target: `verify:m4` can create + verify a receipt offline.

---

## P1 — matching + pricing + confidence (needed before M2 is “real”)

8) **WantSpec schema taxonomy (Steam-first)**
- Plan wants sets, categories, attributes (wear/float/pattern/stickers).
- Decide the v1 schema for `want_spec` and what attributes exist.

9) **Pricing sources + confidence score definition**
- Decide pricing sources used in v1 (even if stubbed) and how to compute `confidence_score`.
- Verification target: a matching run produces proposals with explainability + confidence inputs recorded.

10) **Cycle selection fairness + determinism**
- Plan: disjoint selection, anti-starvation, deterministic runs.
- Decide seeded ordering rules and age bonus.

---

## P2 — settlement/custody (needed before M4–M6)

11) **Steam auth & inventory verification reality check**
- Plan mentions OAuth in places; Steam is typically OpenID (login) + Web API key / inventory endpoints.
- Decide what goes into `InventorySnapshot.verification_method` and what “snapshot trust score” is.

12) **Trade holds / cooldown policy**
- Decide:
  - excluded entirely from v1 matching?
  - allowed but reduces confidence / changes timeouts?
  - vault eligibility gates.

13) **Escrow ops model (single vs multiple escrow identities)**
- Decide blast radius, rate limits, incident response, and audit controls.

14) **Partial failure containment and protected recovery**
- Define “protected recovery mode” thresholds and reason codes.

15) **Proof-of-custody scope**
- Decide cadence, snapshot schema, Merkle root publication schedule, and inclusion proof format.

---

## P3 — partner/agent platform hardening (needed before M7–M8)

16) **Partner auth model + scopes**
- API keys vs OAuth client creds; per-partner quotas; least privilege.
- Resolved (fixtures-first): M30 (`docs/spec/AUTH.md` + per-endpoint scope annotations in API manifest).

17) **Webhook signing + replay protection**
- HMAC vs asymmetric; rotation; nonce/timestamp window.
- Resolved (fixtures-first): M29 (signed `EventEnvelope` + public key publication + tamper-fail verifier).

18) **Agent delegation tokens + TradingPolicy enforcement**
- Policy schema (max value/day, confidence threshold, quiet hours), token TTL/refresh, revocation model.
- Resolved (fixtures-first, partial): M32 (delegation grant contract + SwapIntents enforcement under `AUTHZ_ENFORCE=1`).
- Resolved (fixtures-first, partial): M33 (delegation lifecycle checks + agent read access expansion under `AUTHZ_ENFORCE=1`).
- Resolved (fixtures-first, partial): M34 (delegation lifecycle APIs + revocation persistence enforced from store under `AUTHZ_ENFORCE=1`).
- Resolved (fixtures-first, partial): M35 (signed delegation token format + header parsing/auth middleware).
- Resolved (fixtures-first, partial): M36 (delegation-token key publication/rotation + token introspection contract).
- Resolved (fixtures-first, partial): M37 (delegation policy enforcement expanded across matching/commit/settlement read boundaries).
- Resolved (fixtures-first, partial): M38 (delegated write-path daily cap + high-value consent hooks + policy audit trail).
- Resolved (fixtures-first, partial): M39 (consent tier hardening + delegated policy audit read contract).
- Resolved (fixtures-first, partial): M40 (consent proof binding + delegated policy audit pagination/retention hardening).
- Resolved (fixtures-first, partial): M41 (consent proof signature assurances + delegated policy-audit export integrity contracts).
- Resolved (fixtures-first, partial): M42 (consent-proof anti-replay + export-attestation continuity across pagination chunks).
- Remaining: consent-proof challenge context and export-checkpoint compaction contracts.

---

## Verification mapping rule (non-negotiable)

For each milestone `Mx` we will require:
- `docs/prd/Mx.md`
- `milestones/Mx.yaml`
- `verify/mx.sh` (or equivalent)
- proof artifacts under `artifacts/milestones/Mx/latest/*`

Integration-required milestones must exit non-zero unless `INTEGRATION_ENABLED=1`.
