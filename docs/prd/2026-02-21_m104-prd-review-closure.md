# M104 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Draft for approval (PRD-only mode)

Purpose: close simulation-boundary decisions so swarm behavior can be validated without mixing simulated and real custody flows.

## Decision D1 — Simulation isolation boundary
- **Question:** should simulation share canonical receipt/transparency chains with real flows?
- **Recommendation:** no; simulation outputs must be cryptographically and structurally isolated from real receipt/transparency chains.
- **Approval needed:** yes.

## Decision D2 — API parity requirement
- **Question:** can simulation write directly to internal store for speed?
- **Recommendation:** no DB shortcuts; simulation actions must flow through explicit API contracts.
- **Rationale:** preserves production-parity behavior and cross-agent reproducibility.
- **Approval needed:** yes.

## Decision D3 — Session lifecycle model
- **Question:** minimal lifecycle for simulation sessions.
- **Recommendation:** `start -> active -> stopped`, with idempotent stop semantics and deterministic terminal export behavior.
- **Approval needed:** yes.

## Decision D4 — Labeling and disclosure
- **Question:** how should simulated artifacts be marked?
- **Recommendation:** all simulation payloads include `simulation=true` + `simulation_session_id`; UI surfaces must clearly label simulation mode.
- **Approval needed:** yes.

## Decision D5 — Event taxonomy
- **Question:** should simulation events be separate types?
- **Recommendation:** yes; use dedicated simulation-prefixed event types to avoid accidental production-consumer handling.
- **Approval needed:** yes.

## Decision D6 — Export integrity posture
- **Question:** must simulation exports still be signed/continuity-verifiable?
- **Recommendation:** yes, keep signed deterministic continuity even in simulation to preserve verifier discipline.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M104 surfaces.
- **Recommendation:**
  - `liquidity_simulation_invalid`
  - `liquidity_simulation_session_not_found`
  - `liquidity_simulation_session_inactive`
  - `liquidity_simulation_payload_invalid`
  - `liquidity_simulation_export_query_invalid`
- **Approval needed:** yes.

## PRD approval gate (M104)
M104 is ready for implementation planning only when D1–D7 are explicitly approved or amended.
