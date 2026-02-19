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
- Delegated policy-audit and vault reconciliation export continuation may include deterministic `details.reason_code` values such as:
  - `checkpoint_after_not_found`
  - `checkpoint_cursor_mismatch`
  - `checkpoint_attestation_mismatch`
  - `checkpoint_query_mismatch`
  - `checkpoint_expired`
- Partner-program/commercial rollout enforcement reason codes include:
  - `partner_program_missing`
  - `partner_feature_not_enabled`
  - `partner_quota_exceeded`
  - `partner_rollout_not_allowed`
  - `partner_plan_insufficient`
  - `partner_rollout_config_invalid`
