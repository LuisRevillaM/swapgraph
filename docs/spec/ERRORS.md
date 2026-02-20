# Errors (v1)

Structured errors are part of the public contract.

## Shape
```json
{
  "correlation_id": "...",
  "error": {
    "code": "...",
    "message": "...",
    "details": {}
  }
}
```

Notes:
- In production, `correlation_id` is provided via the `X-Correlation-Id` response header.
- In fixtures-first verification (no HTTP layer yet), we include `correlation_id` in the JSON body as a stand-in for that header.

## Core codes
- `SCHEMA_INVALID`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `INSUFFICIENT_SCOPE`

- `CONSTRAINT_VIOLATION`
- `RESERVATION_CONFLICT`
- `PROPOSAL_EXPIRED`
- `IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH`
- `INTEGRATION_REQUIRED`

## Notes
- Keep messages safe (no secrets).
- `details` must be machine-readable.
- Delegated policy-audit, vault reconciliation export, and rollout diagnostics/audit export continuation may include deterministic `details.reason_code` values such as:
  - `checkpoint_after_not_found`
  - `checkpoint_cursor_mismatch`
  - `checkpoint_attestation_mismatch`
  - `checkpoint_query_mismatch`
  - `checkpoint_expired`
- Partner-program/commercial rollout enforcement reason codes include:
  - `partner_rollout_frozen` is also used as an export-path gate when `PARTNER_PROGRAM_ROLLOUT_POLICY_FREEZE_EXPORT_ENFORCE=1` and a freeze window is active.
  - `partner_program_missing`
  - `partner_feature_not_enabled`
  - `partner_quota_exceeded`
  - `partner_rollout_not_allowed`
  - `partner_plan_insufficient`
  - `partner_rollout_config_invalid`
  - `partner_admin_required`
  - `partner_rollout_allowlist_invalid`
  - `partner_rollout_min_plan_invalid`
  - `partner_rollout_frozen`
  - `partner_rollout_maintenance_mode`
  - `partner_rollout_admin_action_invalid`
  - `partner_rollout_diagnostics_threshold_invalid`
  - `partner_rollout_diagnostics_automation_invalid`
  - `partner_rollout_diagnostics_automation_requires_runbook_hooks`
- Commercial governance / SLA / OAuth / webhook reliability reason codes include:
  - `partner_commercial_usage_invalid`
  - `partner_commercial_usage_export_query_invalid`
  - `partner_billing_statement_export_query_invalid`
  - `partner_sla_policy_invalid`
  - `partner_sla_breach_invalid`
  - `partner_sla_breach_export_query_invalid`
  - `oauth_client_registration_invalid`
  - `oauth_client_id_required`
  - `oauth_client_not_active`
  - `oauth_token_required`
  - `partner_webhook_attempt_invalid`
  - `partner_webhook_attempt_invalid_timestamp`
  - `partner_webhook_attempt_error_required`
  - `partner_webhook_attempt_sequence_invalid`
  - `partner_webhook_dead_letter_export_query_invalid`
  - `webhook_dead_letter_cursor_not_found`
  - `partner_webhook_dead_letter_replay_invalid`
  - `partner_webhook_dead_letter_replay_invalid_timestamp`
  - `partner_webhook_not_dead_letter`
  - `partner_risk_tier_policy_invalid`
  - `partner_risk_tier_policy_invalid_timestamp`
  - `partner_risk_tier_policy_query_invalid`
  - `risk_tier_blocked_operation`
  - `risk_tier_manual_review_required`
  - `risk_tier_throttle_exceeded`
  - `partner_dispute_invalid`
  - `partner_dispute_invalid_timestamp`
  - `partner_dispute_id_required`
  - `partner_dispute_resolution_invalid`
  - `partner_dispute_resolution_invalid_timestamp`
  - `partner_dispute_not_open`
  - `partner_dispute_evidence_export_query_invalid`
  - `partner_dispute_evidence_cursor_not_found`
  - `steam_adapter_contract_invalid`
  - `steam_adapter_contract_invalid_timestamp`
  - `steam_adapter_contract_query_invalid`
  - `steam_adapter_contract_missing`
  - `steam_adapter_preflight_invalid`
  - `steam_adapter_preflight_invalid_timestamp`
  - `steam_adapter_settlement_mode_unsupported`
  - `steam_adapter_dry_run_required`
  - `steam_adapter_batch_size_exceeded`
  - `adapter_tier2_capability_invalid`
  - `adapter_tier2_capability_invalid_timestamp`
  - `adapter_tier2_capability_query_invalid`
  - `adapter_tier2_capability_missing`
  - `adapter_tier2_preflight_invalid`
  - `adapter_tier2_preflight_invalid_timestamp`
  - `adapter_tier2_ecosystem_mismatch`
  - `adapter_tier2_transfer_primitive_unsupported`
  - `adapter_tier2_route_hops_exceeded`
  - `adapter_tier2_dry_run_required`
  - `cross_adapter_semantics_invalid`
  - `cross_adapter_semantics_invalid_timestamp`
  - `cross_adapter_semantics_preflight_not_ready`
  - `cross_adapter_receipt_invalid`
  - `cross_adapter_receipt_invalid_timestamp`
  - `cross_adapter_receipt_query_invalid`
  - `cross_adapter_receipt_semantics_missing`
  - `cross_adapter_receipt_disclosure_missing`
  - `cross_adapter_receipt_settlement_receipt_not_found`
  - `cross_adapter_receipt_settlement_signature_invalid`
  - `cross_adapter_compensation_case_invalid`
  - `cross_adapter_compensation_case_invalid_timestamp`
  - `cross_adapter_compensation_case_discrepancy_missing`
  - `cross_adapter_compensation_cross_receipt_signature_invalid`
  - `cross_adapter_compensation_case_exists`
  - `cross_adapter_compensation_case_not_found`
  - `cross_adapter_compensation_transition_invalid`
  - `cross_adapter_compensation_query_invalid`
  - `cross_adapter_compensation_ledger_invalid`
  - `cross_adapter_compensation_ledger_invalid_timestamp`
  - `cross_adapter_compensation_case_not_payable`
  - `cross_adapter_compensation_ledger_amount_exceeds_approved`
  - `cross_adapter_compensation_ledger_export_query_invalid`
  - `cross_adapter_compensation_ledger_cursor_not_found`
  - `reliability_slo_metric_invalid`
  - `reliability_slo_metric_invalid_timestamp`
  - `reliability_incident_drill_invalid`
  - `reliability_incident_drill_invalid_timestamp`
  - `reliability_replay_check_invalid`
  - `reliability_replay_check_invalid_timestamp`
  - `reliability_conformance_export_query_invalid`
  - `replay_log_hash_mismatch`
  - `recovery_state_hash_mismatch`
  - `steam_live_proof_invalid`
  - `steam_live_proof_invalid_timestamp`
  - `steam_live_proof_integration_disabled`
  - `steam_live_proof_contract_missing`
  - `steam_live_proof_contract_unsupported_mode`
  - `steam_live_proof_requires_live_mode`
  - `steam_live_proof_vault_invalid`
  - `steam_live_proof_vault_lifecycle_incomplete`
  - `transparency_log_publication_invalid`
  - `transparency_log_publication_invalid_timestamp`
  - `transparency_log_previous_root_mismatch`
  - `transparency_log_export_query_invalid`
  - `transparency_log_export_invalid_timestamp`
  - `transparency_log_export_cursor_not_found`
  - `checkpoint_after_not_found`
  - `checkpoint_expired`
  - `checkpoint_cursor_mismatch`
  - `checkpoint_attestation_mismatch`
  - `checkpoint_query_mismatch`
  - `inclusion_linkage_invalid`
  - `inclusion_linkage_invalid_timestamp`
  - `inclusion_linkage_receipt_not_found`
  - `inclusion_linkage_receipt_signature_invalid`
  - `inclusion_linkage_custody_snapshot_not_found`
  - `inclusion_linkage_custody_holding_not_found`
  - `inclusion_linkage_custody_proof_invalid`
  - `inclusion_linkage_transparency_publication_not_found`
  - `inclusion_linkage_transparency_artifact_missing`
  - `inclusion_linkage_export_query_invalid`
  - `inclusion_linkage_export_invalid_timestamp`
  - `inclusion_linkage_export_cursor_not_found`
- Rollout diagnostics automation execution-attestation verification may return deterministic mismatch errors such as:
  - `automation_execution_expected_effect_hash_mismatch`
  - `automation_execution_request_hash_chain_mismatch`
  - `automation_execution_attestation_hash_mismatch`
  - `automation_execution_continuation_hash_mismatch`
  - `automation_execution_continuation_window_minutes_mismatch`
  - `automation_execution_continuation_expires_at_mismatch`
  - `automation_execution_receipt_hash_mismatch`
  - `automation_execution_journal_hash_mismatch`
  - `automation_execution_rollback_hash_mismatch`
  - `automation_execution_simulation_hash_mismatch`
