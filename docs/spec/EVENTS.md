# Events: webhooks + streams (v1)

SwapGraph is event-driven.

## Event envelope
Every event is wrapped in an envelope with:
- `event_id`
- `type`
- `occurred_at`
- `correlation_id`
- `actor`
- `payload`
- `signature`

## Delivery semantics
- At-least-once delivery.
- Consumers must de-duplicate by `event_id`.

## Event signing (v1)
Events are signed by SwapGraph.

- `EventEnvelope.signature` is an Ed25519 signature over:
  - `canonical_json(EventEnvelope without signature)`
- Consumers should:
  - verify the signature before applying an event
  - de-duplicate by `event_id` to prevent replay side-effects

Key publication:
- `GET /keys/event-signing`

## Replay
- A consumer can request replay from a checkpoint.
- Checkpoint format (v1): `{ "last_event_id": "..." }`.

## Event types (initial)
- `proposal.created`
- `proposal.expiring`
- `cycle.state_changed`
- `intent.reserved`
- `intent.unreserved`

Settlement-specific (additive; emitted alongside `cycle.state_changed`):
- `settlement.deposit_required`
- `settlement.deposit_confirmed`
- `settlement.executing`

Terminal receipt:
- `receipt.created`

## Verification
- M3 produces an append-only event log and demonstrates replay into a reconstructed state.
