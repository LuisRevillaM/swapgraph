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

(Implementation is fixtures-first; server transport comes later.)

## Webhooks (v1)
Partners can receive:
- `proposal.created`
- `proposal.expiring`
- `cycle.state_changed`
- `receipt.created`

Event envelope spec lives in `docs/spec/EVENTS.md`.
