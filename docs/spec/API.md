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
- `POST /settlement/{cycle_id}/deposit-confirmed`
- `POST /settlement/{cycle_id}/begin-execution`
- `POST /settlement/{cycle_id}/complete`
- `POST /settlement/{cycle_id}/expire-deposit-window`
- `GET /settlement/{cycle_id}/instructions`
- `GET /settlement/{cycle_id}/status`

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
  - response includes `export_hash` + detached `signature`
  - paginated responses include `next_cursor` + signed `attestation` (`page_hash`, `chain_hash`) for continuity verification
  - checkpoint mode adds `checkpoint` (`checkpoint_hash`) for chain compaction anchors
  - signature verifies export integrity against published policy-integrity signing keys

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
