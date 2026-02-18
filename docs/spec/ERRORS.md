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
- Delegated policy-audit export continuation may include deterministic `details.reason_code` values such as:
  - `checkpoint_after_not_found`
  - `checkpoint_cursor_mismatch`
  - `checkpoint_attestation_mismatch`
  - `checkpoint_query_mismatch`
  - `checkpoint_expired`
