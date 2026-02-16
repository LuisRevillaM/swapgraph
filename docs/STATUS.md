# Project Status — swapgraph

Last updated: 2026-02-16

## Autopilot
- Status: **spec hardening** (not approved)
- Canonical plan: `docs/source/LATEST.md` (v2.0)

## Milestones (progress)
- M0: ✅ bootstrap + verification harness
- M1: ✅ canonical primitives + JSON Schemas + examples (+ verifier)
- M2: ✅ API surface contract (manifest + request/response schemas + examples)
- M3: ✅ events contract (manifest + payload schemas) + replay proof
- M4: ✅ SwapIntent ingestion core (create/update/cancel/get/list) + idempotency + persistence proof
- M5: ✅ matching engine v1 (2–3 party cycles) + deterministic disjoint selection + schema-validated CycleProposals
- M6: ✅ proposal delivery fixtures (polling payload + webhook event outbox using M3 envelopes; includes duplicate event_id)
- M7: ✅ commit handshake v1 (accept/decline → ready) + reservation locks + idempotency replay + events outbox

- M8: ✅ accept-window expiry (cancel accept-phase commit after proposal expiry + release reservations)
- M9: ✅ settlement timeline simulator (deposit → escrow.ready → executing → receipt, plus deposit-timeout unwind)

## Next
- M10: tighten SettlementTimeline legs schema + add REST contract endpoints for settlement + receipts (manifest + examples + verifier)

## Notes
- We are intentionally building *fixtures-first* so verifiers are deterministic and do not require credentials.
- Real Steam settlement is an operator-gated integration milestone (`INTEGRATION_ENABLED=1`).
