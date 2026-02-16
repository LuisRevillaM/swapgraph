# SwapGraph

## API-First Multi-Reciprocity Swap Clearing Network

System Architecture, Protocol Spec, Marketplace & Mobile Product Plan  
**v2.0 — February 2026**  
**CONFIDENTIAL**

---

## Table of Contents

1. Executive Summary
2. The Problem and Opportunity
3. Vision: The SwapGraph Clearing Network
4. Product Surfaces: Marketplace, iOS, and Embedded Partner UI
5. Protocol and Core Primitives
6. Platform Integration Model (Partners and Agents)
7. Matching Engine (Cycle Clearing)
8. Settlement, Custody, and Cryptographic Assurances
9. Trust, Safety, and Compliance
10. Data Model
11. API Surface (REST + Webhooks + Streams)
12. Monetization and Partner Commercials
13. Metrics and Network Health
14. Roadmap and Milestones
15. Key Risks and Mitigations

Appendix A: UX State Machines
Appendix B: Object Schemas (JSON)
Appendix C: Steam-First Implementation Notes
Appendix D: Security & Key Management Notes
Appendix E: Native iOS Client Plan
Appendix F: Marketplace UX and Notification Spec

---

## 1. Executive Summary

SwapGraph is an API-first swap clearing network for digital assets. Any marketplace, app, or user agent can submit swap intents ("I have X, I want Y, under constraints"), and SwapGraph returns executable multi-party swap proposals (A→B→C→A). Where transfer rails exist, SwapGraph coordinates commitment, custody, and settlement; where they do not, SwapGraph enforces policy, proofs, and user-consent workflows.

The marketplace (web) and native iOS app are reference clients: best-in-class consumer UX that proves the protocol, builds trust infrastructure, and bootstraps liquidity. However, the company’s long-term distribution and defensibility come from the API platform: integrating with existing marketplaces to ingest listings, route swap requests, and settle completed swaps with verifiable receipts.

What we ship first

Steam-first, API-first: a production clearing API plus SwapGraph’s own marketplace and iOS client built on the same public primitives.
Cycle matching for 2–3 party swaps (expand to 4–6 once completion rates and risk controls are proven).
Custody-based settlement via Steam trade offers and escrow accounts, with explicit timeouts and unwind rules.
Signed receipts and transparency logs that make swaps auditable and disputes resolvable.
Partner-ready ingestion (listings + inventory proof) and proposal delivery via webhooks/streams.

What makes this 10x

Cycle clearing: you do not need a direct counterparty.
Network distribution: partners syndicate intents and consume proposals via API; SwapGraph becomes a liquidity layer across marketplaces.
Programmable trading: user agents can manage listings and accept proposals within user-defined policies ("auto-accept if within my band and confidence ≥ X").
Trust primitives: receipts, audit logs, and custody proofs are standardized once and reused everywhere.

Non-goals (explicit)

No account swapping or credential transfer workflows.
No cash-out rails in v1 (no fiat balances, no withdrawals).
No support for ecosystems without legitimate transfer primitives unless partnership-gated and legally reviewed.

---

## 2. The Problem and Opportunity

Digital value is trapped in walled gardens. Players change games, creators change tools, communities migrate — but inventories remain stranded. Today, users either pay large spreads to cash-out and re-buy, attempt risky off-platform trades, or abandon value entirely.

Root cause: the double coincidence of wants

Two-party barter requires a near-perfect coincidence: someone who has exactly what you want and wants exactly what you have. In digital goods, preferences are long-tail (specific cosmetics, patterns, wear, attributes) and liquidity is fragmented across many venues. Multi-party cycle matching removes the requirement that your counterparty is the same person who provides what you want.

Why an API-first approach is the unlock

Distribution: existing marketplaces already have users, inventory surfaces, and demand. An API lets SwapGraph capture order flow without rebuilding every consumer surface from scratch.
Network effects compound across partners: more nodes → denser graph → more cycles → higher fill rate → more partner value → more nodes.
Shared trust infrastructure: custody, receipts, disputes, and risk scoring are expensive to build and maintain. Partners integrate to outsource the hardest parts.
Programmability: agents can act on behalf of users to keep listings fresh, respond quickly to proposals, and enforce consistent constraints — increasing completion rates.

Initial vertical: gaming item economies

We launch in gaming because the conditions are ideal: strong item identity, heterogeneous preferences, active trading behavior, and a high willingness to adopt workflow tools that increase liquidity and safety.

---

## 3. Vision: The SwapGraph Clearing Network

The mental model

SwapGraph is a clearing layer, not just a marketplace. Marketplaces, bots, and apps submit standardized intents; SwapGraph matches intents into cycles, coordinates commitment and settlement, and returns receipts.

Analogies: Stripe (payments), Plaid (financial data), Twilio (communications). SwapGraph standardizes swap intent and cycle clearing.

SwapGraph’s marketplace and mobile clients are reference implementations that demonstrate best-in-class UX and bootstrap liquidity.

Network roles

End user: owns assets and defines acceptable swaps and policies.
Partner marketplace: sources order flow and embeds SwapGraph proposals into existing surfaces.
Agent: acts on behalf of a user within explicit, auditable policies.
SwapGraph: matching, reservation, settlement orchestration, receipts, disputes, and risk controls.

Key promises (what integrators can rely on)

Stable primitives: SwapIntent, CycleProposal, Commit, SettlementTimeline, SwapReceipt.
Deterministic safety rules: constraints are never overridden; trust tiers gate maximum value and cycle length.
Idempotent APIs: every mutation is safe to retry; every state transition is auditable.
Event-driven integration: partners can operate via webhooks and streams without polling.
Receipts are verifiable: cryptographic signatures and transparency logs allow partners and users to audit what happened.

Design principle: one engine, many surfaces

All SwapGraph experiences (web marketplace, iOS client, partner embeds, agents) are thin clients over the same platform APIs. This forces correctness, makes partner integration easier, and reduces product drift.

---

## 4. Product Surfaces: Marketplace, iOS, and Embedded Partner UI

### 4.1 SwapGraph Marketplace (web)

The marketplace is a full consumer experience built on the platform APIs. It bootstraps liquidity, proves trust infrastructure, and serves as the default UI for users without a partner venue.

Core loops

Inventory Awakening: connect Steam → see tradable inventory → highlight "most swappable" items → 1-click create listing.
Intent Posting: express wants as sets (specific item or category + constraints).
Cycle Inbox: proposals arrive with explainability, confidence score, fees, and countdown.
Deposit & Execute: guided escrow checklist, live execution timeline, and receipts.
Trust Progression: reliability score and limits increase with successful, dispute-free swaps.

Discovery (compelling, but safe)

Trending Wants: categories with high unmet demand (e.g., "CS2 knives") based on intent volume.
Swap Opportunities: "You already have items that match 17 active wants".
Watchlists: users track categories/items and get notified when cycles become available.
Price-aware recommendations: surface swaps that are within the user’s tolerance band and high liquidity.

The "Intent on your item" mechanic

A unique marketplace delight is making wants actionable. Users can place swap intents against a specific item (or narrow category). If another user holds an eligible item, that holder receives a notification: "Someone wants your item — swap opportunity available." This creates a pull-based liquidity signal without exposing private identities or encouraging harassment.

### 4.2 Native iOS Client (reference implementation)

The iOS client is the fastest way for users to react to proposals and deadlines. It emphasizes clarity, speed, and push-notification driven workflows.

Push notifications: new proposal, proposal expiring, deposit required, execution completed, refund completed.
Live activity (optional): in-progress execution and deposit countdowns.
One-tap acceptance flow: "You give / you get" at the top; detailed graph is optional.
Receipts and share cards: verifiable proof of swap completion (privacy controls).

### 4.3 Embedded Partner UI (optional but powerful)

For partners who want a turnkey integration, SwapGraph provides embeddable UI components (web SDK) that render key screens using partner branding:

Create listing / swap intent composer
Cycle proposal cards + explanation drawer
Deposit checklist and status timeline
Receipt renderer

Integration modes

API-only: partner builds their own UI and uses SwapGraph for clearing and settlement.
UI-embedded: partner uses SwapGraph UI components to ship faster and reduce integration risk.
Syndication: partner lists intents into SwapGraph and optionally displays SwapGraph liquidity back into their venue.

---

## 5. Protocol and Core Primitives

### 5.1 Design goals

Universal: usable by SwapGraph clients, partner marketplaces, and agents.
Compositional: primitives compose into larger flows without bespoke endpoints.
Auditable: every proposal, acceptance, deposit, and release produces a receipt and an append-only log entry.
Safe by construction: user constraints and policy gates are enforced server-side.
Event-driven: state changes are streamed; integrations do not rely on polling.

### 5.2 Canonical primitives (objects, not endpoints)

AssetRef

A normalized reference to a platform-native asset.
Fields: platform, app_id/context_id (if applicable), external asset identifiers (e.g., Steam asset_id/class_id/instance_id), and optional metadata (wear/float/pattern).
Security: includes proof pointers (inventory snapshot id, verification timestamp).

InventorySnapshot

A point-in-time statement of a user’s assets on a platform, with verification and tradability flags. Snapshots are used for matching and for later dispute resolution.
Fields: user_id, platform_connection_id, captured_at, items[], verification_method, and a trust score for the snapshot (freshness, API confidence).
Used to prevent "I no longer own it" failure modes by requiring freshness for high-value intents.

SwapIntent

The core unit of liquidity: what a user is willing to give, what they are willing to receive, and under what constraints.
offer: one or more AssetRefs (bundle allowed).
want_spec: acceptable targets as a set (specific items and/or categories + attribute constraints).
value_band: min and max acceptable value (or other balancing rule).
trust_constraints: minimum counterparty reliability, allowed risk tiers, and maximum cycle length.
time_constraints: expiry, deposit window preferences, and urgency.
settlement_preferences: escrow-required vs allow user-initiated transfer (depends on platform adapter tier).
actor: user, partner_app, or delegated_agent (with consent receipt).

CycleProposal

A candidate multi-party swap discovered by the matching engine.
cycle_id, intents[] (ordered), you_give/you_get per participant, and expiry.
explainability: human-readable explanation of why it matches constraints and value bands.
confidence_score: predicted completion likelihood (based on chain length, risk tiers, holds, historical completion).
fee_breakdown: disclosed before commit.

Commit (two-phase)

A commit object represents each participant’s acceptance of a proposal and is designed to be safe under retries and partial failures.
Phase 1 - Accept: participant accepts a CycleProposal; intents become reserved; a commit token is issued.
Phase 2 - Ready: once all participants accept, the system moves to settlement preparation (deposit instructions, escrow addresses, or platform-native transfer prompts).
Optional cryptographic consent: for high-value swaps, accept actions can require a user-held key signature (passkey/WebAuthn or device Secure Enclave key).

SettlementTimeline

A real-time state machine for deposits, escrow readiness, execution, and unwind/refund steps.
States: proposed → accepted → escrow.pending → escrow.ready → executing → completed OR failed.
Per-leg status: pending/deposited/released/refunded with transaction references where available.

SwapReceipt (verifiable)

A receipt is the canonical proof that a swap completed (or unwound). Receipts are generated for both completed and failed cycles.
Contains: intent ids, asset ids, timestamps, platform transaction refs, fees, and final state.
Cryptographic signature: SwapGraph signs each receipt with a rotating signing key; partners can verify integrity.
Transparency log inclusion: receipt hashes are appended to an audit log that can be independently monitored for tampering (see Section 8.5).

### 5.3 Protocol invariants

Constraints are never overridden: if a proposal violates any participant constraint, it must not be generated, and it must not be committed.
Only one active reservation per intent: prevents double-use in multiple cycles.
Idempotent mutations: accept/decline/deposit operations can be retried safely.
Event sourcing for critical state: settlement transitions produce immutable log entries.

---

## 6. Platform Integration Model (Partners and Agents)

### 6.1 Partner marketplace integration goals

Integrate in days, not months: stable primitives, clear error codes, and sandbox environments.
Partners keep their UI and users; SwapGraph provides matching, settlement orchestration, receipts, and risk tooling.
Event-driven: partners receive proposals and settlement updates via webhooks or streams.
Commercial alignment: rev-share on completed swaps; optional paid tiers for trust and SLAs.

### 6.2 Authentication and authorization

User auth: SwapGraph sessions for first-party clients; OAuth2/OpenID Connect for third-party apps.
Partner auth: partner API keys + OAuth client credentials; strict rate limits and scoped access.
Delegated agents: fine-grained delegation tokens tied to a user policy (see 6.4).
All write APIs require idempotency keys; all sensitive operations require recent authentication context.

### 6.3 Integration modes

Mode A - Syndicated listings (partner → SwapGraph)

Partner submits SwapIntents on behalf of users (with user consent).
SwapGraph returns proposals; partner chooses whether to display them in their UI or forward to the user’s agent.
Partner receives receipts and can display verified completion proof.

Mode B - Embedded proposal consumption (SwapGraph → partner)

Partner requests proposals for a given user or cohort (webhook push preferred).
Partner renders proposal cards using their design or SwapGraph’s embedded UI components.
Partner calls Commit endpoints (accept/decline) when user chooses.

Mode C - Inventory and verification as a service

Partner uses SwapGraph to normalize inventory, verify ownership/tradability, and attach proof pointers to intents.
Reduces partner support costs by eliminating screenshot verification workflows.

### 6.4 Agent delegation and programmable trading

Agents are first-class clients. A user can authorize an agent to create listings, adjust tolerances, and accept proposals only within an explicit policy.

TradingPolicy object (server-enforced)

max_value_per_swap and max_value_per_day
allowed categories and blocked items
minimum confidence_score
maximum cycle length
required settlement mode (e.g., escrow-only)
counterparty trust minimum
time windows (e.g., only accept during user-defined hours)

Delegation token model

Delegation tokens are scoped (list/create, modify, accept within policy) and short-lived; refresh requires user session or passkey.
Every agent action produces an audit record: "agent X accepted proposal Y because it met policy Z".
Users can revoke tokens instantly; revoked agents cannot take further actions.

### 6.5 Webhooks, streams, and replay

Webhooks: push proposals, state changes, receipts, and dispute events to partners.
Streams: a real-time subscription for high-volume partners and first-party clients.
Replay: partners can request event replay from a checkpoint to recover from downtime.

---

## 7. Matching Engine (Cycle Clearing)

### 7.1 Responsibilities

Ingest active SwapIntents and construct a compatibility graph.
Detect candidate cycles (length capped per trust tier).
Score cycles for completion probability and user delight (value alignment, chain length, risk).
Select a non-conflicting set of cycles per run (disjoint selection).
Generate explainability payloads and fee previews for each CycleProposal.

### 7.2 Graph construction

Each intent is a node. A directed edge intent A → intent B exists when B’s offered assets satisfy A’s want_spec and A’s constraints are met (value band, trust constraints, settlement mode). Edges can be weighted by value alignment and completion likelihood.

### 7.3 Cycle detection and scalability

Algorithm: cycle enumeration with a bounded maximum length (start with 2–3 for MVP; expand to 4–6 for higher trust tiers).
Performance: the graph is ephemeral and rebuilt frequently; cycle detection is performed in-memory in the matching worker.
Sharding strategy: partition by ecosystem (platform/app_id) and high-level categories; allow cross-shard matching only when a cross-platform adapter exists.

### 7.4 Scoring (what makes a proposal "good")

Value alignment: tighter value spread within participant bands is preferred.
Length penalty: shorter cycles complete more reliably; longer cycles require higher trust tiers.
Verification freshness: intents backed by recent inventory snapshots and tradability proofs are preferred.
User reliability: higher reliability increases confidence score.
Anti-starvation: older intents receive an age bonus so they are not perpetually skipped.
Urgency: user-defined urgency can trade value tightness for speed, but never beyond explicit constraints.

### 7.5 Manipulation and abuse resistance

Intent spam controls: per-user and per-partner rate limits; deposit required for high-impact intents.
Value anomaly checks: flag intents with suspiciously wide bands or unusual value mismatches (laundering risk).
Reputation-aware matching: new users are matched preferentially into smaller, safer cycles until proven.

---

## 8. Settlement, Custody, and Cryptographic Assurances

### 8.1 Settlement capability tiers (adapter-based)

Tier 1 - Custodial escrow: platform supports reliable transfer primitives; SwapGraph can take custody (or equivalent control) to execute atomic settlement.
Tier 2 - User-initiated transfers with verifiable receipts: SwapGraph coordinates a commit and enforces deadlines, but atomicity is constrained by the platform.
Tier 3 - Partnership-gated: platforms without legitimate transfer primitives require explicit partnership or native integration; not supported in v1.

### 8.2 Steam-first settlement (Tier 1)

For Steam, SwapGraph uses trade offers and dedicated escrow identities. Users always approve transfers within Steam. SwapGraph verifies deposits and executes releases once all deposits are secured.

#### 8.2.1 Two custody modes: "Deposit-per-swap" and "Vault"

Deposit-per-swap (MVP default): once a cycle is fully accepted, each participant deposits their offered items into escrow within a deadline. After all deposits, SwapGraph releases items to recipients.

Vault (delight + completion-rate unlock): users can optionally pre-deposit selected items into a SwapGraph Vault. Vaulted items are always available for matching and can settle instantly once a proposal is committed (subject to reservation locks). Users can withdraw vaulted items when they are not reserved.

The Vault model increases completion rates by removing the most failure-prone step (post-accept deposit), but requires stronger custody security and clearer user controls.

#### 8.2.2 Atomicity and failure handling (explicit)

No release before all deposits: escrow must hold all offered items before executing any outbound transfer.
Timeout-and-unwind: if any party fails to deposit before the deadline, all deposited items are returned (unwind) and the cycle fails with a reason code.
Idempotent execution: every outbound transfer is recorded with a unique operation id; retries never double-send.
Partial failure containment: if a platform outage interrupts execution, the system halts further releases and enters a protected recovery mode with human review thresholds for high-value cycles.

### 8.3 Cryptographic assurances (what we can prove to users and partners)

#### 8.3.1 Signed receipts

Every deposit and release produces a receipt signed by SwapGraph’s signing key.
Receipts include platform transaction references (where available), asset identifiers, timestamps, and final states.
Partners can verify receipt signatures offline (no need to trust a live API call).

#### 8.3.2 Transparency log (append-only audit)

SwapGraph maintains an append-only transparency log of critical settlement events (proposal creation, accepts, deposits, releases, refunds). Each log entry is hashed; log hashes are chained; periodic Merkle roots are published for third-party monitoring.
Goal: tamper evidence. If internal systems are compromised, it becomes difficult to rewrite history without detection.
Operational model: publish daily Merkle roots; provide inclusion proofs for a given receipt or deposit event.

#### 8.3.3 Proof of custody for escrow holdings

For custodial escrow, SwapGraph can provide "proof of custody" style assurances by periodically snapshotting escrow inventories and committing to those snapshots cryptographically.
Create an escrow inventory snapshot (list of platform asset identifiers) at a cadence (e.g., hourly).
Build a Merkle tree over the identifiers and publish the Merkle root.
Users and partners can request inclusion proofs showing a specific deposited asset is currently held (or was held at a specific time).
Important: this proves custody of an identifier, not value. It complements (not replaces) operational security controls.

#### 8.3.4 User-held consent keys (optional, high-value)

High-value swaps can require cryptographic consent using passkeys (WebAuthn) or device keys stored in the Secure Enclave (iOS).
Benefit: acceptance and release approvals can be bound to a user-held key, reducing account-takeover and partner-impersonation risk.

### 8.4 Uptime and reliability (platform-grade)

SLO targets (initial): 99.9% API availability; 99.99% settlement worker availability during escrow-ready execution windows.
Event replay: webhooks are deliver-at-least-once; partners can replay from a checkpoint.
Idempotency across the stack: all settlement actions and webhook deliveries are safe under retries.
Operational safety: maintenance windows must not interrupt escrow-ready execution; if unavoidable, cycles are paused safely before release.

### 8.5 Security posture for custody (Steam escrow)

Segregation of duties: no single engineer/operator can both initiate and confirm high-value releases.
Hardware-backed authentication: escrow identities protected with hardware keys and device isolation.
Rate-limited and anomaly-monitored transfers: stop-the-line triggers for unusual volume/value patterns.
Key management: receipt-signing keys stored in an HSM or equivalent; rotation and revocation procedures are practiced.
Red team mindset: assume phishing and credential theft attempts; build detection and recovery playbooks.

### 8.6 Future settlement adapters (beyond Steam)

As SwapGraph expands, different ecosystems require different settlement primitives. The adapter model abstracts these details while keeping the protocol stable.
On-chain assets: smart-contract based escrow and atomic swaps can provide cryptographic settlement guarantees.
Off-chain with native transfer: enforce commit, proof of transfer, and time-bounded disputes; custody may be impossible or undesirable.
Partnership-gated ecosystems: settlement occurs via official integrations or conversion primitives provided by the platform owner.

---

## 9. Trust, Safety, and Compliance

### 9.1 Principles

Safety is a product feature: the system is designed to fail safe (refund) rather than fail open.
Constraints are user-owned and enforced server-side (agents and partners cannot override them).
Progressive trust: new users start with small limits and unlock more with successful swaps.
Compliance-first expansion: new ecosystems are added only when transfer primitives are legitimate and supportable.

### 9.2 Risk tiers and limits

New: low max value, short cycles only, deposit-per-swap only (no Vault) until milestones are met.
Trusted: higher limits after successful swaps, low dispute rate, and verified platform connections.
Pro: higher caps and longer cycles (still policy gated), optional auto-accept rules.
Restricted: anomaly-flagged or disputed accounts limited pending review.

### 9.3 Partner and agent safety controls

Partner quotas: per-partner rate limits and value caps to prevent systemic abuse.
Agent delegation: server-enforced TradingPolicy; every agent action is audited and attributable.
Replay protection: signed webhooks and request signatures; verify partner identity on every call.

### 9.4 Fraud prevention (core signals)

Velocity checks: rapid listing changes and unusual acceptance patterns.
Value anomaly detection: unusually wide bands, repeated high-spread intents, or repeated cycles with the same cohort.
Sybil resistance: multiple accounts linking to the same platform identity signals.
Provenance tracking: flags for items involved in prior disputes, where platform data allows.

### 9.5 Disputes and support operations

Receipts and logs are the first line of defense: automated resolution when platform proofs are strong.
Community mediation is optional and bounded: only for low-value disputes and with strict rules.
Staff escalation for high-value disputes or repeat offenders; clear SLAs for partners on premium tiers.

---

## 10. Data Model

The storage model mirrors the protocol primitives. Platform-specific asset identifiers are preserved so the system speaks the domain language (e.g., Steam app_id, asset_id, class_id).

10.1 Core entities

10.2 Steam asset fields (example)

platform = steam
app_id, context_id
asset_id, class_id, instance_id
tradable_at, marketable, trade_hold_days
metadata: wear/float, pattern, stickers, special tags
pricing_snapshot_id and estimated value with source + timestamp

---

## 11. API Surface (REST + Webhooks + Streams)

### 11.1 API principles

API-first: first-party apps (web and iOS) use the same APIs as partners.
Stable object schemas: versioned; backward-compatible changes only.
Idempotency: required for all mutating operations.
Strong observability: correlation ids, request tracing, and structured errors.
Sandbox: partners can test with deterministic fixtures and fake inventories.

### 11.2 Core REST resources (illustrative)

Auth & connections: /auth, /platform-connections, /oauth/callback
Inventory: /inventory/snapshots, /assets
Intents: /swap-intents (create, update, cancel, list)
Proposals: /cycle-proposals (list, read)
Commit: /cycle-proposals/{id}/accept, /decline; /commits/{id}
Settlement: /settlement/{cycle_id}/instructions, /status
Receipts: /receipts/{cycle_id}
Disputes: /disputes (create, read, add-evidence)

### 11.3 Webhooks and streaming events

proposal.created, proposal.expiring, proposal.cancelled
cycle.state_changed, settlement.deposit_required, settlement.deposit_confirmed
settlement.executing, receipt.created, cycle.failed
user.reliability_changed, intent.reserved/unreserved

### 11.4 Security for partner integrations

Webhook signing: HMAC or asymmetric signatures with key rotation.
Request signing for high-risk operations: optional but recommended for partners.
Replay protection: timestamps and nonce windows.
Least-privilege scopes: partners cannot access unrelated users or intents.

---

## 12. Monetization and Partner Commercials

### 12.1 Monetization philosophy

Charge on outcomes: fees apply only when swaps complete (or when a premium service is explicitly delivered).
Never sell safety: safety gates are universal and cannot be bypassed by payment.
Make fees legible: show fee breakdown before accept; no surprise pricing.
Align incentives with partners: rev-share based on completed swaps sourced by the partner.

### 12.2 Revenue streams

Transaction fee (core take rate)

Charged per participant on completed swaps; disclosed at proposal time.
Tiered by complexity/risk: longer cycles or manual verification (where allowed) may have higher fees.

Pro subscription (power tools)

Auto-accept rules (within explicit constraints and policy gates).
Advanced filters (trust thresholds, cycle length, liquidity).
Insights (match likelihood, best times to list, historical completion).
Higher caps after trust milestones (subscription alone does not unlock unsafe caps).

Boosts / priority matching

Optional boosts that prioritize an intent in matching, bounded by fairness rules.
Boosts never override constraints, trust gates, or settlement requirements.

Partner platform monetization

Rev-share: split transaction fees for swaps sourced through a partner’s surface.
Usage-based API tiers: higher throughput, premium webhooks/streams, and analytics exports.
Trust & Safety API tier: advanced risk scoring and faster dispute SLAs.
Embedded UI licensing: white-label components for faster partner shipping.

### 12.3 Packaging and billing notes

Partners need predictable costs: clear quotas, overage pricing, and billing dashboards.
First-party mobile monetization must consider app store policies (e.g., in-app purchase requirements for subscriptions).

---

## 13. Metrics and Network Health

### 13.1 North Star metrics (choose one primary)

Weekly Successful Swaps per Active Trader (consumer product health).
Fill Rate: % of intents that receive an acceptable proposal within 7 days (network health).

### 13.2 Marketplace funnel metrics

Connect → inventory synced → first intent created → first proposal viewed → accepted → deposited → completed.
Time-to-first-intent and time-to-first-proposal.
Completion rate per cycle length and per trust tier.
Failure reasons distribution (ghost deposit, platform hold, declined, timeout).

### 13.3 API platform metrics

Partner order flow: intents/day by partner; proposals delivered; commit rate; completion rate.
Webhook health: delivery latency, retry counts, replay usage.
API latency and error rates by endpoint and partner.
Dispute rate by partner and by settlement tier; resolution time.

### 13.4 Safety and trust metrics

Fraud flags per 1,000 intents; confirmed abuse rate.
Account takeover indicators; unusual device changes for high-value users.
Refund/unwind frequency and average unwind time.
User-reported "felt safe" score after completion and after failure.

---

## 14. Roadmap and Milestones

Milestone 0 - One platform API (internal dogfood)

All first-party clients (web + iOS) use the same public API primitives as partners.
Canonical schemas for SwapIntent, CycleProposal, SettlementTimeline, Receipt.
Idempotency keys and structured errors enforced everywhere.
Basic event stream for cycle and settlement updates.

Milestone 1 - Developer Preview: intents in, proposals out

Partner auth (API keys + OAuth app registration), sandbox environment, and documentation.
Create/update/cancel SwapIntents via API; inventory snapshot ingestion where applicable.
Proposal delivery via webhook and polling fallback; explainability payload included.

Milestone 2 - Commit handshake and reservation locks

Two-phase commit semantics (accept/decline, reservation, expiry).
Conflict-free reservation enforcement across all clients and partners.
Audit logs for commit actions; optional passkey consent for high-value swaps.

Milestone 3 - Steam-first settlement (Tier 1)

Deposit-per-swap escrow flow with explicit timeout-and-unwind rules.
Settlement timeline streaming; receipts for complete and failed cycles.
Operational playbooks for escrow incidents and platform outages.

Milestone 4 - Vault (instant settlement) and proof-of-custody

Optional Vault deposit flow; instant matching eligibility for vaulted assets.
Daily transparency log publication and receipt signature verification tooling.
Proof-of-custody inclusion proofs for vaulted/deposited assets at snapshot times.

Milestone 5 - Partner program (commercial + SLA)

Partner dashboard: usage, completion rate, dispute rate, latency.
Rev-share reporting and billing; tiered quotas and overages.
Premium support and dispute SLAs for enterprise partners.

Milestone 6 - Agent delegation (programmable trading)

TradingPolicy objects and server-side policy enforcement for agent actions.
Delegation tokens with scopes, rotation, and revocation.
Audit trail: explain "why the agent accepted" with policy references.

Milestone 7 - Cross-ecosystem pilot (adapter gated)

Second ecosystem adapter where legitimate transfer is possible (Tier 2).
Cross-adapter cycle proposals with clear UX about atomicity limitations.
Verified cross-ecosystem receipts suitable for marketing and partner trust.

Parallel workstreams (continuous)

Trust & safety: risk scoring iteration, dispute tooling, fraud detection.
UX delight: proposal clarity, deposit friction reduction, receipts and share loops.
Reliability: SLO monitoring, event replay robustness, incident response drills.

---

## Appendix A: UX State Machines

Cycle state machine (user-facing)

These are the states every client must render consistently:

proposed: show give/get, confidence, fees, and countdown; accept/decline.
accepted: show deposit checklist and required actions.
escrow.pending: show deposit progress (anonymized) and deadlines.
escrow.ready: show "all deposits secured"; execution is about to begin.
executing: live timeline; leg-by-leg status.
completed: receipt, rating, share card.
failed: unwind timeline, refund proof, and support entrypoint.

Listing / intent state machine

active: editable/cancellable.
reserved: locked due to a proposal window or accepted cycle.
in_settlement: deposit pending or executing.
completed: linked to receipt.
expired/cancelled: relist option.

---

## Appendix B: Object Schemas (JSON)

SwapIntent (illustrative)

```json
{
  "id": "intent_123",
  "actor": { "type": "user|partner|agent", "id": "..." },
  "offer": [
    {
      "platform": "steam",
      "app_id": 730,
      "asset_id": "123",
      "class_id": "456",
      "instance_id": "0",
      "metadata": { "float": 0.12, "pattern": 321, "stickers": ["..."] },
      "proof": { "inventory_snapshot_id": "snap_789", "verified_at": "2026-02-16T18:22:00Z" }
    }
  ],
  "want_spec": {
    "type": "set",
    "any_of": [
      { "type": "specific_asset", "platform": "steam", "asset_key": "..." },
      {
        "type": "category",
        "platform": "steam",
        "app_id": 730,
        "category": "knife",
        "constraints": { "min_condition": "FT", "max_condition": "MW" }
      }
    ]
  },
  "value_band": { "min_usd": 300, "max_usd": 420, "pricing_source": "market_median" },
  "constraints": {
    "max_cycle_length": 3,
    "min_counterparty_reliability": 4.0,
    "require_escrow": true,
    "expires_at": "2026-02-20T00:00:00Z"
  }
}
```

CycleProposal (illustrative)

```json
{
  "id": "cycle_456",
  "expires_at": "2026-02-17T12:00:00Z",
  "participants": [
    { "user_id": "u1", "give": ["assetA"], "get": ["assetB"] },
    { "user_id": "u2", "give": ["assetB"], "get": ["assetC"] },
    { "user_id": "u3", "give": ["assetC"], "get": ["assetA"] }
  ],
  "confidence_score": 0.82,
  "value_spread": 0.06,
  "fee_breakdown": [{ "user_id": "u1", "fee_usd": 9.50 }],
  "explainability": [
    "All wants satisfied within stated bands",
    "3-party cycle, all participants reliability >= 4.2",
    "All assets verified within last 24h"
  ]
}
```

---

## Appendix C: Steam-First Implementation Notes

What Steam enables

High-liquidity item economies with strong asset identifiers and metadata.
Trade offers as a usable transfer primitive for deposit and release flows.
Inventory verification for tradability and holds (gates matching and settlement).

Operational notes

Escrow accounts must be treated as critical infrastructure: hardened devices, hardware keys, and strict operational procedures.
Trade holds and cooldowns must be surfaced clearly in UX and used to gate eligible items for the Vault.
Settlement must be resilient to platform outages: pause-before-release and safe recovery modes.

---

## Appendix D: Security & Key Management Notes

Receipt signing

Use rotating signing keys with well-defined rotation and revocation procedures.
Expose a public key set endpoint for partners to verify signatures.

Transparency logs

Append-only log with hash chaining; periodic Merkle roots published.
Provide inclusion proofs for receipts and escrow snapshots.
Monitor the log externally (internal watchdog plus optional third-party monitors).

---

## Appendix E: Native iOS Client Plan

E.1 Role of iOS in the network

The iOS app is a reference client that proves the API-first platform. Its job is to make time-sensitive actions (proposal acceptance, deposit deadlines, execution confirmation) fast and safe via push notifications and a crisp state-machine UI.

E.2 Architecture (recommended)

SwiftUI for most UI; small UIKit bridges only where needed.
Swift Concurrency (async/await) for networking and long-lived state.
State management: The Composable Architecture (TCA) is recommended because SwapGraph is a state machine (proposal → commit → escrow → execution).
Local persistence: SQLite (GRDB) or Core Data for cached inventory, intents, proposals, and receipts.
Networking: REST client + WebSocket (or server-sent events) for real-time timeline updates; background refresh for deadlines.

E.3 Screen map (MVP)

Inventory: grid, filters, item detail, create intent.
Listings/Intents: active, reserved, completed; edit constraints when allowed.
Inbox: proposals and active cycles; accept/decline; explainability drawer.
Settlement: deposit checklist and live execution timeline.
Receipts: receipt detail + share card (privacy-first).
Profile: reliability score, limits, connected platforms, security settings.

E.4 Push notification taxonomy

proposal.created (high priority): "Swap available" with give/get summary.
proposal.expiring: reminders with clear consequence messaging.
settlement.deposit_required and deposit_deadline_approaching.
cycle.executing and cycle.completed.
cycle.failed and refund.completed (trust-preserving).
intent.demand_signal: "Someone wants your item" (opt-in; see Appendix F).

E.5 App Store monetization note

To minimize App Store review risk, ship iOS as a companion-first client in early versions: show fees and Pro status, but do not sell subscriptions in-app until StoreKit entitlements and compliance are deliberately implemented.

---

## Appendix F: Marketplace UX and Notification Spec

F.1 Marketplace product pillars

Certainty over hype: every screen answers "what happens next" and "what happens if someone does nothing".
Fast feedback, slow commit: instant previews, explicit confirmations for irreversible steps.
Fairness you can verify: value bands, spread, and price provenance are visible.
Safety is the feature: escrow, receipts, and unwind timelines are core UI, not hidden.

F.2 Marketplace screen map (web)

Connect & Sync: platform connections, inventory scan, tradability checks.
Inventory Awakening: "Most swappable" items and recommended first intents.
Create Intent: offer selection, want set builder, tolerance band, trust constraints, urgency.
Discover: trending wants, opportunity feed, and watchlists (opt-in).
Inbox: proposals and active cycles with explainability and confidence score.
Settlement: deposit checklist, live execution timeline, and dispute entrypoints.
Receipts: completed and failed cycle receipts; share cards; history export for power users.

F.3 The "Intent on your item" demand signal

Users can express demand against a specific asset (or narrow constraint set). When the system detects that a user holds an eligible asset, it can notify them: "Demand detected for your item — potential swap." This increases liquidity by creating pull-based discovery rather than only push-based listings.

Privacy and abuse controls

Opt-in only for holders (default off).
Never reveal the demander’s identity at the signal stage.
Rate-limit signals; allow holders to mute categories or block specific assets from signals.

F.4 Automatic fulfillment mechanisms (dreamed, but buildable)

Vaulted assets (instant settlement)

Users pre-deposit items into a Vault (SwapGraph custody).
Vaulted items can be reserved and settled immediately on commit (no post-accept deposit friction).
Users can withdraw items when not reserved; withdrawals are rate-limited and may require fresh authentication for safety.

Policy-based auto-commit (agents)

Users define a TradingPolicy; their agent can accept proposals that meet policy constraints.
Server enforces policy; acceptance is logged with "why accepted" explanation.
High-value auto-commit requires passkey consent or an additional user step depending on risk tier.

F.5 Notification rules (product requirements)

Every notification includes: give/get summary, deadline, and the next required action.
Never send spam: users control categories, urgency thresholds, and quiet hours.
Use in-app inbox as source of truth; push is a reminder, not a state authority.

F.6 Delight moments (explicit, measurable)

Inventory Awakening: show immediate swap possibilities after sync.
Cycle Reveal: animate the cycle but collapse complexity to "You give X → You get Y".
Protected Failure: unwind timelines with proof to preserve trust even when cycles fail.
Receipt Pride: shareable verified receipts with privacy toggles.
