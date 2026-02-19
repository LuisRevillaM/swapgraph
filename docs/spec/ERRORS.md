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
