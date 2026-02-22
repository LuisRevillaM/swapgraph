# API Surface (v1)

SwapGraph is **API-first**.
First-party clients (web + iOS) and third parties (partners + agents) use the same primitives.

This doc defines the **contract** for the REST API and webhook delivery.

## Principles
- **Idempotency is mandatory** for all mutating requests.
- **Structured errors** with stable `error.code`.
- **Correlation IDs** are present on every request/response.
- **No polling required** for integrations that use webhooks/streams (polling allowed as a fallback).

## Auth (v1)
- Partners authenticate with an API key.
  - The key resolves to a stable, server-assigned `partner_id` (modeled as `ActorRef { type:"partner", id:"<partner_id>" }`).
  - `partner_id` is used for multi-tenant scoping (partners cannot read other partners’ cycles or proposals).
- Users authenticate with SwapGraph sessions.
- Agents authenticate via delegation tokens (see `docs/spec/AUTH.md`).

Concrete auth headers + scope taxonomy live in:
- `docs/spec/AUTH.md`

## Headers
- `Idempotency-Key` (required for mutating endpoints)
- `X-Correlation-Id` (optional on request; always present in responses)
  - Note: in fixtures-first verification (no HTTP layer yet), responses also include `correlation_id` in the JSON body as a stand-in for the response header.

Auth headers (see `docs/spec/AUTH.md` for details):
- `X-Partner-Key` (partner)
- `Authorization: Bearer ...` (user/agent)
  - agent bearer tokens use the v1 delegation-token format prefix `sgdt1.`

## Resources (v1)
- `SwapIntent`
  - `POST /swap-intents` (create)
  - `PATCH /swap-intents/{id}` (update)
  - `POST /swap-intents/{id}/cancel`
  - `GET /swap-intents/{id}`
  - `GET /swap-intents` (list)
  - delegated agent writes are policy-gated (per-swap cap, daily cap, and optional high-value consent hook with proof binding/signature/anti-replay/challenge controls)

- `PlatformConnection`
  - `GET /platform-connections` (list)
  - `POST /platform-connections` (upsert)

- `Inventory`
  - `POST /inventory/snapshots` (record partner snapshot)
  - `GET /inventory/assets` (list latest normalized partner assets; optional `platform` filter)

- `Disputes` (canonical facade)
  - `POST /disputes` (create)
  - `GET /disputes/{dispute_id}` (get)

- `TrustSafety`
  - `POST /trust-safety/signals` (record risk signal)
  - `POST /trust-safety/decisions` (record policy decision)
  - `GET /trust-safety/decisions/{decision_id}` (get decision projection)
  - `GET /trust-safety/decisions/export` (signed paginated decision export)
    - supports filters (`subject_actor_id`, `decision`, `from_iso`, `to_iso`)
    - supports continuation (`limit`, `cursor_after`, `attestation_after`, `checkpoint_after`)
    - supports retention and redaction hooks (`retention_days`, `redact_subject`)

- `Metrics`
  - `GET /metrics/north-star`
  - `GET /metrics/marketplace-funnel`
  - `GET /metrics/partner-health`
  - `GET /metrics/safety-health`
  - `GET /metrics/network-health/export`
    - deterministic UTC window semantics (`from_iso` inclusive, `to_iso` exclusive) with `bucket` (`hour|day|week`)
    - partner-tenant scoped reads only (partner cannot request other partner metrics)
    - signed paginated export with continuation anchors (`limit`, `cursor_after`, `attestation_after`, `checkpoint_after`)
    - continuation enforces checkpoint continuity for deterministic export replay (`metrics_export_checkpoint_required`, `metrics_export_checkpoint_mismatch`)

- `Notifications`
  - `GET /notifications/preferences` (get actor notification controls)
  - `POST /notifications/preferences` (idempotent upsert of quiet-hours, urgency threshold, and category controls)
  - `GET /notifications/inbox` (notification inbox projection with taxonomy filtering)

- `ProductProjection`
  - `GET /product-projections/inventory-awakening`
  - `GET /product-projections/cycle-inbox`
  - `GET /product-projections/settlement-timeline/{cycle_id}`
  - `GET /product-projections/receipt-share/{receipt_id}`
  - projection query validation failures use deterministic reason code `product_projection_query_invalid`

- `MarketplaceMatching`
  - `POST /marketplace/matching/runs` (idempotent marketplace matching execution run)
  - `GET /marketplace/matching/runs/{run_id}` (read deterministic marketplace matching run record)
  - matching loop invariants:
    - matching execution uses active user intents and deterministic cycle-scoring semantics
    - run records include deterministic selected/stored/replaced/expired proposal counts
    - generated proposals are persisted into canonical proposal read surfaces
    - invalid run requests, missing asset valuations, and unknown run ids fail with stable reason codes

- `LiquidityDirectory`
  - `GET /liquidity-providers/directory` (public-safe LP directory list with deterministic filter semantics)
  - `GET /liquidity-providers/directory/{provider_id}` (public-safe LP directory profile)
  - `GET /liquidity-providers/directory/{provider_id}/personas` (public-safe LP persona disclosures)
  - directory surfaces intentionally expose disclosure-safe profile data only (no partner-internal governance internals)

- `CounterpartyPreferences`
  - `GET /counterparty-preferences` (get actor counterparty controls)
  - `POST /counterparty-preferences` (idempotent upsert of bot/house/partner controls + category-level filters)
  - control invariants:
    - explicit `allow_bots`, `allow_house_liquidity`, `allow_partner_lp` switches
    - category filter conflicts fail deterministically (no silent override)
    - no-eligible behavior is explicit (`no_match`)

- `CounterpartyDisclosureProjection`
  - `GET /product-projections/proposals/{proposal_id}/counterparty-disclosure`
  - `GET /product-projections/receipts/{receipt_id}/counterparty-disclosure`
  - disclosure invariants:
    - LP counterparties are explicitly labeled in proposal and receipt projections
    - automation and house-liquidity flags are explicit in disclosure payloads
    - persona/strategy summary refs and decision-rationale refs are projected when present

- `EdgeIntent`
  - `POST /edge-intents` (idempotent edge-intent upsert)
  - `GET /edge-intents` (list edge-intents with deterministic filtering)
  - `GET /edge-intents/{edge_intent_id}` (read edge-intent)
  - edge-intent invariants:
    - user actors can only create edges from source intents they own
    - source and target intents must exist
    - `block` disables a directed edge, `allow` enables a directed edge, and `prefer` enables + ranks a directed edge
    - matching can form cycles from derived compatibility edges and/or explicit edge-intent edges

- `PartnerUi`
  - `GET /partner-ui/capabilities` (supported embedded surfaces/version matrix for partner actors)
  - `GET /partner-ui/bundles/{surface}` (surface payload bundle for partner embedding mode)
  - unknown surfaces return deterministic reason code `partner_ui_surface_unknown`

- `CommercialPolicy`
  - `GET /commercial/policies/transaction-fee`
  - `POST /commercial/policies/transaction-fee`
  - `GET /commercial/policies/subscription-tier`
  - `POST /commercial/policies/subscription-tier`
  - `GET /commercial/policies/boost`
  - `POST /commercial/policies/boost`
  - `GET /commercial/policies/quota`
  - `POST /commercial/policies/quota`
  - `POST /commercial/policies/evaluate`
    - deterministic precedence invariant: `safety>trust>commercial>preference`
    - enforces non-bypass guards for safety/trust/settlement constraints
  - `GET /commercial/policies/export`
    - signed policy-audit export payload with attestation/checkpoint continuity
    - continuation uses `limit`, `cursor_after`, `attestation_after`, `checkpoint_after`
    - continuation context mismatch and unknown anchors return deterministic export reason codes

- `PartnerLiquidityProvider`
  - `POST /partner-liquidity-providers` (onboard partner-owned LP with deterministic governance defaults)
  - `GET /partner-liquidity-providers/{provider_id}` (read partner-owned LP governance profile)
  - `POST /partner-liquidity-providers/{provider_id}/status` (upsert governance status, segment tier, and baseline posture)
  - `POST /partner-liquidity-providers/{provider_id}/eligibility/evaluate` (deterministic segment/capability eligibility evaluation)
  - `POST /partner-liquidity-providers/{provider_id}/rollout` (upsert capability rollout policy bound to eligibility gates)
  - `GET /partner-liquidity-providers/{provider_id}/rollout/export` (signed partner LP governance export with checkpoint continuity)
  - governance invariants:
    - active rollout requires latest eligibility verdict `allow`
    - segment/capability gating blocks rollout when requested capabilities exceed effective segment tier
    - critical violations and baseline failures trigger deterministic downgrade reason-code paths

- `LiquidityProvider`
  - `POST /liquidity-providers` (register provider profile with disclosure + policy refs)
  - `GET /liquidity-providers/{provider_id}` (get provider profile)
  - `GET /liquidity-providers` (list partner-owned provider profiles; optional `provider_type` filter)
  - `POST /liquidity-providers/{provider_id}/persona` (upsert bot/persona disclosure profile)
  - Attribution surfaces:
    - `SwapIntent` supports optional `liquidity_provider_ref`, `persona_ref`, and `liquidity_policy_ref`
    - `CycleProposal.participants[]` supports optional LP attribution refs
    - `SwapReceipt` supports optional `liquidity_provider_summary[]` disclosure lineage

- `LiquiditySimulation`
  - `POST /liquidity-simulation/sessions` (start a simulation-only session)
  - `GET /liquidity-simulation/sessions/{session_id}` (get simulation session state)
  - `POST /liquidity-simulation/sessions/{session_id}/stop` (idempotent stop)
  - `POST /liquidity-simulation/sessions/{session_id}/intents/sync` (sync simulated intents into session)
  - `GET /liquidity-simulation/sessions/{session_id}/cycles/export` (signed simulated cycle export)
  - `GET /liquidity-simulation/sessions/{session_id}/receipts/export` (signed simulated receipt export)
  - simulation invariants:
    - all simulation responses include `simulation=true` and `simulation_session_id`
    - simulated sessions/cycles/receipts are isolated from production settlement and receipt chains

- `LiquidityInventory`
  - `POST /liquidity-providers/{provider_id}/inventory/snapshots` (record provider-scoped inventory snapshot)
  - `GET /liquidity-providers/{provider_id}/inventory/assets` (list current inventory holdings)
  - `GET /liquidity-providers/{provider_id}/inventory/availability` (project available vs reserved/in-settlement quantities)
  - `POST /liquidity-providers/{provider_id}/inventory/reservations` (batch reserve holdings with per-item deterministic outcomes)
  - `POST /liquidity-providers/{provider_id}/inventory/reservations/release` (batch release/transition reservations with per-item deterministic outcomes)
  - `GET /liquidity-providers/{provider_id}/inventory/reconciliation/export` (signed inventory reconciliation export)
  - inventory invariants:
    - one active reservation (`reserved|in_settlement`) per holding
    - reservation context binds provider, holding, and cycle
    - reconciliation export provides signed attestation/checkpoint continuity

- `LiquidityListings`
  - `POST /liquidity-providers/{provider_id}/listings` (upsert provider-owned LP listing intent with policy binding)
  - `POST /liquidity-providers/{provider_id}/listings/{intent_id}/cancel` (idempotent listing cancellation with deterministic reason code)
  - `GET /liquidity-providers/{provider_id}/listings` (list provider listings; optional `status` and `limit`)

- `LiquidityDecisions`
  - `POST /liquidity-providers/{provider_id}/proposals/{proposal_id}/accept` (record LP accept decision with mandatory explainability payload)
  - `POST /liquidity-providers/{provider_id}/proposals/{proposal_id}/decline` (record LP decline decision with mandatory explainability payload)
  - `GET /liquidity-providers/{provider_id}/decisions/{decision_id}` (read deterministic decision record)
  - decision invariants:
    - idempotency scope binds `provider_id + operation_id + proposal_id + idempotency_key`
    - decision writes require `decision_reason_codes[]`, `policy_ref`, `confidence_score_bps`, `risk_tier_snapshot`, and `correlation_id`
    - trust/safety policy outcomes are hard precedence; LP decisions are denied when no current `allow` policy decision exists
    - recorded decisions include intent/proposal/commit lineage for auditability

- `LiquidityExecution`
  - `POST /liquidity-providers/{provider_id}/execution-mode` (idempotent execution-mode upsert for `simulation|operator_assisted|constrained_auto`)
  - `GET /liquidity-providers/{provider_id}/execution-mode` (read effective execution mode, defaulting to `operator_assisted` in restricted contexts)
  - `POST /liquidity-providers/{provider_id}/execution-requests` (record operator-reviewed execution request with mode/risk snapshot)
  - `POST /liquidity-providers/{provider_id}/execution-requests/{request_id}/approve` (record explicit operator approval)
  - `POST /liquidity-providers/{provider_id}/execution-requests/{request_id}/reject` (record explicit operator rejection)
  - `GET /liquidity-providers/{provider_id}/execution-requests/export` (signed execution-request export with attestation/checkpoint continuity)
  - execution invariants:
    - restricted adapter contexts default to `operator_assisted`; `constrained_auto` requires explicit override policy records
    - high-risk/platform-blocked execution requests fail deterministically with stable reason codes
    - approval/rejection records require explicit operator actor + reason-code lineage
    - export continuation binds cursor/attestation/checkpoint continuity and query context

- `LiquidityPolicy`
  - `POST /liquidity-providers/{provider_id}/policies` (idempotent LP autonomy policy upsert)
  - `GET /liquidity-providers/{provider_id}/policies` (read effective LP autonomy policy)
  - `POST /liquidity-providers/{provider_id}/policies/evaluate` (deterministic LP policy evaluation for candidate execution context)
  - policy invariants:
    - precedence enforcement is deterministic: `safety>trust>lp_autonomy_policy>commercial>preference`
    - anti-farming floor includes spread/daily value/counterparty exposure/confidence/tier volatility constraints
    - policy writes and evaluations are provider-scoped and partner-owned

- `LiquidityDecisionAudit`
  - `GET /liquidity-providers/{provider_id}/decision-audit` (list deterministic LP decision-policy audit records)
  - `GET /liquidity-providers/{provider_id}/decision-audit/export` (signed audit export with continuation anchors)
  - audit invariants:
    - continuation binds `cursor_after`, `attestation_after`, and `checkpoint_after` with query-context continuity
    - export/list queries enforce deterministic retention and redaction hooks
    - invalid query anchors and context mismatch fail with stable reason codes

- `CycleProposal`
  - `GET /cycle-proposals` (list)
  - `GET /cycle-proposals/{id}`

Commit endpoints:
- `POST /cycle-proposals/{id}/accept`
- `POST /cycle-proposals/{id}/decline`
- `GET /commits/{id}`
  - delegated agents may read commit state under `commits:read` + delegation policy checks

Settlement endpoints:
- `POST /settlement/{cycle_id}/start`
  - accepts required `deposit_deadline_at` and optional `vault_bindings[]` (`intent_id`, `holding_id`, `reservation_id`)
  - vault-bound legs are marked deposited at start; if all legs are vault-bound, timeline starts at `escrow.ready`
  - mixed cycles are supported (vault-bound + manual deposit legs)
- `POST /settlement/{cycle_id}/deposit-confirmed`
  - manual deposits only; vault-bound legs reject manual deposit confirmation (`vault_backed_leg`)
- `POST /settlement/{cycle_id}/begin-execution`
- `POST /settlement/{cycle_id}/complete`
- `POST /settlement/{cycle_id}/expire-deposit-window`
- `GET /settlement/{cycle_id}/instructions`
- `GET /settlement/{cycle_id}/status`
  - partner reads on vault-backed cycles include `vault_reconciliation` (holding/leg reconciliation snapshot) and `state_transitions` (ordered `cycle.state_changed` projection)
- `GET /settlement/{cycle_id}/vault-reconciliation/export`
  - partner-only signed reconciliation export payload for vault-backed cycles (`export_hash` + detached signature)
  - supports optional pagination over reconciliation entries (`limit`, `cursor_after`)
  - continuation requires `attestation_after` when `cursor_after` is provided
  - when checkpoint mode is enabled (`SETTLEMENT_VAULT_EXPORT_CHECKPOINT_ENFORCE=1`), continuation also requires `checkpoint_after`
  - checkpoint anchors have retention controls (`SETTLEMENT_VAULT_EXPORT_CHECKPOINT_RETENTION_DAYS`) and expired anchors are rejected
  - optional partner-program enforcement (`SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE=1`) gates export entitlement and daily quota usage
  - optional rollout hooks: allowlist (`SETTLEMENT_VAULT_EXPORT_PARTNER_ALLOWLIST`) + minimum plan (`SETTLEMENT_VAULT_EXPORT_MIN_PLAN`)
  - optional freeze export overlay (`PARTNER_PROGRAM_ROLLOUT_POLICY_FREEZE_EXPORT_ENFORCE=1`) turns active rollout freeze windows into export gate failures (`partner_rollout_frozen`)
  - paginated responses include `total_filtered`, optional `next_cursor`, signed `attestation`, optional signed `checkpoint`, and optional `partner_program` usage metadata when program enforcement is active
- `GET /partner-program/vault-export`
  - partner self-serve read surface for vault export entitlement, quota usage, and rollout-policy visibility
  - includes rollout observability fields (`policy_source`, `policy_version`, `policy_updated_*`, `last_admin_action_*`)
  - includes operator overlay state `freeze_export_enforced` (from `PARTNER_PROGRAM_ROLLOUT_POLICY_FREEZE_EXPORT_ENFORCE=1`)
- `GET /partner-program/vault-export/rollout-policy`
  - returns the effective rollout policy contract (`source`, `allowlist`, `min_plan_id`, `version`, `updated_*`)
- `POST /partner-program/vault-export/rollout-policy`
  - partner-admin controlled rollout policy mutation (`allowlist`, `min_plan_id`), idempotent by key
  - writes deterministic policy-change audit entries
  - mutation is blocked during active freeze window (`partner_rollout_frozen`) unless controls are adjusted via admin action
- `POST /partner-program/vault-export/rollout-policy/admin-action`
  - partner-admin control surface for governance overlays:
    - maintenance mode on/off (`partner_rollout_maintenance_mode` gate on export path)
    - freeze window controls (`freeze_until`, `freeze_reason_code`)
    - clear/reset controls
  - writes signed-audit-compatible admin action records
- `GET /partner-program/vault-export/rollout-policy/diagnostics/export`
  - partner-admin signed diagnostics export for rollout control-plane state (`policy` + env overlays + runbook hooks)
  - includes lifecycle telemetry (`lifecycle_signals`) and deterministic operator alerts (`alerts`) for stale maintenance windows and freeze windows expiring soon
  - supports alert threshold tuning via query (`maintenance_stale_after_minutes`, `freeze_expiring_soon_minutes`)
  - supports optional automation planning payload (`automation_hints`) via query (`include_automation_hints=true`) with queue limit control (`automation_max_actions`)
  - automation hints include deterministic `action_requests[]` templates for `rollout_policy.admin_action` and require `include_runbook_hooks=true`
  - each action request includes a deterministic `request_hash`; the automation bundle includes `plan_hash` for downstream execution-plan integrity checks
  - action requests include deterministic `expected_effect` projections (policy version + control-state targets) for post-execution validation
  - automation bundle includes signed `execution_attestation` anchors (`expected_effect_hash`, `request_hash_chain`, `attestation_hash`) for downstream execution-result integrity checks
  - verifier enforces internal consistency of automation anchors (`plan_hash`, execution hash chains, and policy-version projection envelope) before signature acceptance
  - execution attestation includes continuation anchors (`continuation_attestation_after`, `continuation_checkpoint_after`, `continuation_hash`) to bind automation plans to signed continuation context
  - execution attestation also carries continuity-window + execution synthesis anchors (`continuation_window_minutes`, `continuation_expires_at`, `receipt_hash`, `journal_hash`, `rollback_hash`, `simulation_hash`)
  - provides deterministic operator action recommendations (`clear_maintenance_mode`, `clear_freeze_window`, or `none`)
  - includes runbook hook templates for `rollout_policy.admin_action`
  - supports optional compact mode via query flags (`include_recommended_actions`, `include_runbook_hooks`)
  - supports signed continuation via `attestation_after`
  - when diagnostics checkpoint mode is enabled (`PARTNER_PROGRAM_ROLLOUT_POLICY_DIAGNOSTICS_EXPORT_CHECKPOINT_ENFORCE=1`), continuation also requires `checkpoint_after`
  - diagnostics checkpoint anchors use retention controls (`PARTNER_PROGRAM_ROLLOUT_POLICY_DIAGNOSTICS_EXPORT_CHECKPOINT_RETENTION_DAYS`) and expired anchors are rejected
  - continuation failures return deterministic reason codes (`checkpoint_after_not_found`, `checkpoint_attestation_mismatch`, `checkpoint_query_mismatch`, `checkpoint_expired`)
- `GET /partner-program/vault-export/rollout-policy-audit/export`
  - partner-admin signed export of rollout policy-change/admin-action audit entries (`export_hash` + detached signature)
  - supports filter/pagination (`from_iso`, `to_iso`, `limit`, `cursor_after`)
  - paginated continuation requires `attestation_after` when `cursor_after` is provided
  - when checkpoint mode is enabled (`PARTNER_PROGRAM_ROLLOUT_POLICY_EXPORT_CHECKPOINT_ENFORCE=1`), continuation also requires `checkpoint_after`
  - checkpoint anchors have retention controls (`PARTNER_PROGRAM_ROLLOUT_POLICY_EXPORT_CHECKPOINT_RETENTION_DAYS`) and expired anchors are rejected
  - paginated responses include signed `attestation`, optional signed `checkpoint`, and optional `next_cursor`
- `POST /partner-program/commercial-usage`
  - idempotent partner-admin usage ledger write (`feature_code`, `unit_type`, `units`, unit price micros)
  - records deterministic ledger entries + running aggregate summary (`entries_count`, units, USD micros)
- `GET /partner-program/commercial-usage/export`
  - signed partner usage-ledger export (`ledger_summary`, entries, `export_hash`, detached signature)
  - supports optional range/filter query (`from_iso`, `to_iso`, `feature_code`, `unit_type`)
- `GET /partner-program/billing-statements/export`
  - signed deterministic billing/rev-share statement export (`lines`, totals, `export_hash`, detached signature)
  - supports period bounds + rev-share split query (`period_start_iso`, `period_end_iso`, `rev_share_partner_bps`)
- `POST /partner-program/sla-policy`
  - idempotent partner-admin SLA policy upsert (`latency_p95_ms`, availability target, dispute/SLA thresholds)
- `POST /partner-program/sla-breaches`
  - idempotent partner-admin SLA breach event recording (`event_type`, `severity`, `reason_code`, timestamps)
- `GET /partner-program/sla-breaches/export`
  - signed SLA breach export payload (policy snapshot + aggregate summary + events)
  - supports optional range filtering + resolved inclusion flag
- `GET /partner-program/dashboard/summary`
  - partner dashboard summary surface (usage last 24h, billing totals snapshot, open SLA breach counts)
- `POST /auth/oauth-clients`
  - partner OAuth client registration (redirect URIs + scopes) with deterministic client metadata response
- `POST /auth/oauth-clients/{client_id}/rotate`
  - idempotent OAuth client secret lifecycle rotation (`secret_version` increments)
- `POST /auth/oauth-clients/{client_id}/revoke`
  - idempotent OAuth client revocation (`status=revoked`, `revoked_at`)
- `POST /auth/oauth-token/introspect`
  - deterministic OAuth token introspection (`active`, reason code, scope envelope, issue/expiry timestamps)
- `POST /partner-program/webhook-delivery-attempts`
  - idempotent webhook delivery-attempt ledger write (`delivery_id`, attempt sequencing, retry policy metadata, deterministic dead-letter thresholding)
- `GET /partner-program/webhook-dead-letter/export`
  - signed dead-letter export surface (`summary`, paginated entries, `next_cursor`, `export_hash`, detached signature)
  - supports deterministic continuation (`limit`, `cursor_after`) and replay visibility filtering (`include_replayed`)
- `POST /partner-program/webhook-dead-letter/replay`
  - idempotent dead-letter replay/backfill workflow (`replay_mode=retry_now|backfill`) with deterministic replay metadata anchoring
- `POST /partner-program/risk-tier-policy`
  - idempotent partner-admin risk-tier policy mutation (`tier`, `escalation_mode`, write-throttle limit, blocked operations, manual-review operations)
- `GET /partner-program/risk-tier-policy`
  - partner-admin risk-tier policy read surface including current-hour write counters by operation
- `POST /partner-program/disputes`
  - idempotent dispute lifecycle create surface (typed dispute metadata + deterministic evidence-item envelopes)
- `POST /partner-program/disputes/{dispute_id}/resolve`
  - idempotent dispute resolution surface (resolution code/notes with terminal-state guardrails)
- `GET /partner-program/disputes/evidence-bundles/export`
  - signed dispute evidence-bundle export (`summary`, paginated bundles, `next_cursor`, `export_hash`, detached signature)
  - supports deterministic continuation (`limit`, `cursor_after`) and resolved/open filtering (`include_resolved`)
- `POST /adapters/steam/tier1/contract`
  - idempotent Steam Tier-1 adapter contract upsert surface (fixture-only integration profile for handoff)
- `GET /adapters/steam/tier1/contract`
  - read Steam Tier-1 adapter contract + deterministic preflight summary telemetry
- `POST /adapters/steam/tier1/preflight`
  - idempotent fixture preflight contract check (mode support, dry-run requirement, batch-size ceiling)
- `POST /adapters/tier2/capability`
  - idempotent Tier-2 adapter capability contract upsert surface for cross-ecosystem handoff
- `GET /adapters/tier2/capability`
  - read Tier-2 adapter capability contract + deterministic preflight summary telemetry
- `POST /adapters/tier2/preflight`
  - idempotent cross-ecosystem preflight contract check (ecosystem pairing, transfer primitive, route-hop ceilings, dry-run policy)
- `POST /adapters/cross/cycle-semantics`
  - idempotent cross-adapter cycle semantics declaration with explicit non-atomicity disclosure acceptance linked to Tier-2 preflight readiness
- `POST /adapters/cross/cycle-receipts`
  - idempotent signed cross-adapter cycle receipt recording (leg-level settlement outcomes + discrepancy code + compensation-required flag)
- `GET /adapters/cross/cycle-receipts`
  - read cross-adapter semantics/receipt projection for a cycle with deterministic signature-valid telemetry
- `POST /compensation/cross-adapter/cases`
  - idempotent cross-adapter compensation-case create contract for discrepancy outcomes requiring remediation
- `POST /compensation/cross-adapter/cases/update`
  - idempotent compensation-case lifecycle transition contract (`open`→`approved|rejected`→`resolved`) with deterministic transition guards
- `GET /compensation/cross-adapter/cases`
  - read compensation case projection by `case_id` or `cycle_id`
- `POST /compensation/cross-adapter/ledger/entries`
  - idempotent compensation-ledger entry recording contract (`payout|reversal|adjustment`) bound to payable case state
- `GET /compensation/cross-adapter/ledger/export`
  - signed paginated compensation-ledger export (`summary`, `entries`, `next_cursor`, `attestation`, `export_hash`, detached signature)
- `POST /compensation/dispute-linkages`
  - idempotent dispute-to-compensation linkage creation contract
- `POST /compensation/dispute-linkages/update`
  - idempotent linkage lifecycle transition contract (`linked`→`compensation_recorded`→`closed`) with deterministic guardrails
- `GET /compensation/dispute-linkages/export`
  - signed paginated dispute-compensation linkage export (`summary`, `linkages`, `next_cursor`, `attestation`, `export_hash`, detached signature)
- `POST /reliability/slo-metrics`
  - idempotent reliability SLO metric recording contract (availability/latency/error-budget windows)
- `POST /reliability/incident-drills`
  - idempotent reliability incident-drill evidence recording contract (drill type, severity, recovery-time target evidence)
- `POST /reliability/replay-checks`
  - idempotent replay-robustness/recovery verification contract (event-log hash parity + state-hash parity)
- `GET /reliability/conformance/export`
  - signed reliability conformance export (`summary`, `slo_metrics`, `incident_drills`, `replay_checks`, `export_hash`, detached signature)
- `POST /reliability/remediation-plans/suggest`
  - idempotent remediation-plan suggestion contract derived from reliability signal windows (`risk_level`, `priority_score`, `recommended_actions`, `blockers`)
- `GET /reliability/remediation-plans/export`
  - signed paginated remediation-plan export (`summary`, `plans`, `next_cursor`, `attestation`, `export_hash`, detached signature)
- `POST /staging/evidence-bundles`
  - idempotent staging evidence-manifest checkpoint recording contract (`manifest_hash`, checkpoint-chain anchors, runbook/conformance refs)
- `GET /staging/evidence-bundles/export`
  - signed paginated staging evidence export (`summary`, `bundles`, `next_cursor`, `attestation`, `checkpoint`, `export_hash`, detached signature)
  - continuation requires `checkpoint_after` when `cursor_after` is provided
- `POST /adapters/steam/tier1/live-proof/deposit-per-swap`
  - idempotent operator-gated live proof capture for Steam deposit-per-swap settlement evidence (`INTEGRATION_ENABLED=1` required)
- `POST /adapters/steam/tier1/live-proof/vault`
  - idempotent operator-gated live proof capture for Steam vault settlement lifecycle evidence (`deposit/reserve/release/withdraw`, `INTEGRATION_ENABLED=1` required)
- `POST /transparency-log/publications`
  - idempotent append-only publication surface linking settlement receipts and governance artifacts into a deterministic transparency chain
- `GET /transparency-log/publications/export`
  - signed transparency-log export (`summary`, paginated entries, `next_cursor`, `export_hash`, detached signature)
  - supports deterministic continuation (`limit`, `cursor_after`, `attestation_after`, `checkpoint_after`)
- `POST /inclusion-proof/linkages`
  - idempotent unified inclusion-proof linkage record (signed receipt + custody inclusion proof + transparency publication chain link)
- `GET /inclusion-proof/linkages/export`
  - signed inclusion-proof linkage export (`summary`, paginated `linkages`, `next_cursor`, `export_hash`, detached signature)
  - supports deterministic continuation (`limit`, `cursor_after`, `attestation_after`, `checkpoint_after`)

Receipt endpoints:
- `GET /receipts/{cycle_id}`

Delegation endpoints:
- `POST /delegations` (create a delegation grant)
- `GET /delegations/{id}`
- `POST /delegations/{id}/revoke`

Delegation read/write responses include:
- `delegation` (`DelegationGrant`)
- `delegation_token` (`sgdt1...`) suitable for `Authorization: Bearer ...` by the agent

Delegated-policy audit endpoints:
- `GET /policy-audit/delegated-writes` (user-scoped policy decision audit entries)
  - supports filters (`decision`, `operation_id`, `delegation_id`, `from_iso`, `to_iso`)
  - supports pagination (`limit`, `cursor_after`, response `next_cursor`)
  - applies retention window filtering in fixtures-first verification
- `GET /policy-audit/delegated-writes/export` (signed export for offline integrity verification)
  - supports list filters plus optional pagination (`limit`, `cursor_after`)
  - paginated continuation requires `attestation_after` to chain from the previous page attestation
  - when export-checkpoint mode is enabled, continuation also requires `checkpoint_after` (previous page checkpoint hash)
  - checkpoint continuation is statefully validated (checkpoint exists, cursor/attestation match, and filter context is unchanged)
  - checkpoint anchors have retention controls (`POLICY_AUDIT_EXPORT_CHECKPOINT_RETENTION_DAYS`) and expired anchors are rejected
  - response includes `export_hash` + detached `signature`
  - paginated responses include `next_cursor` + signed `attestation` (`page_hash`, `chain_hash`) for continuity verification
  - checkpoint mode adds `checkpoint` (`checkpoint_hash`) for chain compaction anchors
  - signature verifies export integrity against published policy-integrity signing keys

Vault lifecycle endpoints:
- `POST /vault/holdings/deposit` (user deposits a holding into vault state)
- `POST /vault/holdings/{holding_id}/reserve` (partner reserves an available vaulted holding)
- `POST /vault/holdings/{holding_id}/release` (partner releases a reservation)
- `POST /vault/holdings/{holding_id}/withdraw` (owner withdraws an available vaulted holding)
- `GET /vault/holdings/{holding_id}`
- `GET /vault/holdings`

Vault custody publication/read endpoints:
- `POST /vault/custody/snapshots` (partner publishes a custody snapshot root)
- `GET /vault/custody/snapshots` (snapshot catalog with cursor pagination)
- `GET /vault/custody/snapshots/{snapshot_id}`
- `GET /vault/custody/snapshots/{snapshot_id}/holdings/{holding_id}/proof`
  - proof responses include deterministic Merkle inclusion material for offline verification

Auth utility endpoints:
- `POST /auth/delegation-token/introspect` (evaluate delegation token activity in a deterministic contract)

Signing key endpoints:
- `GET /keys/policy-integrity-signing` (public keys for verifying consent-proof signatures and policy-audit export signatures)
- `GET /keys/delegation-token-signing` (public keys for verifying delegation-token signatures)
- `GET /keys/receipt-signing` (public keys for verifying `SwapReceipt.signature`)
- `GET /keys/event-signing` (public keys for verifying `EventEnvelope.signature`)

(Implementation remains fixtures-first for milestones; a local runtime HTTP shell is now available via `npm run start:api`.)

Runtime persistence controls (M112):
- `STATE_BACKEND=json|sqlite` selects the runtime persistence backend (default `json`).
- `STATE_FILE=<path>` overrides backend-specific default state path.
- `GET /healthz` includes `store_backend` and `persistence_mode` diagnostics (`json_file` or `sqlite_wal`).
- Deterministic migration/backup/restore tooling:
  - `node scripts/migrate-state-store.mjs --from-backend json --to-backend sqlite --force`
  - `node scripts/migrate-state-store.mjs --from-backend sqlite --to-backend json --to-state-file artifacts/runtime-backup.json --force`
  - `node scripts/migrate-json-state-to-sqlite.mjs --force`

Render deployment smoke hardening automation (M113, integration-gated):
- `node scripts/run-m113-render-smoke-hardening-scenario.mjs` automates:
  - Render service reuse/create,
  - persistent disk attachment,
  - env upsert (`STATE_BACKEND=sqlite`, `STATE_FILE=...`, `HOST=0.0.0.0`),
  - deploy/restart orchestration,
  - live smoke checks (`/healthz`, `swap-intents`, `marketplace/matching/runs`).
- Requires `INTEGRATION_ENABLED=1` and `RENDER_API_KEY`.
- Create-mode owner resolution:
  - auto-discovers owner via Render API when `RENDER_OWNER_ID` is not set,
  - supports `RENDER_OWNER_NAME` hint,
  - requires explicit `RENDER_OWNER_ID` when multiple owners are available and cannot be disambiguated.

## Webhooks (v1)
Partners can receive:
- `proposal.created`
- `proposal.expiring`
- `cycle.state_changed`
- `receipt.created`

Event envelope spec lives in `docs/spec/EVENTS.md`.
