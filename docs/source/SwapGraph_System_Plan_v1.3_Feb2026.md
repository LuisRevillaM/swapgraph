# SwapGraph — Multi-Reciprocity Swap Protocol

## System Architecture, Product, UX & Business Plan

**v1.3 — February 2026**  
**CONFIDENTIAL**

> Source: Luis rewrote the full plan as a single cohesive document.

---

## Table of Contents

1. Executive Summary
2. The Problem
3. Product Overview
4. Core Concepts
5. Product Experience Layer (Delight + UX Spec)
6. Data Model
7. Matching Engine
8. Swap Execution & Settlement
9. Trust, Safety & Compliance
10. Platform Integration Strategy (Cross-Ecosystem North Star)
11. Business Model & Monetization Layer
12. Brand & Community
13. Metrics & Growth
14. Technical Stack & Architecture
15. MVP Scope & Roadmap
16. Future: Agent Economy Extension
17. Key Risks & Mitigations
    Appendix A. UX State Machine
    Appendix B. API Sketch
    Appendix C. Glossary

---

## 1. Executive Summary

SwapGraph is a **multi-reciprocity swap platform** for digital items. It matches users into **multi-party swap cycles** (A gives to B, B gives to C, C gives to A) so everyone receives what they want **without needing a direct counterparty** or cash conversion.

The **10x product promise** is **cross-ecosystem conversion**: turning value trapped in one ecosystem into items you actually want in another ecosystem, using **verified multi-party swaps** rather than cash-out and re-buy. This is the story that creates new liquidity and unlocks inventories that otherwise go idle.

We launch **Steam-first (CS2/Dota 2/TF2)** to prove:

1. cycle matching at scale,
2. escrow-based atomic settlement, and
3. a trust & safety stack that survives adversarial trading communities.

Steam has real trade-offer primitives and a massive item economy, enabling a credible, automated MVP.

From day one, the architecture is built for cross-ecosystem expansion via a **platform-adapter layer**. New ecosystems are added only when SwapGraph can execute transfers through **official rails** (native trade mechanisms, platform APIs, or explicit publisher partnerships). **Account swapping and other Terms-of-Service workarounds are explicitly out of scope.**

Beyond gaming, the same protocol extends to other digital niches where assets are scarce and preferences are heterogeneous (domains, transferable creator licenses where permitted, closed-loop credits), and eventually to an agent economy where agents swap capabilities and work products with **verification replacing item escrow**.

### Goals (v1–v2)

* Ship a Steam-only MVP that completes real multi-party swaps with escrow and clear failure handling.
* Deliver a delightful, trader-native UX that feels safer and faster than manual Discord trading.
* Prove unit economics (swap fees + premium tooling) without degrading trust.
* Stand up adapter architecture + compliance gates so cross-ecosystem expansion is an engineering/configuration problem, not a rewrite.

### Non-goals

* No account credential transfers, account sales, or account swaps.
* No cash-out marketplace (no fiat rails in MVP).
* No support for ecosystems with no official transfer mechanism unless via explicit partnership and legal review.

---

## 2. The Problem

Digital items with real perceived value are locked inside walled-garden ecosystems. Players switch games, communities migrate, and tastes change, but inventories remain stranded. The result is trapped value, fragmented liquidity, and a thriving gray market where scams are common.

### What users do today (and why it’s bad)

1. Sell on a cash-out site or marketplace, pay heavy fees/spreads, then re-buy in the target ecosystem.
2. Attempt cross-ecosystem trades informally (Discord, forums) with high scam and non-delivery risk.
3. Give up and let items sit idle because finding a direct swap counterparty is too hard.

### Root cause: the double coincidence of wants

Two-party barter requires a near-perfect coincidence: someone who has exactly what you want and wants exactly what you have. In digital goods, preferences are long-tail (specific skins, patterns, wear) and ecosystems are siloed, making direct matches rare.

### Why cycle matching works

Multi-party cycle matching removes the need for a direct counterparty. You only need to be part of a cycle where each participant’s want is satisfied by someone else’s offer. This converts a hard search problem into a solvable graph problem.

### Why now

* Digital item economies are mature: users already understand “inventory value” and trading.
* Trading communities are large but still rely on manual coordination and trust heuristics.
* Platforms with transferable items (e.g., Steam) provide official primitives for safe settlement, enabling a legitimate wedge.

---

## 3. Product Overview

### 3.1 Who it’s for (initial persona)

* CS2/Dota 2/TF2 traders who actively manage inventories and understand item value.
* Collectors who want specific items and are willing to trade multiple steps to get them.
* Casual traders who are willing to swap if the UX feels safe, guided, and simple.

### 3.2 Core user journey

1. Connect platform account(s) and sync inventory (Steam-first).
2. Select an item (or bundle) to offer and define a structured want (specific item or category + constraints).
3. Set a value tolerance band and optional speed-vs-value preference.
4. Receive cycle proposals that show exactly what you give and what you get, plus a deal confidence indicator.
5. Accept a proposal, deposit to escrow, and watch an execution timeline.
6. Receive your item, get a swap receipt, and gain reputation/progression.

### 3.3 What makes SwapGraph different

* **Cycle matching:** unlocks swaps that never appear in a two-party marketplace.
* **Atomic settlement:** everyone trades or nobody trades (within the limits of platform rails).
* **Trader-native UX:** explainable matches, clear timelines, and trust-first design.
* **Cross-ecosystem north star:** architecture and brand built around converting value across silos, even when v1 supports only one ecosystem.

### 3.4 Product objects

* Inventory: items a user can offer (verified, tradable, transferable).
* Listing: a user’s offer + want specification + constraints.
* Cycle Proposal: a candidate multi-party swap produced by the engine.
* Escrow Deposit: the settlement step that makes a cycle executable.
* Swap Receipt: an auditable record of what happened (for trust + sharing).

---

## 4. Core Concepts

### 4.1 The Swap Graph

SwapGraph models active listings as a directed graph. Each listing is a node: “I have X; I want Y”. An edge from listing A to listing B exists when B’s offered item satisfies A’s want and falls within A’s constraints. Any directed cycle represents a valid multi-party swap.

### 4.2 Listings are sets, not single wants

To increase match rate, wants should be expressed as a structured set, not a single target. Example:
“Any CS2 knife in these finishes OR this specific item ID, within $300–$420, from traders with reliability >= 4.0.”

### 4.3 Value tolerance bands

Perfect value equality is rare. Each listing includes a value tolerance band and optional speed-vs-value preference. The engine only proposes cycles where every participant’s constraints are satisfied. The platform never overrides user-set tolerances.

### 4.4 Cycle scoring and prioritization

When many cycles exist, SwapGraph prioritizes proposals that are most likely to complete successfully and delight users:

* Shorter cycle length (lower execution risk).
* Tighter value alignment (lower perceived unfairness).
* Higher participant reliability / lower risk tier.
* Older listings (anti-starvation).
* User urgency preferences (explicit).

### 4.5 Explainability (“Why this match?”)

Every cycle proposal includes an explanation summary understandable in under 10 seconds, plus an optional advanced view for power users:

* You give / you get (primary).
* Constraint satisfaction: “Within your range” / “Matches your want category”.
* Value spread and pricing source timestamp (transparent).
* Confidence indicators: chain length, reliability tiers, deposit requirements.

### 4.6 Conflicts and exclusivity

A listing can appear in multiple candidate cycles. When a cycle is proposed, its listings are reserved for the proposal window to avoid double-spend. If the proposal expires or is declined, listings return to the pool.

---

## 5. Product Experience Layer (Delight + UX Spec)

### 5.1 Product pillars (must hold everywhere)

* **Certainty over hype:** show what happens next and what happens if something goes wrong.
* **Fast feedback, slow commit:** instant previews + clear irreversible-step confirmations.
* **Fairness you can verify:** value ranges, spreads, and constraints are visible and explainable.
* **Safety is a feature:** escrow timelines, receipts, and guardrails are part of the core UX.
* **Trader-native ergonomics:** the product speaks in the user’s domain language (e.g., CS2 wear/float/pattern).

### 5.2 Moments of delight (explicitly specified)

Each moment is specified with trigger, mechanism, and metric:

* **Inventory Awakening:** after sync, show “Most Swappable Items” + one-tap listing creation.
  Metric: % creating a listing within 5 minutes.
* **Cycle Reveal:** animated cycle card collapsing complexity into “You give X → You get Y”.
  Metric: proposal accept rate.
* **Atomic Completion:** swap receipt + reliability level-up.
  Metric: repeat listing rate within 7 days.
* **Protected Failure:** if a cycle fails, show unwind timeline and proofs.
  Metric: retention after first failure.

### 5.3 Screen map (MVP)

* Connect & Sync: Steam OAuth, inventory scan, tradability check.
* Inventory: filters (tradable, value, rarity), item detail with pricing + metadata.
* Create Listing: choose offer; choose want (specific item or category); set tolerance; set urgency; preview matching likelihood.
* Listings Dashboard: active listings, boosts, performance insights, edit/cancel.
* Cycle Inbox: proposals with confidence score; accept/decline; countdown.
* Deposit Checklist: escrow instructions + deep links; deposit status; timeouts.
* Execution Timeline: progress of each leg; receipts; support entrypoint.
* Swap Receipt: final summary, share card, rating + feedback.
* Profile: reliability score, limits, badges, dispute history.

### 5.4 UX requirements by state (Cycle object)

| Cycle State    | Primary UI                        | Must Show / Must Do                                                                                            |
| -------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| proposed       | Cycle Proposal Card + Detail View | You give/you get; value spread; confidence; participant reliability; deadline; fee disclosure; Accept/Decline. |
| accepted       | Deposit Checklist                 | Exact deposit steps; timer; what happens on timeout; cancel rules before deposit; support link.                |
| escrow.pending | Deposit Progress Timeline         | Per-user deposit status (anonymized if needed); proof checks; warnings for holds/locks.                        |
| executing      | Atomic Execution Timeline         | Leg-by-leg status; transaction IDs where available; expected completion window.                                |
| completed      | Swap Receipt                      | Final items; confirmations; ratings; shareable proof; updated reliability.                                     |
| failed         | Unwind & Refund Timeline          | What failed; what is being refunded; proof of return; dispute button; reassurance copy.                        |

### 5.5 Notifications (multi-channel, respectful)

* In-app: real-time cycle proposals, deposit reminders, execution updates.
* Email: only for time-sensitive steps and receipts by default.
* Discord (optional): DM + server bot integration for power traders.
* All notifications must include “next action” and “deadline”.

### 5.6 Progression & trust gamification (non-predatory)

Progression reinforces good behavior (reliability, speed, dispute-free swaps), not addictive volume:

* Reliability Score (0–5): completion rate, dispute rate, deposit speed, verification health.
* Trader Levels: unlock higher caps and faster proposal windows after milestones.
* Badges: “Fast Depositor”, “Dispute-Free Streak”, “Cycle Closer”.
* Public/shareable only if user opts in; default privacy-first.

### 5.7 Support UX (built into the flow)

* Contextual support entrypoint on every escrow/execution screen.
* Pre-filled incident reports (cycle ID, trade offer IDs, timestamps).
* Dispute center with timelines, evidence uploads, and resolution SLA targets.

---

## 6. Data Model

### 6.1 Design principles

* Model the domain in platform-native identifiers (Steam app_id, asset_id, class_id, instance_id).
* Treat pricing as an estimate with provenance (source, timestamp).
* Keep matching constraints explicit and user-owned (never inferred without consent).
* Separate Item (platform asset) from Listing (intent) from Cycle (proposal) from Settlement (execution).

### 6.2 Core entities (high level)

* User
* PlatformConnection
* InventoryItem (platform-native asset)
* Listing
* Cycle
* SwapLeg (one transfer inside a cycle)
* EscrowAccount / EscrowDeposit
* PricingSnapshot
* Dispute

### 6.3 User

* id (UUID)
* username (string)
* email (string)
* reliability_score (0.0–5.0)
* risk_tier (enum: new, trusted, pro, restricted)
* limits (JSON: max_value, max_cycle_length, daily_swaps)
* created_at, last_active_at

### 6.4 PlatformConnection

* id, user_id
* platform (steam, roblox, epic, …)
* platform_user_id
* oauth_scopes / tokens (encrypted)
* inventory_synced_at
* verification_health (token freshness, ban flags if available)

### 6.5 InventoryItem (Steam-first example)

* id, user_id, platform
* app_id, context_id
* asset_id, class_id, instance_id
* tradable_at, marketable, trade_hold_days
* display_name, icon_url
* quality metadata (JSON): wear/float, pattern, stickers, special tags
* pricing_snapshot_id, estimated_value_usd
* ownership_verified_at, verified

### 6.6 Listing

* id, user_id
* offer_items[] (one or more InventoryItem ids)
* want_spec (structured JSON): acceptable targets (specific ids and/or category constraints)
* value_min_usd, value_max_usd
* urgency + speed_vs_value
* auto_accept_rules (optional Pro; always within constraints)
* status (active/reserved/matched/completed/expired)
* boost_level (optional; bounded and safety-gated)
* created_at, updated_at

### 6.7 Cycle & SwapLeg

* Cycle: id, listing_ids (ordered), length, proposed_at, expires_at
* Cycle: pricing_context (sources + timestamps), value_spread, confidence_score
* Cycle: fee_breakdown, explainability_blob
* SwapLeg: id, cycle_id, from_user_id, to_user_id, item_ids[]
* SwapLeg: escrow_status (pending/deposited/released/refunded), transaction_refs[]
* SwapLeg: executed_at, failed_reason

### 6.8 PricingSnapshot

* id, platform, item_key, currency
* price_median, price_low, price_high, liquidity (volume)
* source, captured_at
* confidence (0–1) and outlier_flags

### 6.9 Dispute

* id, cycle_id, user_id, type
* status (open/under_review/resolved/denied)
* evidence, resolution_notes
* opened_at, resolved_at

---

## 7. Matching Engine

### 7.1 Responsibilities

* Translate active listings into a directed compatibility graph.
* Detect candidate cycles up to max length (configurable).
* Score and select a non-conflicting set of cycles to propose.
* Generate explainability artifacts and fee previews.
* Reserve listings during proposal windows to prevent conflicts.

### 7.2 Matching loop (default every 60 seconds)

1. Load active listings + latest verified inventory/pricing state.
2. Construct compatibility edges using want_spec + constraints + value bands.
3. Prune risky edges (risk tier, trade-holds, missing verification).
4. Run cycle detection (cap length; early stop once enough candidates exist).
5. Score cycles and select disjoint cycles (conflict resolution).
6. Create cycle proposals, reserve listings, notify participants.

### 7.3 Edge construction (compatibility)

An edge A→B exists when B’s offered items satisfy A’s want_spec and fall within A’s tolerance band. Matching supports:

* Exact target matching
* Category matching
* Attribute constraints (wear/float, rarity, trade-hold constraints)
* Trust constraints (min reliability score, max risk tier)

### 7.4 Cycle detection

Use an elementary cycle enumeration algorithm (e.g., Johnson’s algorithm) with a strict max cycle length (MVP: 3; later: 4–6). In production we prioritize “find good cycles” over “find all cycles” via early stopping and score thresholds.

### 7.5 Scoring function (proposal ranking)

* Value alignment
* Length penalty (execution risk)
* Reliability / risk tier
* Verification health
* Age/urgency anti-starvation

### 7.6 Conflict resolution and fairness

A listing cannot be in two proposed cycles at once. Use greedy disjoint-cycle selection: sort by score, pick best cycle, remove its listings, repeat. Add fairness: repeatedly skipped listings receive an increasing age bonus.

### 7.7 Determinism and auditability

* Store scoring inputs (pricing snapshot ids, constraints) per proposal.
* Store “why selected” explanation.
* Deterministic per run (seeded ordering) to reduce perceived randomness.

---

## 8. Swap Execution & Settlement

### 8.1 Design goals

* Minimize irreversible steps before all parties commit.
* Make failure safe: deposited items refundable under clear rules.
* Expose live timeline so users never feel lost.
* Preserve audit logs and proofs for disputes.

### 8.2 Cycle lifecycle (state machine)

proposed → accepted → escrow.pending → escrow.ready → executing → completed
Any state can transition to failed with a reason code + unwind plan.

### 8.3 Proposal phase

* Proposal shows: you give/you get, fees, value spread, confidence, deadline.
* Acceptance window default: 24 hours.
* If any participant declines/times out: proposal expires; listings return to the pool.

### 8.4 Acceptance and reservation

When a participant accepts, their listing is locked to that cycle proposal until completion/expiration. Users can cancel acceptance before depositing.

### 8.5 Escrow phase (Steam-first)

For Steam Tier-1: escrow via Steam trade offers to a SwapGraph-controlled escrow identity with strong operational controls (2FA, device isolation, rate limiting).

* Deposit window default: 48 hours after full acceptance.
* Pre-filled trade offer link (exact assets specified).
* Deposits verified by trade-offer confirmation + inventory checks.
* Items with trade holds/locks excluded in MVP (or require explicit longer timeline).

### 8.6 Atomic execution

Once all deposits confirmed in escrow, system executes outgoing transfers. Atomicity enforced at protocol level: no release until all deposits secured; then release as a batch.

### 8.7 Failure modes and unwind rules (explicit)

* **Ghost before deposit:** cancel cycle; refund any deposited items.
* **Partial deposit:** refund deposits after window closes (or earlier if all remaining parties cancel).
* **Transfer failure during execution:** halt remaining transfers; refund unreleased items; if partial release occurs due to platform behavior, escalate to dispute workflow with priority handling.
* **User cancellation:** allowed only before their deposit; after deposit relies on completion/unwind.
* **Verification failure:** block execution, refund all deposits, flag offender for review.

### 8.8 Settlement, receipts, and feedback

* Generate Swap Receipt: items, timestamps, trade offer ids, pricing context.
* Collect ratings/feedback; update reliability score.
* Dispute window default: 72 hours.

---

## 9. Trust, Safety & Compliance

### 9.1 Principles

* Safety is part of product value.
* Prefer official transfer rails and verifiable settlement.
* Progressive trust: start small, earn bigger limits.
* Minimize laundering incentives: anomaly monitoring, caps, provenance tracking.

### 9.2 Identity and account linking

* OAuth-based platform linking where supported.
* Device/session fingerprinting for Sybil resistance.
* Optional stronger verification for high-value tiers depending on jurisdiction.

### 9.3 Progressive trust and limits

* New: low max value, short cycles, stronger verification requirements.
* Trusted: higher caps after N successful swaps + low dispute rate.
* Pro: higher caps + auto-accept rules + advanced tooling (still safety-bound).
* Restricted: anomaly-flagged accounts limited/suspended pending review.

### 9.4 Fraud prevention

* Velocity checks
* Value anomaly detection
* Provenance tracking
* Sybil resistance via linked platforms + behavior signals
* Hold/lock detection

### 9.5 Dispute resolution (tiered)

* Tier 1: automated via platform proofs
* Tier 2: assisted mediation
* Tier 3: staff escalation

### 9.6 Security posture

* Escrow account security: 2FA, locked devices, least privilege
* Encrypted tokens; rotation/revocation
* Audit logs; tamper-evident storage for critical events
* Abuse-response playbooks

### 9.7 Compliance boundaries (explicit)

* No account swaps; no credential handling beyond OAuth.
* No fiat custody in MVP; no cash-out balances.
* Cross-ecosystem enabled only when compliant transfer is possible (or partnership).
* Future “Swap Balance” must be closed-loop, non-withdrawable, capped, reviewed.

---

## 10. Platform Integration Strategy (Cross-Ecosystem North Star)

### 10.1 North star

SwapGraph’s differentiator is cross-ecosystem conversion. The platform is built to add ecosystems through a consistent adapter interface, while enforcing compliance gates (transferability, verification, settlement safety). Steam-first is an execution wedge, not the destination.

### 10.2 Platform adapter interface

Each ecosystem adapter declares:

* Inventory read
* Transfer primitive
* Escrow capability
* Proofs/receipts
* Constraints (holds, cooldowns, eligibility rules)

### 10.3 Settlement capability tiers (not importance tiers)

| Tier                                   | Capabilities                                                                             | Product Support                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Tier 1: Programmatic escrow            | Inventory read + automated transfer + escrow via official rails                          | Full automation; best UX; eligible for long cycles           |
| Tier 2: User-initiated native transfer | Partial inventory read + native P2P transfer + verifiable receipt; escrow limited/absent | More friction; shorter cycles; stricter limits               |
| Tier 3: Partnership-gated              | No native transfer/proofs; needs publisher/platform agreement                            | Not supported without partnership; architectural placeholder |

### 10.4 Initial platforms

* Steam (Tier 1): CS2, Dota 2, TF2 via trade offers (MVP)
* Roblox Limiteds (Tier 2 candidate): tradable subset; requires careful UX + compliance gating
* Others evaluated via adapter checklist; added only if settlement safe and compliant

### 10.5 Cross-ecosystem swap patterns

* Pattern A: both ecosystems have transfer rails → multi-party cycle across adapters with explicit consent
* Pattern B: one ecosystem lacks rails → partnership or official conversion primitive required
* Pattern C: tokenized/portable assets (where legitimate) may bridge, optional

### 10.6 Expansion playbook

* Start with dense community (CS2)
* Add one adjacent tradable ecosystem only when trust/settlement quality preserved
* Make the “cross-ecosystem moment” a flagship story only once it’s real (receipts + proof)
* Never compromise on ToS by encouraging account swaps or credential transfers

---

## 11. Business Model & Monetization Layer

### 11.1 Monetization philosophy

* Charge for successful outcomes (completed swaps), not attempts
* Sell power tools (speed, control, insights), not access or safety
* Fee-transparent at proposal time
* Monetization never bypasses safety limits

### 11.2 Revenue streams (productized)

* Swap fee (core): charged only on completion; disclosed pre-acceptance
* Boosts: optional paid priority; bounded by safety rules
* Pro subscription: advanced filters, auto-accept rules, analytics, higher caps after trust milestones
* Protection Plan: priority dispute handling, faster unwind workflows (careful wording; not “insurance”)
* B2B/liquidity programs later (subject to platform rules)

### 11.3 Monetization surfaces

* Create Listing: Boost after constraints set
* Proposal: fee breakdown + Pro upsell for auto-accept/filters
* Post-completion: insights upsell
* Limits: milestone path + optional Pro (still safety-bound)

### 11.4 Guardrails

* Boosts cannot override tolerances/trust/verification requirements
* Auto-accept only within explicit user constraints and caps
* No dark patterns: fees before accept; easy cancel before deposit
* Protection Plan must not imply guaranteed compensation

### 11.5 Unit economics (illustrative targets)

* Avg item value: $25–$80 (CS2 wedge)
* Take rate: 3–5% on completed swaps
* Completion rate: >70% for accepted cycles (Steam Tier 1)
* Dispute rate: <2% of completed swaps
* Primary cost driver: T&S/support (optimize via receipts + logs + automation)

### 11.6 Growth levers

* Network effects
* Creator-led launch; shareable receipts
* Discord bot
* Power-trader partnerships
* Referral loop via fee discounts (not withdrawable value), tied to successful completions

---

## 12. Brand & Community

### 12.1 Positioning

SwapGraph turns digital inventories into what you actually want through verified multi-party swaps, not cash-out and re-buy.

### 12.2 Brand attributes

* Precise
* Verified
* Trader-native
* Clever (not gimmicky)

### 12.3 Visual + interaction motifs

* “Cycle closing” motif in proposals
* Receipts and timelines as proof aesthetics
* Calm confidence indicators

### 12.4 Voice and microcopy rules

* Avoid hype/scammy slang
* Always show next action + deadline
* Failure screens must show unwind plan + proofs
* Use domain terms correctly

### 12.5 Community strategy

* Concentrate on CS2 first
* Transparent trust program
* Discord as hub (status, education, support triage)
* Trusted traders as early moderators (clear COI rules)

---

## 13. Metrics & Growth

### 13.1 North Star Metric

* Weekly Successful Swaps per Active Trader
* Secondary: % of new users who complete a swap within 7 days

### 13.2 Funnel

Connect → Inventory synced → First listing → First proposal → Accepted → Deposited → Completed

### 13.3 Delight & trust metrics

* TTFL/TTFP
* Proposal acceptance rate (by cycle length/confidence)
* Deposit completion + latency
* Completion rate
* Dispute rate + resolution time
* Retention after first failure
* Post-swap “felt safe” + NPS

### 13.4 Revenue metrics

* Revenue per completed swap
* Boost attach rate
* Pro conversion post-completion
* Churn/downgrades
* Support cost per 1,000 swaps

### 13.5 Experimentation rules

* Every monetization change has a guardrail metric
* A/B tests opt-in for high-stakes flows (escrow/execution copy)
* Safety is a product constraint

---

## 14. Technical Stack & Architecture

### 14.1 Recommended stack

* Node.js/TypeScript
* tRPC or Hono
* PostgreSQL
* Redis + BullMQ
* WebSockets
* Sentry + PostHog
* Fly.io/Railway + object storage

### 14.2 Service decomposition (MVP)

* API service
* Matching worker
* Settlement service
* Notification service
* Admin + T&S console

### 14.3 Why not a graph database

The matching graph is ephemeral and rebuilt frequently. Cycle detection and scoring are best done in application code with an in-memory representation. Postgres stores durable state.

### 14.4 NFRs

* Correctness: no double-spend; clear reservations
* Latency: proposals within ~60 seconds (MVP)
* Reliability: idempotent settlement ops; safe retries
* Security: token encryption; least privilege; audit logs
* Scalability: shard by game/app_id

---

## 15. MVP Scope & Roadmap

### 15.1 MVP (Months 1–2): Steam-only, real escrow, real swaps

* Steam OAuth + inventory sync
* Steam-native item model + tradability checks
* Listing creation with want_spec + tolerance band
* Cycle detection length <= 3
* Proposals with explainability + fees + confidence
* Escrow deposits + timeouts + refunds
* Execution timeline + receipts
* Reliability scoring + progressive limits
* Admin console (disputes, refunds, risk flags)

### 15.2 Phase 2 (Months 3–4): Quality + growth tooling

* Cycle length 4–5 where safe
* Better value estimation (multi-source + liquidity + outliers)
* Discord bot
* Pro subscription features
* Protection Plan ops + improved unwind/receipt

### 15.3 Phase 3 (Months 5–6): First cross-ecosystem pilot (compliance-gated)

* Integrate one Tier-2 ecosystem (candidate: Roblox Limiteds) with strict caps
* Cross-ecosystem cycles where both adapters can verify transfers + enforce deadlines
* Marketing moment: opt-in “cross-ecosystem receipt” stories

### 15.4 Phase 4 (Month 7+)

* Publisher partnerships for Tier-3 ecosystems
* Non-gaming digital vertical experiments
* Open protocol spec for adapters/extensions

---

## 16. Future: Agent Economy Extension

### 16.1 Vision

Cycle matching applies to AI agents with heterogeneous skills and needs. Instead of swapping items, agents swap verified work products.

### 16.2 Capability cards

* Agents publish capability cards (skills, constraints, quality signals)
* Agents publish needs (tasks required)
* Engine finds cycles of mutually satisfiable work

### 16.3 Agent settlement

* Work submitted to escrow-like holding
* Automated tests/evals validate outputs before release
* Reputation tracks completion and quality
* Disputes resolved via eval reruns or arbitration; optional balance points later

### 16.4 Why it matters

* Avoids universal dollar pricing
* Captures marginal value via willingness to exchange
* Creates a composable market for specialized work (connectors, evals, data cleanup, GPU time)

---

## 17. Key Risks & Mitigations

* Platform policy/ToS violations (High) → only compliant rails, no account swaps, legal review, partnership gating
* Scams/fraud at scale (High) → escrow-first, progressive limits, anomaly detection, audit logs
* Low initial liquidity (High) → CS2 wedge, seed traders, creator launch
* API changes (Medium) → adapter abstraction, graceful degradation, diversify
* Value estimation errors (Medium) → multi-source + liquidity confidence + tolerance bands
* Regulatory exposure (Medium) → no fiat custody/cash-out, capped closed-loop points only with review
* Escrow security (High) → strong ops security, monitoring, incident playbooks

---

## Appendix A. UX State Machine (Expanded)

### A.1 Listing states

* active
* reserved
* matched
* completed
* expired/cancelled

### A.2 Cycle states

* proposed
* accepted
* escrow.pending
* escrow.ready
* executing
* completed
* failed

### A.3 Standard timeouts (configurable)

* proposal: 24h
* deposit: 48h
* unwind: immediate after deadline or invalid deposit
* dispute: 72h post-completion

### A.4 Copy requirements

* Every timer answers “What happens if I do nothing?”
* Every failure screen shows: reason + unwind plan + expected window + support CTA
* Every proposal shows: fee, spread, confidence, and “why matched”

---

## Appendix B. API Sketch (Non-final)

### B.1 Core endpoints

* POST /auth/steam/connect
* POST /inventory/sync
* POST /listings
* GET /listings
* GET /cycles/inbox
* POST /cycles/{id}/accept | /decline
* POST /escrow/{cycle_id}/deposit
* GET /escrow/{cycle_id}/status
* GET /receipts/{cycle_id}
* POST /disputes

### B.2 Jobs/webhooks

* matching.run
* escrow.timeout_check
* platform.inventory_poll
* notification.dispatch

---

## Appendix C. Glossary

* **Cycle:** closed chain of compatible listings where each participant receives a desired item
* **Listing:** offer + structured want + constraints
* **Want Spec:** machine-readable acceptable targets + constraints
* **Escrow:** controlled holding step for safe settlement
* **SwapLeg:** one transfer inside a cycle
* **Value Spread:** deviation between item estimates inside a cycle
* **Reliability Score:** behavior-based trust score used to reduce fraud and improve completion
