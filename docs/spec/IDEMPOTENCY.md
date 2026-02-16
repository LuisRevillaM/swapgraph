# Idempotency (v1)

SwapGraph APIs are designed for retries.

## Requirements
- Every mutating request MUST provide an `Idempotency-Key`.
- A repeated request with the same idempotency key MUST:
  - return the same result (success) OR
  - return a deterministic conflict error if the payload differs.

## Scope
Idempotency keys are scoped by:
- actor (user/partner/agent identity)
- endpoint (operation)

## Conflict rule
If the same idempotency key is reused with a different request body, the API returns:
- `error.code = IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH`
- includes hashes of the original and new payloads.

## Verification
- M3 includes scenario tests proving accept/decline idempotency.
