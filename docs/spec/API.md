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
- Users authenticate with SwapGraph sessions.
- Agents authenticate via delegation tokens (later milestone).

(M2/M3 define the concrete header fields/scopes; this doc is the contract anchor.)

## Headers
- `Idempotency-Key` (required for mutating endpoints)
- `X-Correlation-Id` (optional on request; always present in responses)

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

Commit endpoints are introduced in the commit milestone.

## Webhooks (v1)
Partners can receive:
- `proposal.created`
- `proposal.expiring`
- `cycle.state_changed`
- `receipt.created`

Event envelope spec lives in `docs/spec/EVENTS.md`.
