# Signing keys (v1)

SwapGraph signs certain artifacts so partners/users can verify integrity **offline**.

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
