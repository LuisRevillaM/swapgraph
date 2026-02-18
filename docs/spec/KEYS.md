# Signing keys (v1)

SwapGraph signs certain artifacts so partners/users can verify integrity **offline**.

## Policy-integrity signing keys
Policy-integrity signatures cover:
- signed consent proofs (`consent_proof`, prefix `sgcp2.`)
- delegated policy-audit export envelopes (`/policy-audit/delegated-writes/export`)
- paginated export attestations (`attestation.page_hash`, `attestation.chain_hash`)
- export checkpoint anchors (`checkpoint.checkpoint_hash`)

### Publication
Policy-integrity public keys are published via:
- `GET /keys/policy-integrity-signing`

See:
- schema: `docs/spec/schemas/PolicyIntegritySigningKeysGetResponse.schema.json`
- example: `docs/spec/examples/api/keys.policy_integrity_signing.get.response.json`

### Rotation contract
The key-set response includes:
- `active_key_id`: key used for minting new signatures
- `keys[].status`:
  - `active` for current minting key
  - `verify_only` for still-published historical keys

### Algorithms
- v1 uses `alg = "ed25519"`.

### Fixtures-first note
In this repo (fixtures-first), we include non-production dev keypairs under:
- `fixtures/keys/policy_integrity_signing_dev_pi_k1_{public,private}.pem`
- `fixtures/keys/policy_integrity_signing_dev_pi_k2_{public,private}.pem`

Production deployments must **not** ship with these fixture keys.

## Receipt signing keys
`SwapReceipt.signature` is produced by SwapGraph and must be verifiable by any consumer.

### Publication
The receipt signing public keys are published via:
- `GET /keys/receipt-signing`

The response is a **key set** (to support rotation):
- multiple keys may be returned
- consumers choose the key matching `receipt.signature.key_id`

### Key set shape (v1)
See:
- schema: `docs/spec/schemas/ReceiptSigningKeysGetResponse.schema.json`
- example: `docs/spec/examples/api/keys.receipt_signing.get.response.json`

### Algorithms
- v1 uses `alg = "ed25519"`.

### Fixtures-first note
In this repo (fixtures-first), we include a non-production dev keypair under:
- `fixtures/keys/receipt_signing_dev_k1_{public,private}.pem`

This enables deterministic signing + verification in milestone proofs.
Production deployments must **not** ship with these fixture keys.

## Event signing keys
`EventEnvelope.signature` is produced by SwapGraph and must be verifiable by any consumer.

### Publication
Event signing public keys are published via:
- `GET /keys/event-signing`

See:
- schema: `docs/spec/schemas/EventSigningKeysGetResponse.schema.json`
- example: `docs/spec/examples/api/keys.event_signing.get.response.json`

### Algorithms
- v1 uses `alg = "ed25519"`.

### Fixtures-first note
In this repo (fixtures-first), we include a non-production dev keypair under:
- `fixtures/keys/event_signing_dev_ev_k1_{public,private}.pem`

This enables deterministic signing + verification in milestone proofs.
Production deployments must **not** ship with these fixture keys.

## Delegation-token signing keys
`DelegationToken.signature` is produced by SwapGraph and must be verifiable by any token consumer.

### Publication
Delegation-token signing public keys are published via:
- `GET /keys/delegation-token-signing`

See:
- schema: `docs/spec/schemas/DelegationTokenSigningKeysGetResponse.schema.json`
- example: `docs/spec/examples/api/keys.delegation_token_signing.get.response.json`

### Rotation contract
The key-set response includes:
- `active_key_id`: key used for minting new delegation tokens
- `keys[].status`:
  - `active` for current minting key
  - `verify_only` for still-published historical keys

Consumers verify by `DelegationToken.signature.key_id`.
This keeps previously issued tokens verifiable during rotation windows.

### Algorithms
- v1 uses `alg = "ed25519"`.

### Fixtures-first note
In this repo (fixtures-first), we include non-production dev keypairs under:
- `fixtures/keys/delegation_token_signing_dev_dt_k1_{public,private}.pem`
- `fixtures/keys/delegation_token_signing_dev_dt_k2_{public,private}.pem`

Production deployments must **not** ship with these fixture keys.
