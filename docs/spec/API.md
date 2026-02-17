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
- Partners authenticate with an API key (placeholder for now).
  - The key resolves to a stable, server-assigned `partner_id` (modeled as `ActorRef { type:"partner", id:"<partner_id>" }`).
  - `partner_id` is used for multi-tenant scoping (partners cannot read other partners’ cycles or proposals).
- Users authenticate with SwapGraph sessions.
- Agents authenticate via delegation tokens (later milestone).

(M2/M3 define the concrete header fields/scopes; this doc is the contract anchor.)

## Headers
- `Idempotency-Key` (required for mutating endpoints)
- `X-Correlation-Id` (optional on request; always present in responses)
  - Note: in fixtures-first verification, settlement/receipt read responses also include `correlation_id` in the JSON body as a stand-in for the response header.

## Resources (v1)
- `SwapIntent`
  - `POST /swap-intents` (create)
  - `PATCH /swap-intents/{id}` (update)
  - `POST /swap-intents/{id}/cancel`
  - `GET /swap-intents/{id}`
  - `GET /swap-intents` (list)

- `CycleProposal`
  - `GET /cycle-proposals` (list)
  - `GET /cycle-proposals/{id}`

Commit endpoints:
- `POST /cycle-proposals/{id}/accept`
- `POST /cycle-proposals/{id}/decline`
- `GET /commits/{id}`

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

(Implementation is fixtures-first; server transport comes later.)

## Webhooks (v1)
Partners can receive:
- `proposal.created`
- `proposal.expiring`
- `cycle.state_changed`
- `receipt.created`

Event envelope spec lives in `docs/spec/EVENTS.md`.
