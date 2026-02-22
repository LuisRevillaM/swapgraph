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
- Resolved (fixtures-first, partial): M46 established canonical `CustodySnapshot` / `CustodyInclusionProof` schemas and deterministic Merkle inclusion verification primitives.

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
- Resolved (fixtures-first, partial): M43 (consent-proof challenge context + export checkpoint compaction contract).
- Resolved (fixtures-first, partial): M44 (stateful export checkpoint continuation continuity: checkpoint existence + cursor/attestation/query context lock).
- Resolved (fixtures-first, partial): M45 (checkpoint retention + expiry enforcement + opportunistic checkpoint GC).
- Resolved (fixtures-first, partial): M46 (proof-of-custody primitives: canonical custody snapshot + Merkle inclusion proof verifier).
- Resolved (fixtures-first, partial): M47 (vault holding lifecycle scaffold: deposit/reserve/release/withdraw state-machine + deterministic verifier).
- Resolved (fixtures-first, partial): M48 (vault custody publication/read scaffold: snapshot catalog pagination + inclusion-proof retrieval + deterministic failure semantics).
- Resolved (fixtures-first, partial): M49 (vault API transport/auth-scope surface wiring: manifest endpoints + `vault:read`/`vault:write` scopes + manifest-driven service auth enforcement + deterministic auth-surface verifier).
- Resolved (fixtures-first, partial): M50 (vault/settlement integration contract: start-time vault binding validation, mixed deposit modes, instant-ready all-vault cycles, and deterministic terminal vault-holding reconciliation on complete/fail).
- Resolved (fixtures-first, partial): M51 (partner read surfaces for vault-backed settlement cycles: deterministic `vault_reconciliation` + ordered `state_transitions` projection on settlement status/instructions).
- Resolved (fixtures-first, partial): M52 (partner vault reconciliation export surface: signed settlement-vault reconciliation exports with deterministic hash/signature verification and tamper-fail proofs).
- Resolved (fixtures-first, partial): M53 (partner vault reconciliation export continuity hardening: deterministic entry pagination + signed attestation chaining + checkpoint continuity validation + tamper-fail checkpoint proofs).
- Resolved (fixtures-first, partial): M54 (vault reconciliation export checkpoint retention/expiry hardening: deterministic checkpoint retention window + `checkpoint_expired` continuation failures + opportunistic checkpoint GC).
- Resolved (fixtures-first, partial): M55 (partner-program/commercial scaffold for vault exports: deterministic entitlement gating, per-day quota controls, and partner usage metadata projection on successful export responses).
- Resolved (fixtures-first, partial): M56 (partner-program governance read surface + rollout policy hooks: allowlist + minimum-plan gates with deterministic reason codes and self-serve entitlement/quota visibility).
- Resolved (fixtures-first, partial): M57 (partner-program admin-governed rollout policy mutation/read surfaces + deterministic policy-change audit entries + signed rollout-policy audit export).
- Resolved (fixtures-first, partial): M58 (rollout-policy audit export continuity + retention hardening: signed attestation/checkpoint chaining, stateful continuation locks, deterministic checkpoint-expiry failures, and opportunistic checkpoint GC).
- Resolved (fixtures-first, partial): M59 (rollout-policy governance controls hardening: freeze-window mutation locks, deterministic maintenance-mode export gates, idempotent admin-action control surface, and signed admin-action audit overlays).
- Resolved (fixtures-first, partial): M60 (operator freeze-export overlay gate + rollout control observability expansion on partner status projection).
- Resolved (fixtures-first, partial): M61 (operator runbook hooks + deterministic signed rollout diagnostics export surface for control-plane state).
- Resolved (fixtures-first, partial): M62 (rollout diagnostics export continuity + retention hardening: signed attestation/checkpoint chaining, stateful checkpoint continuation validation, deterministic checkpoint mismatch/expiry reason codes, and diagnostics checkpoint retention controls).
- Resolved (fixtures-first, partial): M63 (rollout diagnostics lifecycle hardening: signed lifecycle telemetry + deterministic stale-control alerts + threshold-validated diagnostics checks with continuity compatibility).
- Resolved (fixtures-first, partial): M64 (rollout diagnostics automation-hints hardening: signed operator automation planning payloads + bounded action-queue controls + deterministic automation parameter validation).
- Resolved (fixtures-first, partial): M65 (rollout diagnostics automation execution-template hardening: signed deterministic `action_requests[]` templates + idempotency scope metadata + automation/runbook coupling guardrail).
- Resolved (fixtures-first, partial): M66 (rollout diagnostics automation plan-integrity hardening: signed deterministic per-request `request_hash` anchors + bundle-level `plan_hash` for execution-plan integrity checks).
- Resolved (fixtures-first, partial): M67 (rollout diagnostics automation expected-effect hardening: signed deterministic per-step `expected_effect` projections for policy version/control outcomes).
- Resolved (fixtures-first, partial): M68 (rollout diagnostics automation execution-attestation hardening: signed deterministic `execution_attestation` anchors tying `plan_hash`, expected-effect hash chain, and request-hash chain to projected policy-version outcomes).
- Resolved (fixtures-first, partial): M69 (rollout diagnostics automation attestation-consistency verification hardening: verifier-enforced deterministic recomputation of `plan_hash`, execution hash chains, and policy-version projection envelope parity checks).
- Resolved (fixtures-first, partial): M70 (rollout diagnostics automation attestation-continuity hardening: deterministic execution-continuity anchors binding `attestation_after`/`checkpoint_after` context to automation execution attestation with verifier parity checks).
- Resolved (fixtures-first, partial): M71 (rollout diagnostics automation continuity-window policy hardening: deterministic `continuation_window_minutes` + `continuation_expires_at` anchors bound into execution attestation/continuation hash verification).
- Resolved (fixtures-first, partial): M72 (rollout diagnostics automation execution-receipt contract hardening: deterministic `receipt_steps_count` + `receipt_hash` execution attestation anchors with signed tamper-fail verification).
- Resolved (fixtures-first, partial): M73 (rollout diagnostics automation execution-journal hardening: deterministic `journal_entry_hashes` + `journal_hash` execution attestation anchors with signed tamper-fail verification).
- Resolved (fixtures-first, partial): M74 (rollout diagnostics automation rollback-plan synthesis hardening: deterministic `rollback_target_policy_version` + `rollback_hash` execution attestation anchors with signed tamper-fail verification).
- Resolved (fixtures-first, partial): M75 (rollout diagnostics automation simulation hardening: deterministic `simulation_projected_policy_version_after` + `simulation_risk_level` + `simulation_hash` execution attestation anchors with signed tamper-fail verification).
- Resolved (fixtures-first, partial): M76 (commercial usage ledger normalization: partner usage ledger write/export contracts with deterministic aggregation and signed export verification).
- Resolved (fixtures-first, partial): M77 (rev-share and billing statement exports: deterministic statement line synthesis and signed statement export verification).
- Resolved (fixtures-first, partial): M78 (SLA policy and breach-event contracts: partner SLA policy upsert, breach recording, and signed breach export verification).
- Resolved (fixtures-first, partial): M79 (partner dashboard summary API contract: deterministic usage/billing/SLA summary read surface).
- Resolved (fixtures-first, partial): M80 (partner OAuth app registration + credential lifecycle contracts: register/rotate/revoke/introspect with deterministic token reasoning).
- Resolved (fixtures-first, partial): M81 (webhook reliability hardening: delivery-attempt ledger + retry-policy metadata + signed dead-letter export continuity + deterministic replay/backfill workflow).
- Resolved (fixtures-first, partial): M82 (risk tier policy engine contract: partner risk-tier policy objects + deterministic blocked/manual-review/throttle enforcement reason codes across mutating partner write paths).
- Resolved (fixtures-first, partial): M83 (dispute workflow and evidence-bundle contracts: idempotent dispute create/resolve lifecycle + signed paginated evidence-bundle exports with deterministic continuation + tamper-fail verification).
- Resolved (fixtures-first, partial): M84 (Steam Tier-1 adapter contract hardening, fixture-only: idempotent adapter contract upsert/read + deterministic preflight contract checks for mode support, dry-run requirements, and batch-size ceilings).
- Resolved (integration-gated, partial): M85 (Steam deposit-per-swap live proof: idempotent operator proof-record contract + deterministic proof-hash artifacts + runbook-driven staging evidence flow behind `INTEGRATION_ENABLED=1`).
- Resolved (integration-gated, partial): M86 (Steam vault live proof: idempotent operator vault lifecycle proof-record contract with complete deposit/reserve/release/withdraw evidence + deterministic proof-hash artifacts behind `INTEGRATION_ENABLED=1`).
- Resolved (fixtures-first, partial): M87 (transparency-log publication contracts: idempotent append-only publication + signed paginated export with deterministic attestation/checkpoint continuation and tamper-fail verification).
- Resolved (fixtures-first, partial): M88 (unified inclusion-proof linkage contracts: idempotent linkage recording across signed receipt + custody inclusion proof + transparency publication chain roots, with signed paginated export continuity and tamper-fail verification).
- Resolved (fixtures-first, partial): M89 (Tier-2 adapter capability contracts: idempotent capability upsert/read + deterministic cross-ecosystem preflight checks for ecosystem pairing, transfer primitives, route-hop ceilings, and dry-run policy with scope-enforced auth behavior).
- Resolved (fixtures-first, partial): M90 (cross-adapter cycle semantics + signed receipts: idempotent non-atomic semantics declaration with disclosure acceptance linked to Tier-2 preflight readiness, plus signed cross-adapter receipt recording/read projection with deterministic discrepancy and signature-valid telemetry).
- Resolved (fixtures-first, partial): M91 (reliability/SLO conformance contracts: idempotent SLO metric windows + incident-drill evidence recording + replay parity checks, with signed conformance export and deterministic signature/tamper verification).
- Resolved (fixtures-first, partial): M92 (full-plan conformance + release-readiness matrix with deterministic milestone artifact coverage checks and zero-unresolved-blocker assertions).
- Resolved (fixtures-first, partial): M93 (cross-adapter compensation case contracts: idempotent create/update/read surfaces bound to signed cross-adapter discrepancy receipts with deterministic lifecycle transition guards and scope/idempotency enforcement).
- Resolved (fixtures-first, partial): M94 (compensation ledger/export contracts: idempotent ledger entry recording with payable-case gating + payout ceiling enforcement, and signed paginated ledger export with continuation attestation and tamper-fail verification).
- Resolved (fixtures-first, partial): M95 (dispute-to-compensation linkage workflow: idempotent linkage record/update lifecycle bridging disputes to compensation cases/ledger entries with deterministic transition guardrails and signed paginated linkage exports).
- Resolved (fixtures-first, partial): M96 (reliability auto-remediation planning contracts: idempotent remediation-plan suggestion workflow derived from reliability signals + deterministic risk/action synthesis + signed paginated remediation-plan export with continuation attestation and tamper-fail verification).
- Resolved (fixtures-first, partial): M97 (staging evidence refresh + operator conformance runbook pack: idempotent staging evidence manifest/checkpoint recording contracts, checkpoint-gated continuation export contracts, and verifier-backed proof-bundle integrity checks).
- Remaining: none (M92 release-readiness gate passed).
- Resolved (fixtures-first, partial): M99 (trust/safety risk-signal contracts: idempotent signal/decision recording, deterministic reason-code enforcement, and signed decision export continuation with tamper-fail verification).
- Resolved (fixtures-first, partial): M100 (metrics and network-health contracts: deterministic UTC-window metrics read surfaces + signed checkpointed network-health export continuation with tamper-fail verification).
- Resolved (fixtures-first, partial): M101 (product-surface readiness contracts: idempotent notification preference controls + anti-spam inbox projections, unified client-agnostic product projection surfaces, and partner UI capability/bundle contracts with deterministic reason-code enforcement).
- Resolved (fixtures-first, partial): M102 (commercial packaging/policy contracts: idempotent transaction-fee/subscription/boost/quota policy surfaces, deterministic precedence/non-bypass policy evaluation, and signed policy export continuation with tamper-fail verification).
- Resolved (fixtures-first, partial): M103 (liquidity provider primitives and attribution contracts: LP registry/persona API surfaces, deterministic disclosure reason-code floor, and attribution propagation for intent/proposal/receipt primitives).
- Resolved (fixtures-first, partial): M104 (liquidity simulation contracts: idempotent simulation session lifecycle + intent sync flow, deterministic simulation-mode reason-code floor, and signed checkpointed cycle/receipt export continuity with tamper-fail verification).
- Resolved (fixtures-first, partial): M105 (liquidity inventory lifecycle contracts: provider-scoped inventory snapshot/list/availability surfaces, deterministic per-item reserve/release outcomes with one-active-reservation invariants, and signed reconciliation export continuity/tamper-fail verification).
- Resolved (fixtures-first, partial): M106 (liquidity listing and proposal decision contracts: provider-scoped listing upsert/cancel/list surfaces, mandatory LP decision explainability payload capture, trust/safety precedence enforcement, and deterministic proposal/commit lineage projection for decision records).
- Resolved (integration-gated, partial): M107 (liquidity execution governance contracts: provider-scoped execution-mode upsert/get surfaces, explicit operator approval/rejection records for execution requests, and signed checkpointed execution export continuity with deterministic hard-stop reason codes).
- Resolved (fixtures-first, partial): M108 (liquidity autonomy policy contracts: provider-scoped policy upsert/get/evaluate surfaces, deterministic precedence and anti-farming guardrail enforcement, and signed checkpointed decision-audit export continuity with retention/redaction hooks).
- Resolved (fixtures-first, partial): M109 (partner liquidity-provider onboarding/governance contracts: partner-LP onboarding/get/status/eligibility/rollout surfaces with deterministic segment capability gating, downgrade triggers, and signed checkpointed governance export continuity).
- Resolved (fixtures-first, partial): M110 (swarm transparency and user-control contracts: public-safe liquidity directory/persona disclosure surfaces, idempotent counterparty preference controls with deterministic conflict/no-match signaling, and proposal/receipt counterparty disclosure projections with explicit LP labeling).
- Resolved (fixtures-first, partial): M111 (marketplace execution loop contracts: idempotent matching run/run-read surfaces, deterministic proposal replace+expiry lifecycle accounting, and runtime integration for stored user-intent-to-proposal generation).

---

## Verification mapping rule (non-negotiable)

For each milestone `Mx` we will require:
- `docs/prd/Mx.md`
- `milestones/Mx.yaml`
- `verify/mx.sh` (or equivalent)
- proof artifacts under `artifacts/milestones/Mx/latest/*`

Integration-required milestones must exit non-zero unless `INTEGRATION_ENABLED=1`.
