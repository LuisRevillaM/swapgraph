# M110 PRD Review Closure — Decision Checklist

Date: 2026-02-21
Status: Draft for approval (PRD-only mode)

Purpose: close transparency and user-control discovery decisions so LP participation is trustworthy and user-governable.

## Decision D1 — Disclosure strictness
- **Question:** can LP counterparties appear without explicit labels?
- **Recommendation:** no; explicit LP disclosure is mandatory for proposal, receipt, and directory surfaces.
- **Approval needed:** yes.

## Decision D2 — User-control default posture
- **Question:** what is default behavior for bot/house/partner LP matching controls?
- **Recommendation:** start with explicit controls for `allow_bots`, `allow_house_liquidity`, `allow_partner_lp`; defaults must be documented and reversible.
- **Approval needed:** yes.

## Decision D3 — Preference conflict behavior
- **Question:** if user controls exclude LPs and no eligible path remains, what happens?
- **Recommendation:** deterministic no-match/filtered-result behavior with explicit reason signaling; no silent overrides.
- **Approval needed:** yes.

## Decision D4 — Counterparty disclosure payload floor
- **Question:** minimum disclosure fields in proposal/receipt projections.
- **Recommendation:** require provider type, automation disclosure, persona/strategy summary ref, and decision rationale summary link.
- **Approval needed:** yes.

## Decision D5 — Directory boundary model
- **Question:** directory should expose full internals or public-safe profile subset?
- **Recommendation:** public-safe profile subset with explicit privacy boundaries; operational internals remain non-contractual.
- **Approval needed:** yes.

## Decision D6 — Opt-out guarantee scope
- **Question:** should users always be able to opt out of LP counterparties?
- **Recommendation:** yes at contract level, with deterministic disclosures when market constraints reduce matching opportunities.
- **Approval needed:** yes.

## Decision D7 — Canonical reason-code floor
- **Question:** minimum deterministic reason-code set for M110 surfaces.
- **Recommendation:**
  - `counterparty_preferences_invalid`
  - `counterparty_preferences_invalid_timestamp`
  - `counterparty_preferences_conflict`
  - `liquidity_directory_query_invalid`
  - `counterparty_disclosure_not_found`
- **Approval needed:** yes.

## PRD approval gate (M110)
M110 is ready for implementation planning only when D1–D7 are explicitly approved or amended.
