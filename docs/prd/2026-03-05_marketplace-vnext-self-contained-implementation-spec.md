# SwapGraph Marketplace vNext — Self-Contained Implementation Spec

Date: 2026-03-05  
Status: Draft (implementation spec, self-contained)  
Mode: Compatible with current PRD-first delivery discipline

## 0) Scope and Intent
This spec defines a lean Marketplace vNext layer that:
1. keeps existing `swap-intents`, cycle matching, settlement, and receipts intact,
2. adds market-native discovery/negotiation objects,
3. introduces a deterministic bridge into existing settlement primitives,
4. provides explicit auth, invariants, state machines, API contracts, reason codes, rollout gates, and test matrix.

This document is intentionally self-contained: an implementation team should be able to execute from this file without relying on external design narratives.

---

## 1) Locked Architectural Decisions
1. `SwapIntent` remains unchanged in v1 (still requires non-empty `offer`).
2. Market-native **want-first** flows are implemented as new market objects, not by relaxing `SwapIntent` in v1.
3. Matching in v1 is split into two tracks:
   - **Track A (new):** direct market pairing (`want` ↔ `post/capability`) for deal formation.
   - **Track B (existing):** cycle matcher path for swap-intent-compatible flows.
4. Existing settlement/receipt endpoints remain the finality backbone.
5. Market layer is additive; legacy `/swap-intents` and `/edge-intents` clients must remain functional.

---

## 2) Code-Truth Baseline (as of 2026-03-05)
1. `SwapIntent` requires `offer` (`minItems:1`), so pure want-only cannot live there in v1.
2. Existing edge-intent model links `source_intent_id -> target_intent_id` (intent-to-intent only).
3. Existing matcher compatibility is derived from `offer`/`want_spec` and optional explicit intent edges.
4. Settlement lifecycle + receipts APIs are already robust and reusable.
5. Auth principals and delegation already exist (`user`, `partner`, `agent`) with scope enforcement.

Implication: implement a market object layer first, with explicit bridge semantics into current finality primitives.

---

## 3) v1 Domain Model

### 3.1 MarketListingV1
**Kinds:** `post | want | capability`  
**Status:** `open | paused | closed | suspended`

Required fields:
- `listing_id`
- `workspace_id`
- `owner_actor` (`ActorRef`)
- `kind`
- `status`
- `title`
- `created_at`, `updated_at`

Kind-specific invariants:
- `post`: MUST include `offer` (>=1 asset-like reference).
- `want`: MUST NOT require `offer`.
- `capability`: MUST include `deliverable_schema` and `rate_card`.

Cross-object invariants:
- one owner actor per listing,
- one workspace per listing,
- ownership immutable after create (except admin migration flow, out-of-scope v1).

### 3.2 CapabilityProfileV1 (embedded)
Embedded under `MarketListingV1` when `kind=capability`:
- `deliverable_schema`
- `rate_card`
- `sla_hint`
- `constraints`

No standalone lifecycle object in v1.

### 3.3 MarketEdgeV1
Represents typed interest/offer/counter/block between market objects.

Required fields:
- `edge_id`
- `source_ref { kind, id }`
- `target_ref { kind, id }`
- `edge_type` (`interest | offer | counter | block`)
- `status` (`open | accepted | declined | withdrawn | expired`)
- `created_at`, `updated_at`

Optional:
- `terms_patch`
- `expires_at`

Invariant:
- only `target_ref` owner can `accept`/`decline`.

### 3.4 MarketThreadV1 / MarketMessageV1
Negotiation context for an edge or draft deal.

`MarketThreadV1`:
- `thread_id`, `workspace_id`, `participants[]`, `status(active|closed)`, timestamps.

`MarketMessageV1`:
- `message_id`, `thread_id`, `sender_actor`, `message_type(text|terms_patch|system)`, payload, timestamps.

### 3.5 DealV1
**Status:**
`draft -> pending_accept -> ready_for_settlement -> settlement_in_progress -> completed | failed | cancelled`

Required fields:
- `deal_id`
- `workspace_id`
- `participants[]`
- `source_refs[]` (listing/edge references)
- `status`
- `terms_snapshot`
- `created_at`, `updated_at`

Invariant:
- one active deal per accepted edge unless explicitly versioned by counter-offer lineage.

### 3.6 PaymentProofV1
Represents external payment proof for deal closure.

Required fields:
- `proof_id`
- `deal_id`
- `rail`
- `proof_fingerprint`
- `payer_attestation`
- `payee_attestation`
- `nonce`
- `expires_at`
- `status` (`pending | attested | consumed | rejected`)

Invariant:
- deal completion via external rail requires dual attestation and unconsumed proof.

### 3.7 ExecutionGrantV1
Non-custodial execution token for delegated settlement actions.

Required fields:
- `grant_id`
- `deal_id`
- `granted_to_actor`
- `allowed_actions[]`
- `max_uses` (must equal 1 in v1)
- `nonce`
- `expires_at` (default 10m, max 30m)
- `status` (`active | consumed | expired | revoked`)

Security invariant:
- relay encrypted envelope bytes only; never persist plaintext third-party secrets.

---

## 4) State Machines (Normative)

### 4.1 Listing transitions
- `open -> paused | closed | suspended`
- `paused -> open | closed | suspended`
- `suspended -> paused | closed` (moderation-controlled)
- `closed` terminal

### 4.2 Edge transitions
- `open -> accepted | declined | withdrawn | expired`
- `accepted` terminal for v1
- `declined`, `withdrawn`, `expired` terminal

### 4.3 Deal transitions
- `draft -> pending_accept`
- `pending_accept -> ready_for_settlement | cancelled`
- `ready_for_settlement -> settlement_in_progress | cancelled`
- `settlement_in_progress -> completed | failed`

### 4.4 PaymentProof transitions
- `pending -> attested | rejected | expired`
- `attested -> consumed | expired`
- `consumed`, `rejected`, `expired` terminal

### 4.5 ExecutionGrant transitions
- `active -> consumed | expired | revoked`
- all terminal states immutable

---

## 5) Matching Strategy

### 5.1 Track A — Direct Market Pairing (new)
Inputs:
- open `want` listings,
- open `post` and `capability` listings,
- optional negotiated constraints from edges/threads.

Output:
- deterministic `DealV1` candidates.

Determinism requirements:
- canonical candidate ordering,
- stable tie-break rules,
- deterministic pagination for feed and candidate views.

### 5.2 Track B — Existing Cycle Matcher (reuse)
Used when flow is swap-intent compatible.

Output:
- cycle proposals/commits/receipts using existing machinery.

### 5.3 Bridge Rule (required)
`POST /market/deals/{deal_id}/start-settlement` selects one path:
- `direct`: compile deal terms into settlement writes directly,
- `cycle`: compile to cycle proposal + existing commit/settlement flow.

Bridge response MUST include:
- chosen path (`direct|cycle`),
- correlation id,
- resulting finality reference (`cycle_id` or equivalent direct reference),
- deterministic reason code on failure.

---

## 6) API Contract Surface (v1 additions)
All `POST`/`PATCH` endpoints require `Idempotency-Key`.
All list/read collections require cursor pagination (`limit`, `cursor_after`).
All mutation failures require stable `reason_code`.

### 6.1 Listings
- `POST /market/listings`
- `PATCH /market/listings/{listing_id}`
- `POST /market/listings/{listing_id}/pause`
- `POST /market/listings/{listing_id}/close`
- `GET /market/listings/{listing_id}`
- `GET /market/listings`

### 6.2 Edges
- `POST /market/edges`
- `POST /market/edges/{edge_id}/accept`
- `POST /market/edges/{edge_id}/decline`
- `POST /market/edges/{edge_id}/withdraw`
- `GET /market/edges/{edge_id}`
- `GET /market/edges`

### 6.3 Threads / Messages
- `POST /market/threads`
- `GET /market/threads/{thread_id}`
- `GET /market/threads`
- `POST /market/threads/{thread_id}/messages`
- `GET /market/threads/{thread_id}/messages`

### 6.4 Deals
- `POST /market/deals`
- `POST /market/deals/{deal_id}/accept`
- `POST /market/deals/{deal_id}/cancel`
- `POST /market/deals/{deal_id}/start-settlement`
- `POST /market/deals/{deal_id}/complete`
- `GET /market/deals/{deal_id}`
- `GET /market/deals`

### 6.5 Payment proofs
- `POST /market/deals/{deal_id}/payment-proofs`
- `POST /market/deals/{deal_id}/payment-proofs/{proof_id}/attest-payer`
- `POST /market/deals/{deal_id}/payment-proofs/{proof_id}/attest-payee`
- `GET /market/deals/{deal_id}/payment-proofs/{proof_id}`

### 6.6 Execution grants
- `POST /market/deals/{deal_id}/execution-grants`
- `POST /market/deals/{deal_id}/execution-grants/{grant_id}/consume`
- `POST /market/deals/{deal_id}/execution-grants/{grant_id}/revoke`
- `GET /market/deals/{deal_id}/execution-grants/{grant_id}`

### 6.7 Feed
- `GET /market/feed`
  - response envelope:
    - `items[]` (typed listing/edge/deal/thread summaries)
    - `next_cursor`
    - `server_time`
    - optional `unread_counts`

---

## 7) Auth and Scopes
Reuse principal model (`user|partner|agent`) and delegation patterns.

Minimal new scopes:
- `market:read`
- `market:write`
- `market:moderate`
- `execution_grants:write`
- `execution_grants:consume`
- `payment_proofs:write`

Permission floor:
- listing owner controls listing lifecycle,
- edge target owner controls accept/decline,
- deal participant authz required for accept/cancel,
- execution grant consume requires grant-bound actor + nonce + TTL + single-use.

---

## 8) Abuse, Moderation, and Launch Guardrails
v1 launch controls (required):
1. IP + actor + workspace rate limits.
2. trust-tier posting quotas.
3. duplicate-content and burst detection.
4. manual moderation queue for risk-scored listings.
5. progressive unlock: `read -> post -> edge -> deal -> external-proof close`.

Moderation actions:
- set listing status `suspended`,
- block edge/deal actions with deterministic reason code,
- append immutable moderation audit entry.

---

## 9) Payment Proof and Completion Rules
`POST /market/deals/{deal_id}/complete` MUST fail unless one of:
1. internal-credit ledger checks pass (no negative net balance), OR
2. external proof exists and is:
   - dual-attested,
   - unconsumed,
   - unexpired,
   - nonce-valid.

Replay defense:
- consume proof atomically,
- reject any second consume/complete attempt with same proof fingerprint + nonce lineage.

---

## 10) Deterministic Reason-Code Catalog (minimum)
### Listings
- `market_listing_invalid`
- `market_listing_kind_invalid`
- `market_listing_status_invalid`
- `market_listing_not_found`
- `market_listing_forbidden`

### Edges
- `market_edge_invalid`
- `market_edge_not_found`
- `market_edge_target_owner_required`
- `market_edge_status_transition_invalid`

### Deals
- `market_deal_invalid`
- `market_deal_not_found`
- `market_deal_active_exists`
- `market_deal_settlement_bridge_failed`
- `market_deal_completion_blocked`

### Payment proofs
- `payment_proof_invalid`
- `payment_proof_not_found`
- `payment_proof_dual_attestation_required`
- `payment_proof_replay_detected`
- `payment_proof_expired`

### Execution grants
- `execution_grant_invalid`
- `execution_grant_not_found`
- `execution_grant_expired`
- `execution_grant_scope_denied`
- `execution_grant_replay_detected`

### Feed/query
- `market_feed_query_invalid`
- `market_cursor_not_found`

---

## 11) Rollout Milestones (gated)
Use marketplace-local milestone names to avoid conflict with global `Mxxx` numbering.

### MARKET-M1 — Listings + Edges + Feed
Exit gates:
1. want-only listing creation works with no `offer` requirement.
2. listing/edge lifecycle authz and transitions pass.
3. no regression to `/swap-intents` and `/edge-intents`.

### MARKET-M2 — Threads + Direct Deals
Exit gates:
1. thread/messages lifecycle works.
2. `want + capability` negotiation creates a deal.
3. receipt bridge for direct path is deterministic.

### MARKET-M3 — Execution Grants + External Proof
Exit gates:
1. grant replay attempts fail.
2. forged/partial proof closure is blocked.
3. completion path enforces dual attestation.

### MARKET-M4 — Open Signup Guardrails
Exit gates:
1. spam bursts are throttled,
2. moderation SLA is met,
3. no critical auth or abuse-control findings.

---

## 12) Required Test Matrix (must pass)
1. Want-only listing validates with no `offer`.
2. Edge accept/decline authz is target-owner-only.
3. `want + capability` negotiation produces a deal and receipt.
4. `post`/`want` direct deal path settles successfully.
5. Cycle-compatible flows still settle via existing cycle machinery.
6. Internal credits never allow negative net balance.
7. External proof requires dual attestation and is replay-safe.
8. Execution grants are scope-bound, one-time, and TTL-enforced.
9. Legacy `/swap-intents` and `/edge-intents` clients remain functional.
10. Feed pagination is deterministic under concurrent writes.

---

## 13) Success Metrics (first 30 days)
- Want listing creation success rate >= 99%.
- Edge-to-deal conversion >= 15% for trusted actors.
- Median time-to-first-match (want) <= 10 minutes.
- Settlement completion (accepted deals) >= 85%.
- External-proof dispute rate <= 1%.
- High-risk abuse takedown median <= 15 minutes.

---

## 14) Implementation Touchpoints (explicit)
1. Add market schemas + examples + manifest entries.
2. Add market services (listing/edge/thread/deal/payment-proof/execution-grant/feed).
3. Extend state store with market namespaces.
4. Add verifier scripts + milestone descriptors for MARKET-M1..M4.
5. Add runtime routing for market endpoints.
6. Add auth validator support for new scopes.
7. Add deterministic reason-code assertions in verifier scenarios.

This spec is considered implementation-ready once the team signs off the endpoint set, reason-code floor, and milestone gate evidence model.
