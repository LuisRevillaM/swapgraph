# SwapGraph — Spec gaps / decisions log

This document converts the v1.3 plan into a **decision list**. Items here should become:
- explicit spec text (docs/spec/*), and/or
- milestone acceptance criteria (docs/prd/Mx.md), and/or
- automated verification (verify/mx.* + artifacts).

## P0 (must decide before we build real Steam settlement)

1) **Steam auth & inventory access reality check**
- Plan says “Steam OAuth”. In practice we likely use Steam **OpenID** for login + a **Steam Web API key** (or other mechanism) for inventory.
- Spec needed: exact auth flow, token storage, refresh/expiry, and what “verification_health” means.

2) **Escrow operations model**
- Single escrow identity vs multiple escrow bots (scaling + blast radius).
- 2FA / mobile confirmations operational handling.
- Rate limits, device isolation, incident playbooks, and key rotation expectations.

3) **Atomicity semantics (define what we promise)**
- “Everyone trades or nobody trades” must be translated into *protocol guarantees* vs *platform realities*.
- Spec needed: what constitutes “partial release”, how we detect it, and the exact unwind + dispute escalation.

4) **Trade holds / locks policy for MVP**
- Plan: exclude OR support with longer timelines.
- If we exclude: define exactly how we detect holds and which items are disallowed.
- If we include: define UI + timeouts + how it affects cycle scoring/confidence.

5) **Pricing sources & confidence**
- Spec needed: pricing sources (Steam market? third-party?), refresh cadence, and “confidence_score” meaning.
- Define how pricing affects: cycle scoring, UI spread disclosure, and fraud detection.

## P1 (must decide before matching engine becomes “real”) 

6) **Want Spec JSON schema (v1)**
- Category taxonomy for CS2/Dota/TF2 (what’s a “knife finish”?), attribute constraints (wear/float/pattern/stickers), and exact validation rules.

7) **Bundles**
- Listing supports `offer_items[]` (multi-item bundles). Decide whether MVP supports bundles or restrict to single-asset listings.

8) **Cycle length policy**
- MVP says max length=3. Confirm whether we *only* propose 3-cycles, or allow 2-cycles when available.

9) **Reservation/exclusivity semantics**
- Plan describes reserving listings during proposal windows.
- Spec needed: reservation TTL, collision handling, and idempotency keys for accept/decline.

10) **Determinism and fairness**
- Define the seeded ordering rules and the “age bonus” function.
- Verification target: deterministic cycle selection given the same inputs.

## P2 (should decide for trust/safety + monetization correctness)

11) **Reliability score formula & tiers**
- Plan lists ingredients; spec needs: formula, decay windows, and thresholds for risk tiers.

12) **Dispute evidence requirements**
- Define required receipt artifacts, log retention, and what counts as “platform proof”.

13) **Limits and compliance boundaries**
- Define caps (max value, daily swaps) and escalation conditions.
- Decide whether/when stronger verification (KYC-like) is needed (jurisdiction-dependent).

14) **Fees & fee allocation**
- How are fees computed? per cycle vs per leg? who pays? rounding/min fee.

15) **Boost semantics guardrails**
- How boosts interact with fairness + anti-pay-to-win; hard constraints boosts cannot override.

16) **Notification defaults & preferences**
- Email defaults vs opt-in; Discord bot integration scope; frequency caps.

## “Spec-able UX” gaps (to keep delight intact)

17) **Wireframe-grade field specs**
- For each MVP screen: exact fields, empty states, error states, and required copy.

18) **Copy deck**
- Canonical microcopy for each cycle state, especially failure/unwind.

19) **Receipts as shareable proof**
- Define what is shareable by default vs opt-in, and redaction rules.

---

## Verification mapping idea (how we make this real)

For each milestone Mx we will require:
- `docs/prd/Mx.md` (what we’re building + acceptance)
- `milestones/Mx.yaml` (commands + required artifacts)
- `verify/mx.sh` (creates `artifacts/milestones/Mx/latest/*`)

Integration-required milestones will exit non-zero unless `INTEGRATION_ENABLED=1` (operator proof gate), matching the pattern we used elsewhere in this workspace.
