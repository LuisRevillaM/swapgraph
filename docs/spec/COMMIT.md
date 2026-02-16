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

## Expiry (accept window)
- `CycleProposal.expires_at` defines the **acceptance window**.
- If a commit is still in `phase=accept` after `expires_at`, the system must:
  - set `commit.phase=cancelled`,
  - release reservations for all intents in the proposal,
  - emit `intent.unreserved` events,
  - emit a `cycle.state_changed` event to `failed` with `reason_code=proposal_expired`.
- If a commit is already `phase=ready`, it is **not** cancelled by acceptance-window expiry (it proceeds to settlement deadlines in later milestones).

## Idempotency
- Accept/decline are idempotent under `Idempotency-Key`.
