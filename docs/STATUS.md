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

## Next
- M5: matching engine v1 (2–3 party cycles) on deterministic fixtures → CycleProposals + explainability + disjoint selection

## Notes
- We are intentionally building *fixtures-first* so verifiers are deterministic and do not require credentials.
- Real Steam settlement is an operator-gated integration milestone (`INTEGRATION_ENABLED=1`).
