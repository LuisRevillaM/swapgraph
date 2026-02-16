# Errors (v1)

Structured errors are part of the public contract.

## Shape
```json
{
  "error": {
    "code": "...",
    "message": "...",
    "details": {}
  }
}
```

## Core codes
- `SCHEMA_INVALID`
- `CONSTRAINT_VIOLATION`
- `RESERVATION_CONFLICT`
- `PROPOSAL_EXPIRED`
- `IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH`
- `INTEGRATION_REQUIRED`

## Notes
- Keep messages safe (no secrets).
- `details` must be machine-readable.
