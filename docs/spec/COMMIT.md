# Commit handshake (v1)

SwapGraph uses a two-phase commit to move from **proposal** → **ready for settlement**.

## Objects
- `CycleProposal`: output of matching
- `Commit`: acceptance state for a proposal

## Phase 1 — Accept/Decline
- Each participant may accept or decline.
- On first accept, the system reserves all intents in the proposal.

## Phase 2 — Ready
- Once all participants accept, `commit.phase = ready`.

## Reservation invariant
- Only one active reservation per intent.
- A reservation conflict returns `RESERVATION_CONFLICT`.

## Idempotency
- Accept/decline are idempotent under `Idempotency-Key`.
