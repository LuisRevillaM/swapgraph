# Marketplace Client UX Vision (One Pager)

## Product intent
Build a marketplace client that feels like a fast trading console for ordinary users: post what you have, express what you want, and get high-confidence multi-party swap opportunities with clear next actions.

## Who this is for
- Primary: individual swappers listing assets and accepting/countering proposals.
- Secondary: power users optimizing value and completion speed across many intents.

## Core user promise
- "I can express intent in under 60 seconds."
- "I can see why a proposal exists and what I gain."
- "I can act quickly, with clear status from proposal through settlement."

## Experience model
- Step 1: Capture intent
  - User selects owned item(s), desired item(s), and flexibility constraints.
  - UI writes explicit intent/edge-intent signals (not just passive browsing behavior).
- Step 2: Run matching cycle
  - UI triggers matching run and reads run summary/proposals.
  - User sees ranked proposals with simple explanation badges: value delta, confidence, and constraint fit.
- Step 3: Commit and settle
  - User accepts/declines; timeline view tracks commit, deposit/execution events, and receipt.
- Step 4: Learn and refine
  - User can tighten or broaden preferences; rerun produces updated opportunities.

## Primary screens (v1)
- Inventory + Intent Composer
- Proposal Inbox (ranked opportunities)
- Proposal Detail (cycle graph + value/explanation)
- Active Swap Timeline (state machine progress)
- Receipts + History

## UX principles
- Explainability over mystery: every proposal shows why it was generated.
- Actionable state: every state has a next action or explicit wait reason.
- Fast iteration loop: edit intent -> rerun -> compare outcomes.
- Safety clarity: explicit errors, fallback states, and idempotent retry UX.

## Backend capabilities already supporting this
- Marketplace run/create + run/read APIs are live and store-backed.
- Explicit edge-intents + hybrid graph matching are live.
- Proposal replacement/expiry lifecycle is in place.
- Settlement timeline/read contracts and receipts are in place.
- Runtime is deployed with SQLite persistence and v2-primary matcher fallback/rollback safeguards.

## What to build next on client (highest leverage)
1. Intent Composer + Run action wired to live APIs.
2. Proposal Inbox + Proposal Detail with explanation primitives.
3. Commit + Timeline shell (read-first, then write actions).
4. Lightweight analytics instrumentation (run-to-proposal, proposal-to-commit, commit-to-receipt).

## Success metrics for first release
- Time to first intent < 60s median.
- Matching run success rate > 99%.
- Proposal open rate > 70%.
- Proposal accept rate and completed-settlement rate trend up week over week.
- User-visible error recovery (retry success) > 95%.
