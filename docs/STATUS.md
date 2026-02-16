# Project Status — swapgraph

Last updated: 2026-02-16

## Autopilot
- Status: **spec hardening** (not approved)
- Canonical plan: `docs/source/LATEST.md` (v2.0)

## Current milestone
- M0 is implemented (bootstrap + verification harness) and passes locally.
- Next: M1–M3 spec+contracts so execution can be run as: implement → verify → artifact → repeat.

## Notes
- We are intentionally building *fixtures-first* so verifiers are deterministic and do not require credentials.
- Real Steam settlement is an operator-gated integration milestone (`INTEGRATION_ENABLED=1`).
