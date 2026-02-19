# Project Status — swapgraph

Last updated: 2026-02-19

## Autopilot
- Status: **spec hardening** (not approved)
- Canonical plan: `docs/source/LATEST.md` (v2.0)

## Milestones (progress)
- M0: ✅ bootstrap + verification harness
- M1: ✅ canonical primitives + JSON Schemas + examples (+ verifier)
- M2: ✅ API surface contract (manifest + request/response schemas + examples)
- M3: ✅ events contract (manifest + payload schemas) + replay proof
- M4: ✅ SwapIntent ingestion core (create/update/cancel/get/list) + idempotency + persistence proof
- M5: ✅ matching engine v1 (2–3 party cycles) + deterministic disjoint selection + schema-validated CycleProposals
- M6: ✅ proposal delivery fixtures (polling payload + webhook event outbox using M3 envelopes; includes duplicate event_id)
- M7: ✅ commit handshake v1 (accept/decline → ready) + reservation locks + idempotency replay + events outbox

- M8: ✅ accept-window expiry (cancel accept-phase commit after proposal expiry + release reservations)
- M9: ✅ settlement timeline simulator (deposit → escrow.ready → executing → receipt, plus deposit-timeout unwind)
- M10: ✅ settlement + receipts REST contract endpoints + strict SettlementTimeline legs schema
- M11: ✅ settlement event types (deposit_required / deposit_confirmed / executing) + payload schemas + verifier
- M12: ✅ event replay v2 (settlement + receipts summaries + checkpoint resume proof)
- M13: ✅ settlement read APIs fixture scenario (instructions/status/receipts) driven from store state + schema validation
- M14: ✅ read endpoint authz rules (partner vs participant) + forbidden proofs

- M15: ✅ read-side redaction + filtering (partner vs participant views)

- M16: ✅ partner scoping (multi-tenant) — partner reads limited to their own cycles
- M17: ✅ partner_id in API auth model + correlation IDs in settlement/receipt read responses (contract + verifier)
- M18: ✅ cycle proposal read APIs fixture scenario (list/get) + authz proofs (contract + verifier)
- M19: ✅ proposal delivery persistence + partner scoping (polling + webhook ingestion, dedupe-by-event_id)
- M20: ✅ commit APIs backed by stored proposals (accept/decline loads proposal from store + idempotency + reservation locks)
- M21: ✅ settlement.start loads commit+proposal from store + enforces partner proposal scoping
- M22: ✅ settlement actions via API service (deposit_confirmed/begin_execution/complete; store-backed + partner-scoped)
- M23: ✅ settlement failure path via API service (deposit-timeout unwind + scoped receipt)
- M24: ✅ end-to-end store-backed pipeline smoke test (delivery → commit → settlement → read APIs)
- M25: ✅ settlement write endpoint contracts (start/deposit/begin/complete/expire) + examples + verifier
- M26: ✅ correlation_id in remaining response contracts (intents/proposals/commit)
- M27: ✅ correlation_id in ErrorResponse (fixtures-first) + propagate to all error bodies
- M28: ✅ verifiable receipt signatures (Ed25519) + receipt signing keys contract + verifier
- M29: ✅ webhook/event signing (Ed25519) + event signing keys contract + verifier
- M30: ✅ auth scopes contract + webhook ingestion hardening (signature verify + persistent dedupe proof)
- M31: ✅ scope enforcement in services (+ INSUFFICIENT_SCOPE proofs; behind AUTHZ_ENFORCE=1)
- M32: ✅ agent delegation grants + TradingPolicy enforcement (SwapIntents; behind AUTHZ_ENFORCE=1)
- M33: ✅ delegation lifecycle (expiry/revocation) + agent read access expansion (behind AUTHZ_ENFORCE=1)
- M34: ✅ delegation lifecycle APIs + revocation persistence (store-backed; behind AUTHZ_ENFORCE=1)
- M35: ✅ signed delegation token format + header parsing/auth middleware (fixtures-first)
- M36: ✅ delegation-token key publication/rotation contract + token introspection endpoint (fixtures-first)
- M37: ✅ delegation policy enforcement expanded across matching/commit/settlement read boundaries (fixtures-first)
- M38: ✅ advanced delegated write-path policy controls (`max_value_per_day_usd`, consent hooks, audit trail expansion) (fixtures-first)
- M39: ✅ high-value consent tier hardening + delegated policy audit read contract (fixtures-first)
- M40: ✅ consent proof binding + delegated policy audit pagination/retention hardening (fixtures-first)
- M41: ✅ consent proof signature contract + delegated policy audit export integrity (fixtures-first)
- M42: ✅ consent-proof anti-replay + signed export pagination attestations (fixtures-first)
- M43: ✅ consent-proof challenge context + export checkpoint compaction contract (fixtures-first)
- M44: ✅ stateful checkpoint continuation continuity (checkpoint exists + cursor/attestation/query context lock) (fixtures-first)
- M45: ✅ checkpoint retention + expiry enforcement + opportunistic checkpoint GC (fixtures-first)
- M46: ✅ proof-of-custody primitives (custody snapshot + Merkle inclusion proof verifier) (fixtures-first)
- M47: ✅ vault deposit/withdraw lifecycle contract scaffold + deterministic state-transition verifier (fixtures-first)
- M48: ✅ vault publication/read contract scaffold (snapshot catalog pagination + inclusion proof retrieval) (fixtures-first)
- M49: ✅ vault API auth/scope transport surface wiring (manifest endpoints + `vault:*` scopes + service-level manifest auth enforcement + deterministic auth verifier) (fixtures-first)
- M50: ✅ vault/settlement integration contract (start-time vault bindings + mixed-mode deposit semantics + all-vault instant-ready path + terminal holding reconciliation) (fixtures-first)
- M51: ✅ vault settlement reconciliation/event read surfaces for partners (`settlement.status`/`settlement.instructions` vault reconciliation + state transition projection) (fixtures-first)
- M52: ✅ partner vault/settlement reconciliation export surface (`settlement.vault_reconciliation.export` signed payloads + offline verification/tamper checks) (fixtures-first)
- M53: ✅ partner vault reconciliation export continuity hardening (entry pagination + signed attestation chain + optional checkpoint continuity enforcement + tamper-fail checkpoint verification) (fixtures-first)
- M54: ✅ vault reconciliation export checkpoint retention/expiry hardening (`SETTLEMENT_VAULT_EXPORT_CHECKPOINT_RETENTION_DAYS`, deterministic `checkpoint_expired` failures, opportunistic checkpoint GC) (fixtures-first)
- M55: ✅ partner-program/commercial scaffold for vault export rollout (`SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE`, entitlement gating, daily quota enforcement, and partner usage metadata projection) (fixtures-first)
- M56: ✅ partner program governance surfaces (`partnerProgram.vault_export.get` read API + rollout policy hooks: allowlist + minimum plan + deterministic governance reason codes) (fixtures-first)
- M57: ✅ partner program admin-governed rollout mutation surfaces (`rollout_policy.get`/`rollout_policy.upsert` + signed `rollout_policy_audit.export` + idempotent admin writes + deterministic audit entries) (fixtures-first)
- M58: ✅ rollout-policy audit continuity/retention hardening (signed attestation/checkpoint chain, stateful continuation validation, and deterministic checkpoint expiry controls) (fixtures-first)
- M59: ✅ rollout-policy governance controls hardening (policy freeze windows + deterministic maintenance-mode gates + signed admin-action audit overlays) (fixtures-first)

## Next
- M60: commercial governance hardening follow-up (operator policy overlays + rollout-control observability refinements) (fixtures-first)

## Notes
- We are intentionally building *fixtures-first* so verifiers are deterministic and do not require credentials.
- Real Steam settlement is an operator-gated integration milestone (`INTEGRATION_ENABLED=1`).
