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
