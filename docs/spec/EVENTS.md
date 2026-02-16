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

## Delivery semantics
- At-least-once delivery.
- Consumers must de-duplicate by `event_id`.

## Replay
- A consumer can request replay from a checkpoint.
- Checkpoint format (v1): `{ "last_event_id": "..." }`.

## Event types (initial)
- `proposal.created`
- `proposal.expiring`
- `cycle.state_changed`
- `receipt.created`
- `intent.reserved`
- `intent.unreserved`

## Verification
- M3 produces an append-only event log and demonstrates replay into a reconstructed state.
