# Project Status — swapgraph

Last updated: 2026-02-21

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
- M60: ✅ commercial governance hardening follow-up (operator freeze-export overlay + rollout-control observability refinements on partner self-serve status) (fixtures-first)
- M61: ✅ commercial governance continuity follow-up (operator runbook hooks + deterministic signed rollout diagnostics export surface) (fixtures-first)
- M62: ✅ commercial governance diagnostics continuity hardening (signed diagnostics attestation/checkpoint chaining + stateful continuation locks + deterministic checkpoint expiry controls + compact diagnostics mode) (fixtures-first)
- M63: ✅ commercial governance diagnostics lifecycle hardening (signed lifecycle telemetry + stale-control alerts + threshold-validated diagnostics policy checks with continuity compatibility) (fixtures-first)
- M64: ✅ commercial governance diagnostics operator automation hints hardening (signed automation planning hints + bounded action queues + deterministic automation parameter validation with continuity/signature coverage) (fixtures-first)
- M65: ✅ commercial governance diagnostics automation execution-template hardening (signed `automation_hints.action_requests[]`, deterministic idempotency-scope metadata, and strict automation+runbook context coupling) (fixtures-first)
- M66: ✅ commercial governance diagnostics automation plan-integrity hardening (signed deterministic `action_requests[].request_hash` + bundle-level `automation_hints.plan_hash` anchors for downstream execution-plan integrity checks) (fixtures-first)
- M67: ✅ commercial governance diagnostics automation expected-effect hardening (signed deterministic `action_requests[].expected_effect` projections for per-step policy-control outcomes) (fixtures-first)
- M68: ✅ commercial governance diagnostics automation execution-attestation hardening (signed deterministic `automation_hints.execution_attestation` anchors for projected run outcomes: pre/post policy version envelope, expected-effect hash chain, request-hash chain, and attestation hash) (fixtures-first)
- M69: ✅ commercial governance diagnostics automation attestation-consistency verification hardening (verifier-enforced deterministic recomputation of `plan_hash`, execution hash chains, and policy-version projection envelope parity checks for signed diagnostics payloads) (fixtures-first)
- M70: ✅ commercial governance diagnostics automation attestation-continuity hardening (signed deterministic execution-continuity anchors: `continuation_attestation_after`, `continuation_checkpoint_after`, `continuation_hash` with verifier parity checks across default/public-key paths) (fixtures-first)
- M71: ✅ commercial governance diagnostics automation continuity-window policy hardening (signed deterministic `continuation_window_minutes` + `continuation_expires_at` execution anchors bound into attestation/continuation hash verification) (fixtures-first)
- M72: ✅ commercial governance diagnostics automation execution-receipt contract hardening (signed deterministic `receipt_steps_count` + `receipt_hash` execution attestation anchors with tamper-fail verification) (fixtures-first)
- M73: ✅ commercial governance diagnostics automation execution-journal export hardening (signed deterministic `journal_entry_hashes` + `journal_hash` execution attestation anchors with tamper-fail verification) (fixtures-first)
- M74: ✅ commercial governance diagnostics automation rollback-plan synthesis hardening (signed deterministic `rollback_target_policy_version` + `rollback_hash` execution attestation anchors with tamper-fail verification) (fixtures-first)
- M75: ✅ commercial governance diagnostics automation simulation hardening (signed deterministic `simulation_projected_policy_version_after` + `simulation_risk_level` + `simulation_hash` execution attestation anchors with tamper-fail verification) (fixtures-first)
- M76: ✅ commercial governance usage ledger normalization (partner usage ledger write/export contracts with deterministic aggregation + signed export verification) (fixtures-first)
- M77: ✅ commercial governance rev-share/billing statement export hardening (deterministic statement line synthesis + signed statement export verification) (fixtures-first)
- M78: ✅ commercial governance SLA policy and breach-event contract hardening (policy upsert + breach recording + signed breach export verification) (fixtures-first)
- M79: ✅ partner dashboard summary API contract hardening (deterministic usage/billing/SLA summary read surface) (fixtures-first)
- M80: ✅ partner OAuth app registration + credential lifecycle contract hardening (register/rotate/revoke/introspect with deterministic token reasoning) (fixtures-first)
- M81: ✅ webhook reliability and dead-letter replay hardening (delivery-attempt ledger + retry policy metadata + signed dead-letter export continuity + deterministic replay/backfill workflow) (fixtures-first)
- M82: ✅ risk tier policy engine contract hardening (partner risk-tier policy upsert/read contracts with deterministic blocked/manual-review/throttle reason-code enforcement across mutating commercial write paths) (fixtures-first)
- M83: ✅ dispute workflow and evidence-bundle contract hardening (idempotent dispute create/resolve lifecycle + signed paginated evidence-bundle export with deterministic continuation and tamper-fail verification) (fixtures-first)
- M84: ✅ Steam Tier-1 adapter contract hardening (fixture-only) (idempotent adapter contract upsert/read + deterministic preflight contract checks for mode/dry-run/batch constraints with scope-enforced fixture handoff readiness) (fixtures-first)
- M85: ✅ Steam deposit-per-swap live proof (integration-gated) (idempotent live-proof record contract + deterministic proof-hash artifact generation + operator runbook, enforced behind `INTEGRATION_ENABLED=1`) (staging integration proof)
- M86: ✅ Steam Vault live proof (integration-gated) (idempotent vault lifecycle live-proof record contract + deterministic proof-hash artifacts + runbook-driven staging evidence flow with `settlement:write` + `vault:write`, enforced behind `INTEGRATION_ENABLED=1`) (staging integration proof)
- M87: ✅ Transparency log publication contract (fixtures-first) (idempotent append-only publication + signed paginated export with deterministic attestation/checkpoint continuation and tamper-fail signature/hash verification) (fixtures-first)
- M88: ✅ Unified inclusion-proof linkage (fixtures-first) (idempotent linkage recording across signed receipts + custody inclusion proofs + transparency publication chain roots, plus signed paginated linkage export with deterministic attestation/checkpoint continuation and tamper-fail verification) (fixtures-first)
- M89: ✅ Tier-2 adapter capability contract (cross-ecosystem preflight, fixtures-first) (idempotent Tier-2 capability upsert/read + deterministic cross-ecosystem preflight checks for ecosystem pairing, transfer primitives, route-hop ceilings, and dry-run policy with scope-enforced auth proofs) (fixtures-first)
- M90: ✅ Cross-adapter cycle semantics and receipts (fixtures-first) (idempotent non-atomic semantics declarations with disclosure acceptance linked to Tier-2 preflight readiness, plus signed cross-adapter receipt recording/read projection with deterministic discrepancy and signature-valid telemetry) (fixtures-first)
- M91: ✅ Reliability/SLO conformance pack (fixtures-first) (idempotent SLO metric recording + incident-drill evidence recording + replay-recovery parity checks, with signed conformance export and deterministic signature/tamper verification) (fixtures-first)
- M92: ✅ Full-plan conformance and release-readiness gate (fixtures-first) (deterministic conformance matrix + milestone artifact coverage checks + release-readiness assertions with zero unresolved blocker verification) (fixtures-first)
- M93: ✅ Cross-adapter compensation case contract (fixtures-first) (idempotent compensation case create/update/read surfaces linked to signed cross-adapter discrepancy receipts, deterministic lifecycle transitions, and scope/idempotency enforcement proofs) (fixtures-first)
- M94: ✅ Compensation ledger + signed export (fixtures-first) (idempotent compensation-ledger recording bound to payable case state, deterministic payout ceiling enforcement, and signed paginated ledger export with continuation attestation/tamper-fail verification) (fixtures-first)
- M95: ✅ Dispute-to-compensation linkage workflow (fixtures-first) (idempotent dispute-compensation linkage record/update lifecycle, deterministic transition guardrails, resolved-dispute close enforcement, and signed paginated linkage export with continuation/tamper-fail verification) (fixtures-first)
- M96: ✅ Reliability auto-remediation planning contract (fixtures-first) (idempotent remediation-plan suggestions derived from reliability signals with deterministic risk/action synthesis, `reliability_signals_missing` blocker signaling, and signed paginated remediation-plan export with continuation attestation/tamper-fail verification) (fixtures-first)
- M97: ✅ Staging evidence refresh + operator conformance runbook pack (fixtures-first) (idempotent staging evidence-bundle manifest recording, checkpoint-gated continuation exports, signed bundle integrity verification, and refreshed M85/M86 evidence capture runbook flow) (fixtures-first)

## Next
- Next PRD batch planning (post M93–M97 tranche)

## Notes
- We are intentionally building *fixtures-first* so verifiers are deterministic and do not require credentials.
- Real Steam settlement milestones are operator-gated integration milestones (`INTEGRATION_ENABLED=1`).
