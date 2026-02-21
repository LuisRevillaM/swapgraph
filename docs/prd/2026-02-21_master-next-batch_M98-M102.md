# SwapGraph Next Batch Forecast (M98–M102)

Date: 2026-02-21

Goal: define the post-M97 milestone tranche so all remaining v2 plan areas are PRD-scoped before official development starts.

## Batch intent
- Keep fixtures-first, deterministic, verifier-gated execution.
- Convert remaining v2 plan areas into explicit milestone definitions.
- Use two PRD depth levels:
  - **Implementation-ready PRD**: full contract + verifier acceptance.
  - **Discovery-first PRD**: explicit scope, constraints, and acceptance to unblock official build without ambiguity.

## M98 — API + event surface completion contracts (implementation-ready)
- Close remaining illustrative v2 API/event coverage gaps as explicit contracts.
- Target: `platform-connections`, `inventory snapshots/assets`, canonical disputes facade, and missing event types (`proposal.cancelled`, `cycle.failed`, `user.reliability_changed`).

## M99 — Trust & safety risk-signal contracts (implementation-ready)
- Add deterministic fraud/ATO risk-signal recording and decision surfaces.
- Add signed trust/safety exports with auditable reason-code lineage.

## M100 — Metrics and network health contracts (implementation-ready)
- Add deterministic contract surfaces for north star, funnel, partner/API, and safety metrics in v2 section 13.
- Include signed metrics exports and continuity checks.

## M101 — Product-surface readiness contracts (discovery-first → implementation-ready)
- Formalize API contracts required by marketplace web, iOS reference client, and embedded partner UI.
- Include notification taxonomy/prefs, cycle inbox projection, settlement timeline digest, and UI embedding payload schemas.

## M102 — Commercial packaging and policy contracts (discovery-first → implementation-ready)
- Formalize transaction-fee, subscription tier, boost-priority guardrails, quota/overage, and billing-policy contracts.
- Preserve safety invariant: commercial tiers cannot bypass trust/risk gates.

## Execution discipline (unchanged)
For each milestone M98–M102:
1. `docs/prd/Mxx.md` finalized first.
2. Scoped implementation.
3. `npm run verify:mxx`.
4. `node verify/runner.ts milestones/Mxx.yaml`.
5. Commit/push to `main` only when both gates pass.

## Official development kickoff gate
Official development starts once M98–M102 PRDs are accepted as source-of-truth for remaining v2 scope.
