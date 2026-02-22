# M110 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Approved and implementation-closed (fixtures-first)

Purpose: close transparency and user-control decisions so LP participation is trustworthy and user-governable.

## Decision D1 — Disclosure strictness
- **Question:** can LP counterparties appear without explicit labels?
- **Decision:** no; explicit LP disclosure is mandatory for proposal, receipt, and directory surfaces.
- **Status:** approved + implemented.

## Decision D2 — User-control default posture
- **Question:** what is default behavior for bot/house/partner LP matching controls?
- **Decision:** explicit controls for `allow_bots`, `allow_house_liquidity`, `allow_partner_lp`; defaults documented and reversible.
- **Status:** approved + implemented.

## Decision D3 — Preference conflict behavior
- **Question:** if user controls exclude LPs and no eligible path remains, what happens?
- **Decision:** deterministic no-match/filtered-result behavior with explicit reason signaling; no silent overrides.
- **Status:** approved + implemented.

## Decision D4 — Counterparty disclosure payload floor
- **Question:** minimum disclosure fields in proposal/receipt projections.
- **Decision:** require provider type, automation disclosure, persona/strategy summary ref, and decision rationale summary link.
- **Status:** approved + implemented.

## Decision D5 — Directory boundary model
- **Question:** directory should expose full internals or public-safe profile subset?
- **Decision:** public-safe profile subset with explicit privacy boundaries; operational internals remain non-contractual.
- **Status:** approved + implemented.

## Decision D6 — Opt-out guarantee scope
- **Question:** should users always be able to opt out of LP counterparties?
- **Decision:** yes at contract level, with deterministic disclosures when market constraints reduce matching opportunities.
- **Status:** approved + implemented.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M110 surfaces.
- **Decision:**
  - `counterparty_preferences_invalid`
  - `counterparty_preferences_invalid_timestamp`
  - `counterparty_preferences_conflict`
  - `liquidity_directory_query_invalid`
  - `counterparty_disclosure_not_found`
- **Status:** approved + implemented.

## Implementation closure gate (M110)
M110 implementation closure is achieved when:
- `node verify/runner.mjs milestones/M110.yaml` returns `overall=true`.
- Canonical output hash is locked in `fixtures/release/m110_expected.json` and artifacts are published under `artifacts/milestones/M110/latest/*`.
