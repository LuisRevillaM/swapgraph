# SwapGraph Experience Contract v2

**Status:** Proposal draft
**Last updated:** 2026-02-25
**Prototype:** `client-prototype/v2-feed.html`
**Supersedes:** v1 5-tab IA (Items / Intents / Inbox / Active / Receipts)

---

## 1. Object Model

Four canonical objects drive every surface, card, detail, action, and outcome across both platforms.

### 1.1 Opportunity

An **Opportunity** is a system-generated proposal telling the user "here's a swap you should consider."

| Field | Type | Source |
|---|---|---|
| `proposalId` | string | API: `/cycle-proposals` |
| `give` | Asset[] | participant.give from viewer's perspective |
| `get` | Asset[] | participant.get from viewer's perspective |
| `confidencePercent` | 0–100 | `proposal.confidenceScore × 100` |
| `valueDeltaUsd` | number | `sum(get.valueUsd) - sum(give.valueUsd)` |
| `cycleType` | "direct" \| "3-way" \| "4-way" | `participants.length` |
| `urgency` | "critical" \| "soon" \| "normal" \| "expired" | time-to-expiry bands: <1h, <6h, >6h, ≤0 |
| `expiresAt` | ISO 8601 | proposal.expiresAt |
| `explainability` | ExplainCard[] | value delta, confidence, constraint fit |
| `cycleNodes` | CycleNode[] | all participants with actor labels + give labels |
| `sourceIntentId` | string \| null | which of the user's intents this matched |

**Lifecycle:** `pending` → user decides → `accepted` \| `declined` \| `expired`

### 1.2 Intent

An **Intent** is a user-created standing order: "I'd trade X for Y under these constraints."

| Field | Type | Source |
|---|---|---|
| `intentId` | string | Generated client-side, persisted server-side |
| `offeringAsset` | Asset | selected from user inventory |
| `wantTarget` | string | category or specific asset |
| `acceptableWear` | WearTier[] | FN, MW, FT, WW, BS |
| `valueToleranceUsd` | 20 \| 50 \| 100 \| 200 | ± band |
| `maxCycleLength` | 2 \| 3 \| 4 | direct, 3-way, 4-way |
| `requireEscrow` | boolean | default true |
| `watchState` | WatchState | watching, near-matches count, cancelled |
| `proposalCount` | number | proposals matched to this intent |

**Lifecycle:** `draft` → `watching` → (`matched` → opportunity generated) \| `cancelled`

### 1.3 Cycle

A **Cycle** is an in-flight settlement — the journey from "accepted" to "receipt issued."

| Field | Type | Source |
|---|---|---|
| `cycleId` | string | API: `/settlement/{cycle_id}/status` |
| `state` | CycleState | proposed, accepted, escrow.pending, escrow.ready, executing, completed, failed |
| `legs` | Leg[] | per-participant deposit/release/refund status |
| `viewerLeg` | Leg \| null | the leg where viewer is `fromActor` |
| `waitReason` | WaitReason | code + headline + detail + deadline |
| `progressPercent` | 0–100 | stage-based |
| `actions` | CycleAction[] | confirm_deposit, open_receipt, etc. |
| `entries` | TimelineEntry[] | chronological event log |
| `deadlineAt` | ISO 8601 \| null | earliest pending deposit deadline |

**Lifecycle:**
```
proposed → accepted → escrow.pending → escrow.ready → executing → completed
                        ↓                                          ↓
                      failed ←──────────────────────────────── failed
```

### 1.4 Receipt

A **Receipt** is a verified settlement record — proof of what happened.

| Field | Type | Source |
|---|---|---|
| `receiptId` | string | API: `/receipts/{cycle_id}` |
| `cycleId` | string | originating cycle |
| `finalState` | "completed" \| "failed" | terminal outcome |
| `outcome` | "Settled" \| "Unwound" \| "Failed" | human label derived from finalState + reasonCode |
| `reasonCode` | string \| null | e.g. "deposit_timeout" |
| `gaveUsd` | number | total value of user's outbound assets |
| `receivedUsd` | number | total value of user's inbound assets |
| `feesPaidUsd` | number | total fees charged to user |
| `netDeltaUsd` | number | receivedUsd - gaveUsd - feesPaidUsd |
| `verification` | "verified" \| "partial" \| "missing" | signature metadata completeness |
| `signature` | { keyId, algorithm, signatureBytes } | cryptographic proof |
| `transparency` | Record<string, any> | additional audit fields |
| `createdAt` | ISO 8601 | when receipt was issued |

**Lifecycle:** immutable once created (terminal state).

---

## 2. Surface Architecture

### 2.1 Three surfaces

| Surface | User question | Default | Badge |
|---|---|---|---|
| **Feed** | "What should I do right now?" | Yes (home) | count of actionable items |
| **Locker** | "What do I have, and what am I hunting?" | No | — |
| **History** | "What happened?" | No | — |

### 2.2 Route structure (v2)

| Route | Surface | Deep-link kind | Params |
|---|---|---|---|
| `#/feed` | Feed | — | — |
| `#/feed/opportunity/{proposalId}` | Feed | opportunity | `proposalId` |
| `#/locker` | Locker | — | — |
| `#/locker/item/{assetId}` | Locker | item | `assetId` |
| `#/history` | History | — | — |
| `#/history/cycle/{cycleId}` | History | cycle | `cycleId` |
| `#/history/receipt/{receiptId}` | History | receipt | `receiptId` |
| `#/settings/notifications` | Overlay | settings | — |

Default fallback: `#/feed`

### 2.3 Push notification routing (v2)

| Push kind | v1 route | v2 route |
|---|---|---|
| `proposal` | `#/inbox/proposal/{id}` | `#/feed/opportunity/{id}` |
| `active` | `#/active/cycle/{id}` | `#/history/cycle/{id}` |
| `receipt` | `#/receipts/{id}` | `#/history/receipt/{id}` |

---

## 3. Interaction Layers

Every object is rendered in exactly four layers. Each layer has a defined responsibility.

### 3.1 Card (summary in stream)

The card answers "should I pay attention to this?" in a Feed or History stream.

| Object | Card content | Primary action |
|---|---|---|
| Opportunity | Give/Get names + key stats (confidence, delta, urgency, cycle type) | Tap → Detail |
| Intent (suggestion) | Item name + demand signal + prompt to trade | Tap → Composer |
| Cycle (active) | Headline + progress bar + deadline | Tap → Detail |
| Receipt | Outcome badge + item flow + net delta | Tap → Detail |

**Card rules:**
- Cards in Feed NEVER contain Accept/Decline buttons. Cards tee up decisions; Details make them.
- Feed cards have a 3px left accent stripe colored by type (signal/caution/neutral/ink-5).
- Feed shows max **5 cards** before a "Show more" control. This prevents feed overload.
- Card ranking: urgent opportunities first, then active swaps needing action, then ranked opportunities, then suggestions, then receipts.

### 3.2 Detail (decision context)

The detail surface answers "should I commit to this?" with full context.

| Object | Detail content | Where rendered |
|---|---|---|
| Opportunity | Hero give/get with full metadata, cycle graph, explainability cards, Accept/Decline buttons | Feed → slide-up sheet or full screen |
| Cycle | Full timeline with status header, progress, wait reason, state-aware actions | History → inline expand or full screen |
| Receipt | Metadata grid, verification section, value outcome, fees, transparency, liquidity providers | History → inline expand or full screen |

**Detail rules:**
- Opportunity detail is the ONLY place Accept/Decline lives. Not cards, not banners.
- Cycle detail shows the next available action with explicit disabled reasons for unavailable actions.
- Receipt detail is read-only. No mutations.

### 3.3 Action (mutation)

Actions are state-aware buttons that mutate backend state.

#### Canonical action language (cross-platform)

| Action | Object | Precondition | Label (en) | Pending label | Success feedback | Error feedback |
|---|---|---|---|---|---|---|
| `accept` | Opportunity | status=pending, not expired | "Accept swap" | "Accepting..." | Bridge overlay → History | Banner: "Accept failed: {code}" |
| `decline` | Opportunity | status=pending, not expired | "Decline" | "Declining..." | Banner: "Declined safely" | Banner: "Decline failed: {code}" |
| `post_intent` | Intent | valid draft | "Start watching" | "Posting..." | Close composer, banner: "Intent posted" | Inline errors + banner |
| `edit_intent` | Intent | valid draft, intent exists | "Save changes" | "Saving..." | Close composer, banner: "Intent updated" | Inline errors + banner |
| `cancel_intent` | Intent | intent exists, not mutating | "Cancel intent" | "Cancelling..." | Remove from list, banner: "Intent cancelled" | Banner: "Cancel failed: {code}" |
| `confirm_deposit` | Cycle | state=escrow.pending, viewer leg pending | "Confirm deposit" | "Confirming..." | Timeline refresh | Banner: "Deposit failed: {code}" |
| `open_receipt` | Cycle | state=completed \| failed | "Open receipt" | — | Navigate to receipt detail | — |

**Action rules:**
- Every action button is disabled with an explicit reason when preconditions are not met.
- Accept/Decline are idempotent — duplicate submissions are silently deduplicated.
- Pending state locks both buttons (cannot accept AND decline simultaneously).
- After a terminal decision (accepted/declined), both buttons become disabled permanently for that proposal.

### 3.4 Outcome (state feedback)

Post-action feedback tells the user "what happened and what's next."

| Action | Outcome | Next state |
|---|---|---|
| `accept` | Overlay: checkmark + "Swap accepted" + "Settlement is in flight" → auto-navigate to History | Opportunity removed from Feed, Cycle card appears in History |
| `decline` | Banner: "Declined safely. Inbox ranking will refresh." | Opportunity removed from Feed |
| `post_intent` | Composer closes. Banner: "Intent posted. Watching for matches." | Item shows watching indicator in Locker |
| `cancel_intent` | Banner: "Intent cancelled." | Watching indicator removed from Locker item |
| `confirm_deposit` | Timeline refreshes. Status headline updates. | Cycle card progress bar advances |
| Cycle completes | Receipt card appears in History. Feed card removed. | Cycle card transitions to "Settled" in History |
| Cycle fails | Receipt card appears with outcome. | Cycle card transitions to "Unwound" in History |

---

## 4. State Matrix

Every surface renders exactly one of these states at any time.

### 4.1 Surface-level states

Both platforms use a shared `FallbackState` abstraction. iOS already implements this as an enum; web should adopt the same model.

```
FallbackState:
  .loading(message)        → Skeleton cards (3 placeholder shapes)
  .empty(title, message)   → Empty state with next-action prompt
  .populated               → Normal card stream
  .retryable(title, message) → Error card with retry button (transient failures: 408, 429, 500-504)
  .blocked(title, message) → Error card without retry (auth failures: 401, 403)
  .failure(title, message) → Error card with "Contact support" (decode/unexpected failures)
  .offlineCached(savedAt)  → Cached cards + caution banner: "Offline · Showing cached data from {time}"
  .offlineEmpty            → Caution banner: "Offline · No cached data available"
  .stale                   → Normal cards + subtle "Refreshing..." indicator
```

Mapping from iOS `FallbackState` (existing in `FallbackStateView.swift`):

| iOS enum case | v2 FallbackState | When |
|---|---|---|
| `.loading(message:)` | `.loading` | First fetch, no cache |
| `.empty(title:, message:)` | `.empty` | Fetch succeeded, zero items |
| `.retryable(title:, message:)` | `.retryable` | Server error, transport error, conflict |
| `.blocked(title:, message:)` | `.blocked` | Unauthorized, forbidden |
| `.failure(title:, message:)` | `.failure` | Decoding error, bad response |

Web currently uses `loadingByTab` + `errorByTab` booleans. Migration: replace with `fallbackByTab: Record<Tab, FallbackState | null>` in the store.

### 4.2 Per-object mutation states

| State | UI treatment |
|---|---|
| `idle` | Action buttons enabled |
| `mutating` | Primary button shows pending label, all buttons disabled |
| `succeeded` | Outcome fires (see §3.4), buttons remain disabled |
| `failed` | Error banner shown, buttons re-enabled for retry |

### 4.3 Empty state copy

| Surface | Empty condition | Heading | Body | CTA |
|---|---|---|---|---|
| Feed | No proposals, no active swaps, no suggestions | "All caught up" | "The matcher is watching. New opportunities appear here." | "Open Locker" |
| Feed (no intents) | User has items but zero intents | "Post your first intent" | "Tell us what you'd trade for and the matcher starts working." | "Open Locker → tap an item" |
| Locker | Zero inventory items | "Connect your inventory" | "Link your Steam account to populate your locker." | "Connect Steam" |
| Locker (items, no intents) | Items present, zero intents | Items grid + prompt card | "Tap any item to start trading" | — |
| History | Zero cycles AND zero receipts | "No activity yet" | "Accept a proposal to start your first swap." | "Open Feed" |
| History (filtered, no matches) | Filter active, zero visible cards | "Nothing matches this filter" | "Try 'All' to see everything." | "Show all" |

### 4.4 Offline banner copy

Inherits from v1 `staleBannerCopy()` with surface names updated:

| Condition | Tone | Title | Message |
|---|---|---|---|
| Offline + cache | caution | "Offline mode" | "Showing cached {surface} data from {time}. Values may be stale." |
| Offline + no cache | caution | "Offline mode" | "No cached {surface} data available yet." |
| Back online | signal | "Back online" | "Refreshing latest marketplace state." |

---

## 5. Feed Composition Rules

The Feed is not a naive append-all-cards stream. It is a **priority-sorted, capped, mixed-type stream** with explicit rules.

### 5.1 Card types and priority tiers

| Tier | Card type | Max in feed | Sort within tier |
|---|---|---|---|
| 1 (urgent) | Opportunity with urgency=critical \| soon | 3 | by urgency order, then score |
| 2 (action needed) | Cycle with viewer action available (e.g., confirm_deposit) | 2 | by deadline proximity |
| 3 (ranked) | Opportunity with urgency=normal | 3 | by ranking score |
| 4 (suggestions) | Intent suggestion (high-demand item without intent) | 2 | by demand count desc |
| 5 (receipts) | Receipt settled in last 24h | 2 | by createdAt desc |

**Total visible without scroll:** max 5 cards. "Show {n} more" control reveals remaining.

### 5.2 Feed refresh

- On surface focus: refetch if cache TTL expired (proposals: 15s, timeline: 10s, receipts: 60s)
- On push notification: insert/update relevant card, re-sort
- On background return: full refetch
- On accept/decline: remove opportunity card, animate out, insert cycle card if accepted

### 5.3 Feed deduplication

- A cycle that originated from an accepted opportunity replaces the opportunity card — never shows both
- A receipt for a completed cycle replaces the in-flight cycle card
- Intent suggestions are suppressed for items that already have a watching intent

---

## 6. Locker Composition Rules

### 6.1 Inventory grid

- 2-column grid, sorted by demand count descending (highest demand first)
- Each card: item image, demand pip ("17 wants"), intent indicator (green dot if watching), name, price, wear
- Cards with active watching intents show inline status: "Watching · {n} near-matches"
- Tap any card → opens Composer bottom sheet with that item pre-selected

### 6.2 Composer flow (inventory-first)

1. **Entry:** Tap item in Locker → Composer opens with item pre-selected as offering
2. **Want target:** Search input with autocomplete suggestions (categories + specific items)
3. **Constraints:** Progressive disclosure panel (collapsed by default)
   - Acceptable wear: multi-select chips (FN/MW/FT/WW/BS)
   - Value tolerance: single-select chips (±$20/±$50/±$100/±$200)
   - Max cycle length: single-select chips (Direct/3-way/4-way)
4. **Submit:** "Start watching" button → posts intent → closes sheet

**Composer states:**

| State | UI |
|---|---|
| `idle` | All fields editable, submit enabled |
| `validating` | Inline errors below fields with issues |
| `submitting` | Submit button shows "Posting...", all fields disabled |
| `success` | Sheet closes, banner appears |
| `error` | Inline errors + banner, fields re-enabled |

### 6.3 Edit intent flow

- Long-press or explicit "Edit" on item with existing intent → Composer opens with `mode=edit`, fields pre-populated from `composerDraftFromIntent()`
- Submit button reads "Save changes" instead of "Start watching"

---

## 7. History Composition Rules

### 7.1 Combined stream

History merges active cycles and receipts into one chronological stream.

| Card type | When shown | Sort key |
|---|---|---|
| Cycle (in-flight) | state not terminal | latest event timestamp |
| Receipt (settled) | finalState=completed | createdAt desc |
| Receipt (unwound) | finalState=failed | createdAt desc |

### 7.2 Filter tabs

| Filter | Shows | Default |
|---|---|---|
| All | Everything | Yes |
| In flight | Cycles with non-terminal state | — |
| Settled | Receipts with finalState=completed | — |
| Unwound | Receipts with finalState=failed | — |

### 7.3 Cycle detail (inline expand)

When tapping a cycle card in History, it expands to show:
- Status header with pulsing dot, headline, wait reason
- Progress bar with "{n}/{total} deposits acknowledged"
- Deadline countdown if applicable
- Timeline event list (commit, deposits, execution, receipt/failure)
- State-aware action buttons

### 7.4 Receipt detail (inline expand)

When tapping a receipt card in History, it expands to show:
- Outcome badge (Settled/Unwound/Failed)
- Metadata grid: cycle ID, type, verification status, value delta
- Value outcome: gave/received/fees/net
- Verification metadata: key ID, algorithm, signature bytes
- Transparency fields

---

## 8. Cross-Platform Parity Contract

### 8.1 Parity rules

| Dimension | Rule |
|---|---|
| **Surfaces** | Both platforms implement Feed, Locker, History with identical card types |
| **Action labels** | Identical English copy for all action buttons (see §3.3 table) |
| **Action semantics** | Same preconditions, same optimistic update pattern, same error recovery |
| **State labels** | Same state names in UI: "Watching", "Settled", "Unwound", etc. |
| **Empty states** | Same headings and body copy (see §4.3 table) |
| **Notification model** | Unified: channels (proposal/active/receipt) + quiet hours on both platforms. iOS drops separate "urgency" picker. |
| **Design tokens** | Both platforms consume tokens from `MarketplaceClientDesignSpec.md` §8 |
| **Typography** | Both platforms use Fraunces (display), DM Sans (body), JetBrains Mono (data). iOS must stop hardcoding `.system` fonts. |
| **Deep links** | Same route structure. iOS universal links map to same surface/params. |

### 8.2 Platform-specific affordances (allowed divergences)

| Capability | iOS | Web |
|---|---|---|
| Biometric commit | Face ID / Touch ID for accept action | WebAuthn passkey |
| Haptics | Haptic feedback on accept, deposit confirm | — |
| Push display | Rich push with expandable preview | Web push notification |
| Offline storage | Core Data / GRDB | Service worker + IndexedDB |
| Share receipt | UIActivityViewController | Web Share API / clipboard |
| Navigation pattern | NavigationStack + sheets | Hash router + DOM transitions |

These are implementation details. The **user-facing experience** must be identical.

### 8.3 Notification model (unified)

Both platforms:

```
channels: {
  proposal: boolean (default: true)
  active: boolean (default: true)
  receipt: boolean (default: true)
}
quietHours: {
  enabled: boolean (default: false)
  startHour: 0–23 (default: 22)
  endHour: 0–23 (default: 7)
}
```

iOS-only `minimumUrgency` picker is removed. Urgency filtering is handled by the Feed priority tiers instead of suppressing notifications.

---

## 9. Entry Points & Exits

### 9.1 Tab navigation

| From | To | Behavior |
|---|---|---|
| Any surface | Feed tab | Navigate to `#/feed`, scroll to top |
| Any surface | Locker tab | Navigate to `#/locker`, scroll to top |
| Any surface | History tab | Navigate to `#/history`, scroll to top |

### 9.2 Push tap routing

| Push kind | Deep link | Surface focus |
|---|---|---|
| proposal | `#/feed/opportunity/{proposalId}` | Feed, auto-open opportunity detail |
| active | `#/history/cycle/{cycleId}` | History, auto-expand cycle card |
| receipt | `#/history/receipt/{receiptId}` | History, auto-expand receipt card |

### 9.3 Post-action auto-redirects

| Action | Redirect |
|---|---|
| Accept opportunity | 2.4s overlay → `#/history` (filtered to "In flight") |
| Decline opportunity | Stay on Feed, card animates out |
| Post intent from Composer | Stay on Locker, item shows watching indicator |
| Cycle completed (push) | Feed inserts receipt card at top |
| Cycle failed (push) | Feed inserts unwound receipt card at top |

### 9.4 Back navigation

| Context | Back target |
|---|---|
| Opportunity detail (in Feed) | Feed stream |
| Cycle detail (in History) | History stream |
| Receipt detail (in History) | History stream |
| Composer (bottom sheet) | Locker (sheet dismisses) |
| Notification prefs (overlay) | Previous surface |

### 9.5 Browser back button / iOS swipe-back

Hash router handles browser back. iOS NavigationStack handles swipe-back. Both return to the parent surface.

---

## 10. Recovery & Conflict Patterns

### 10.1 Retry patterns

| Failure | Retry behavior |
|---|---|
| API fetch error (proposals, timeline, receipts) | Auto-retry with exponential backoff (base 120ms, max 900ms, 2 attempts). Show error state after final failure. |
| Accept/Decline error | Re-enable buttons. Banner shows error code. User can retry immediately. |
| Intent post error | Re-enable composer fields. Inline errors + banner. User can fix and resubmit. |
| Deposit confirm error | Re-enable button. Banner shows error. User can retry. |
| Network offline | Switch to offline-cached state. Queue no mutations (mutations require network). |

### 10.2 Conflict patterns

| Conflict | Resolution |
|---|---|
| Proposal expired while user was on detail screen | On accept attempt: API returns error → banner: "This proposal has expired." → opportunity removed from Feed |
| Proposal already accepted by user in another session | API returns idempotent success → same outcome as fresh accept |
| Proposal declined by another participant while user reviews | On accept attempt: API returns conflict → banner: "Cycle no longer available." → opportunity removed |
| Intent cancelled while composer was editing | On save attempt: API returns 404 → banner: "Intent no longer exists." → close composer |
| Deposit window expired while user was about to confirm | On confirm attempt: API returns deadline error → timeline refreshes → cycle may transition to failed |
| Stale cache shows opportunity that no longer exists | On tap → detail fetch returns 404 → card removed from Feed with animation |

### 10.3 Optimistic update + rollback

All mutations follow this pattern:

```
1. Capture pre-mutation state snapshot
2. Optimistically update UI (instant feedback)
3. Fire API call
4. On success: confirm optimistic state, fire outcome
5. On failure: restore pre-mutation snapshot, show error banner, re-enable controls
```

Deduplication keys prevent double-submission:
- Intent mutations: `{mode}:{intentId}`
- Proposal decisions: `{decision}:{proposalId}`
- Active actions: `{actionKey}:{cycleId}`

---

## 11. Analytics Funnels

### 11.1 End-to-end journey funnel

Replace synthetic UX checks with real evented traces:

```
feed.viewed →
  opportunity.card_tapped →
    opportunity.detail_viewed →
      opportunity.accept_tapped →
        opportunity.accept_succeeded →
          cycle.card_viewed →
            cycle.deposit_confirmed →
              cycle.completed →
                receipt.viewed
```

Each event carries:
- `session_id`, `actor_id`
- `proposal_id` / `cycle_id` / `receipt_id` as applicable
- `latency_ms` (time since previous event in funnel)
- `surface` (feed/locker/history)
- `entry_point` (tab_tap / push_tap / deep_link / auto_redirect)

### 11.2 Drop-off measurement

| Funnel step | Healthy rate | Alert threshold |
|---|---|---|
| card_tapped / card_viewed | > 40% | < 20% |
| detail_viewed / card_tapped | > 70% | < 50% |
| accept_tapped / detail_viewed | > 30% | < 15% |
| accept_succeeded / accept_tapped | > 95% | < 80% |
| deposit_confirmed / accept_succeeded | > 90% | < 70% |
| completed / deposit_confirmed | > 85% | < 60% |

### 11.3 Interaction quality metrics

| Metric | What it measures | Target |
|---|---|---|
| Time to first intent | Session start → first intent posted | < 90s |
| Time to first accept | Session start → first proposal accepted | < 3 min (if proposals available) |
| Feed scan depth | How many cards user scrolls past before acting | < 3 cards |
| Composer abandonment | Composer opened / composer submitted | < 30% abandon |
| Decision latency | Detail viewed → accept or decline tapped | < 45s |

---

## 12. Migration Plan

### 12.1 Store changes

No store schema changes required. The v2 surfaces read from the same caches:

| v2 surface | Reads from caches |
|---|---|
| Feed | `proposals`, `intents`, `inventoryAwakening`, `timeline`, `receipts` |
| Locker | `inventoryAwakening`, `intents` |
| History | `timeline`, `receipts` |

Mutations use the same `proposalMutations`, `intentMutations`, `activeMutations`.

### 12.2 Route migration

| v1 route | v2 route | Redirect |
|---|---|---|
| `#/items` | `#/locker` | 301-style (replace) |
| `#/intents` | `#/locker` | 301-style |
| `#/inbox` | `#/feed` | 301-style |
| `#/inbox/proposal/{id}` | `#/feed/opportunity/{id}` | 301-style |
| `#/active` | `#/history` (filter: in-flight) | 301-style |
| `#/active/cycle/{id}` | `#/history/cycle/{id}` | 301-style |
| `#/receipts` | `#/history` (filter: settled) | 301-style |
| `#/receipts/{id}` | `#/history/receipt/{id}` | 301-style |

Old routes redirect to new routes so bookmarks and shared links don't break.

### 12.3 Render function migration

| v1 function | v2 replacement |
|---|---|
| `renderItems(state)` | `renderLockerSurface(state)` — inventory grid + composer trigger |
| `renderIntents(state)` | Merged into `renderLockerSurface` — intent state shown per-item |
| `renderInboxList(state)` | `renderFeedSurface(state)` — mixed-type card stream |
| `renderProposalDetail(state, id)` | `renderOpportunityDetail(state, id)` — same content, new container |
| `renderActive(state)` | `renderCycleDetail(state, id)` — embedded in History |
| `renderReceiptsList(state)` | Merged into `renderHistorySurface(state)` |
| `renderReceiptsDetail(state, id)` | `renderReceiptDetail(state, id)` — embedded in History |
| `renderComposer(state)` | `renderComposerSheet(state)` — inventory-first fields |
| `renderNotificationPrefsOverlay(state)` | `renderSettingsOverlay(state)` — unified model |
| `renderTabScreen(state)` | `renderSurface(state)` — 3-surface switch |

### 12.4 iOS migration

| v1 view | v2 replacement |
|---|---|
| `ItemsView` | `LockerView` — inventory grid with intent indicators |
| `IntentsView` | Merged into `LockerView` |
| `ProposalsView` | Feed card renderer (Opportunity cards) |
| `ProposalDetailView` | `OpportunityDetailSheet` |
| `ActiveView` | Cycle detail in `HistoryView` |
| `ReceiptsView` | Merged into `HistoryView` |
| `NotificationPreferencesView` | `SettingsSheet` with unified model |

Typography: all views must use `Typography.swift` roles instead of hardcoded `.system` fonts. This is a non-negotiable parity requirement.

### 12.5 Implementation phases

| Phase | Scope | Risk |
|---|---|---|
| **P0: Route + surface shell** | New 3-tab bar, new route definitions, old renderers mounted inside new surfaces | Low — preserves all existing functionality |
| **P1: Feed composition** | New feed renderer consuming existing proposal/timeline/receipt caches | Medium — new ranking + capping logic |
| **P2: Locker unification** | Merge items + intents into inventory grid with inline intent state | Low — UI-only change |
| **P3: History merge** | Merge active + receipts into chronological stream with filters | Low — UI-only change |
| **P4: Composer redesign** | Inventory-first flow replacing raw text fields | Medium — new autocomplete, progressive disclosure |
| **P5: Accept bridge** | Animated overlay → auto-redirect to History | Low — new overlay + setTimeout |
| **P6: iOS parity** | Port all changes to SwiftUI, enforce Typography.swift | High — most effort |
| **P7: Analytics instrumentation** | Real evented funnels replacing synthetic checks | Medium — new event schema |

---

## 13. Open Questions

- [ ] Should Opportunity detail be a full-screen push or a bottom sheet? (Sheet is faster to dismiss; full-screen gives more room for cycle graph)
- [ ] "Show more" in Feed: expand inline or paginate?
- [ ] Should the accept bridge overlay be skippable (tap to dismiss immediately)?
- [ ] Receipt sharing: clipboard link vs native share sheet vs both?
- [ ] Should Locker show items from squad feed (other pilot accounts) or only user's inventory?
- [ ] Auto-accept policies: if we add agent/policy auto-commit, does the Feed card show "Your agent accepted this" inline or as a separate card type?
- [ ] Dark mode: still deferred, or v2 is the right time to add it?

---

## 14. Changelog

| Date | Change |
|---|---|
| 2026-02-25 | v2 draft. 3-surface IA, object model, interaction layers, state matrix, feed composition rules, cross-platform parity contract, migration plan. |

---

## 15. Holistic Coverage Addendum (Gap Closure)

This addendum closes cross-cutting gaps that are required for "every screen, every interaction" readiness.

### 15.1 Session and identity lifecycle contract

| State | Trigger | Required UI behavior | Exit |
|---|---|---|---|
| `bootstrapping` | cold launch | Show skeleton on active surface. Block mutations. | first successful hydrate |
| `authenticated` | valid session | Full v2 behavior. | token expiry / manual sign-out |
| `session_expired` | API 401 | Surface falls to `.blocked` with "Session expired" CTA. Preserve intended destination route. | successful re-auth |
| `forbidden` | API 403 | `.blocked` with explicit scope message. No retry button. | role/scope change |
| `switching_account` | user account switch | Clear optimistic mutations, clear per-user caches, keep global preferences, return to `#/feed`. | new actor loaded |

Required invariant: deep-link targets (`opportunity/cycle/receipt/settings`) must survive re-auth and reopen post-login.

### 15.2 Notification permission and settings lifecycle

| Stage | Rule |
|---|---|
| pre-prompt | Ask in product copy first. Explain proposal/active/receipt value before system prompt. |
| system prompt | Trigger only after explicit user action ("Enable alerts"). |
| denied | Keep settings accessible. Show inline recovery CTA to OS settings. Do not nag repeatedly in same session. |
| enabled | Respect unified channels + quiet hours model from §8.3. |
| unsupported | Hide push toggles, keep in-app alert surfaces and history continuity. |

### 15.3 Cross-device and concurrency consistency contract

| Scenario | Required behavior |
|---|---|
| proposal accepted elsewhere | Detail action resolves idempotently. Card removed from Feed. Toast explains it was already handled. |
| proposal expired while open | Accept/decline returns conflict, detail closes, card animates out, feed re-ranked. |
| active cycle mutated elsewhere | History cycle detail refreshes on focus and push; stale actions show disabled reason until rehydrate completes. |
| receipt arrives while offline | Queue visual badge delta; on reconnect, History reconciles and marks as new. |

Data freshness invariant: on foreground resume, refresh Feed and History before first mutation is allowed.

### 15.4 Accessibility and motion contract (cross-platform)

| Area | Requirement |
|---|---|
| focus order | Surface heading -> summary -> primary cards -> tab bar -> overlays. No focus traps on sheet dismissal. |
| touch targets | Minimum 44x44 for all actionable controls. |
| semantic labels | Opportunity cards announce give/get, confidence, delta, urgency, and "tap to review". |
| reduced motion | Respect OS reduced-motion. Replace bridge animation with instant transition + status toast. |
| dynamic type | iOS and web must preserve critical stats without clipping at larger text sizes. |

### 15.5 Performance and reliability budgets for v2

| Metric | Target |
|---|---|
| feed first meaningful render (p75) | <= 1.8s |
| feed card interaction to detail open (p75) | <= 180ms |
| accept tap to visual confirmation (p75) | <= 220ms |
| history filter toggle to settled UI (p75) | <= 120ms |
| mutation failure recovery to actionable UI | <= 1.0s |

Failure budget rule: if mutation error rate > 2% for 15 minutes, auto-disable new v2 mutations via feature flag and keep read surfaces live.

### 15.6 Additional verification gates (missing in v2 draft)

| Check ID | Gate | Purpose | Evidence |
|---|---|---|---|
| `SC-UX-05` | G2 | Cross-surface continuity (Feed -> Detail -> Action -> History/Feed outcome) | deterministic scenario replay report |
| `SC-UX-06` | G2 | Session recovery continuity (deep-link preserved through re-auth) | route recovery trace |
| `SC-UX-07` | G2 | Settings discoverability and permission recovery | usability checklist + event proof |
| `SC-RL-04` | G7 | Cross-device conflict reconciliation | conflict simulation report |
| `SC-AX-04` | G4 | Reduced-motion compliance | accessibility report + video proof |
| `SC-PF-04` | G5 | Feed composition performance under mixed-card load | perf trace report |

### 15.7 Rollout and rollback contract

| Phase | Flag | Scope | Rollback action |
|---|---|---|---|
| canary | `v2_surfaces_shell` | 5% web + internal iOS build | revert to v1 tabs immediately |
| beta | `v2_feed_detail_actions` | 20% | disable v2 action layer, keep v2 read-only cards |
| ramp | `v2_history_inline_detail` | 50% | disable inline detail expansion only |
| GA | `v2_default_on` | 100% | preserve v1 route redirects for 1 release cycle |

Rollback invariant: route redirects remain valid both directions during rollout window so shared links never break.

---

## 16. Agent Execution Protocol (iOS + Web)

This section defines how expert agents execute, verify, and track work until a deterministic stop condition.

### 16.1 Agent roles and ownership

| Agent | Scope | Must not own |
|---|---|---|
| `ios-exec` | SwiftUI views/view-models, iOS routing, iOS analytics, iOS checks | web renderer/routing changes |
| `web-exec` | web surfaces/renderers/router/store, web analytics, web checks | Swift source changes |
| `parity-integrator` | parity checklist, shared copy/tokens, gate synthesis, release sign-off packet | feature implementation in either platform |

Ownership rule: every task has exactly one implementation owner and one verification owner.

### 16.2 Task state machine (mandatory)

Each task moves through this exact state machine:

`planned -> ready -> in_progress -> implemented -> verified -> accepted -> done`

| Transition | Required evidence |
|---|---|
| `planned -> ready` | dependencies closed, acceptance criteria mapped to check IDs |
| `in_progress -> implemented` | code merged to task branch + self-review notes |
| `implemented -> verified` | all mapped checks pass with artifact paths |
| `verified -> accepted` | peer agent review complete, no blocking findings |
| `accepted -> done` | parity-integrator confirms tracker row complete |

No task may skip states.

### 16.3 Execution loop per agent (repeat until stop condition)

1. Pull next `ready` task with highest dependency priority.
2. Implement minimum complete slice for that task only.
3. Run mapped checks for that task (not full suite unless gate requires).
4. Save evidence artifacts (JSON/report paths) and command transcript tail.
5. Update tracker files (see §17) and move task state.
6. Hand off for peer verification.

If any mapped check fails: task returns to `in_progress`, root cause recorded, no forward progress on that task until fixed.

### 16.4 Verification command map (platform experts)

#### Web required checks

| Check ID | Command |
|---|---|
| `SC-UX-01` | `npm run web:m2:check:sc-ux-01` |
| `SC-UX-02` | `npm run web:m3:check:sc-ux-02` |
| `SC-UX-03` | `npm run web:m4:check:sc-ux-03` |
| `SC-UX-04` | `npm run web:m5:check:sc-ux-04` |
| `SC-DS-01` | `npm run web:m1:check:sc-ds-01` |
| `SC-DS-02` | `npm run web:m1:check:sc-ds-02` |
| `SC-API-01` | `npm run web:m1:check:sc-api-01` |
| `SC-API-03` | `npm run web:m3:check:sc-api-03` |
| `SC-API-04` | `npm run web:m4:check:sc-api-04` |
| `SC-AN-01` | `npm run web:m6:check:sc-an-01` |
| `SC-AN-02` | `npm run web:m3:check:sc-an-02` |
| `SC-RL-01` | `npm run web:m6:check:sc-rl-01` |
| `SC-RL-03` | `npm run web:m6:check:sc-rl-03` |

#### iOS required checks

| Check ID | Command |
|---|---|
| `SC-UX-01` | `node scripts/ios/run-sc-ux-01.mjs` |
| `SC-UX-02` | `node scripts/ios/run-sc-ux-02.mjs` |
| `SC-UX-03` | `node scripts/ios/run-sc-ux-03.mjs` |
| `SC-UX-04` | `node scripts/ios/run-sc-ux-04.mjs` |
| `SC-DS-02` | `node scripts/ios/run-sc-ds-02.mjs` |
| `SC-AN-01` | `node scripts/ios/run-sc-an-01.mjs` |
| `SC-AN-02` | `node scripts/ios/run-sc-an-02.mjs` |
| `SC-RL-03` | `node scripts/ios/run-sc-rl-03.mjs` |
| `SC-API-03` | `node scripts/ios/run-sc-api-03.mjs` |
| `SC-API-04` | `node scripts/ios/run-sc-api-04.mjs` |

#### Cross-platform parity checks

| Check ID | Owner | Evidence |
|---|---|---|
| `PC-01` .. `PC-12` | parity-integrator | parity checklist with ios/web links |
| `SC-RR-03` | parity-integrator | final parity sign-off report |
| `SC-UX-05/06/07` | parity-integrator | continuity/session/settings scenario reports |

Verification rule: a task is not `verified` unless every mapped check command exits success and evidence files are linked in tracker.

### 16.5 Definition of correctness per task

A task is correct iff all are true:

1. Acceptance criteria are satisfied in implementation.
2. Mapped checks pass (exit code 0).
3. No regressions in required downstream checks.
4. No open severity `P0` or `P1` issue tied to that task.
5. Evidence paths are attached in tracker.

### 16.6 Work-in-progress limits

| Agent | Max concurrent `in_progress` tasks |
|---|---|
| `ios-exec` | 2 |
| `web-exec` | 2 |
| `parity-integrator` | 3 (verification/coordination only) |

Purpose: reduce partial work and verification drift.

### 16.7 Agent command playbook (deterministic)

Use this exact sequence per task:

1. Mark task `in_progress` in `artifacts/progress/v2-task-tracker.json`.
2. Implement scoped acceptance criteria.
3. Run mapped checks from `artifacts/progress/v2-check-registry.json`.
4. Attach evidence artifacts and transition state to `verified` only on pass.
5. Ask peer owner to verify and move `verified -> accepted -> done`.
6. Update gate status in `artifacts/progress/v2-gate-status.json`.

Daily stop eligibility command:

`node scripts/v2/evaluate-stop-condition.mjs`

Final stop command:

`node scripts/v2/evaluate-stop-condition.mjs --write-stop --release-candidate <tag-or-sha>`

---

## 17. Progress Tracking Contract

### 17.1 Required tracker artifacts

| File | Purpose | Updated by |
|---|---|---|
| `artifacts/progress/v2-task-tracker.json` | machine-readable source of truth for task states | all agents |
| `artifacts/progress/v2-gate-status.json` | gate-level pass/fail summary with timestamps | parity-integrator |
| `docs/reports/v2-daily-status.md` | human-readable daily digest | parity-integrator |

### 17.2 `v2-task-tracker.json` schema (mandatory fields)

```json
{
  "generated_at": "ISO-8601",
  "tasks": [
    {
      "task_id": "WEB-T021",
      "platform": "web",
      "owner": "web-exec",
      "state": "verified",
      "depends_on": ["WEB-T020"],
      "checks_required": ["SC-UX-03", "SC-API-04"],
      "checks_passed": [
        {
          "check_id": "SC-UX-03",
          "command": "npm run web:m4:check:sc-ux-03",
          "artifact": "artifacts/web-m4/sc-ux-03-active-timeline-clarity-report.json",
          "passed_at": "ISO-8601"
        }
      ],
      "blocking_issues": [],
      "last_updated_at": "ISO-8601"
    }
  ]
}
```

### 17.3 `v2-gate-status.json` schema

```json
{
  "generated_at": "ISO-8601",
  "gates": [
    {
      "gate_id": "G2",
      "status": "PASS",
      "required_checks": ["SC-UX-01", "SC-UX-02", "SC-UX-03", "SC-UX-04", "SC-UX-05", "SC-UX-06", "SC-UX-07"],
      "failing_checks": [],
      "evidence": ["docs/reports/2026-.."],
      "updated_at": "ISO-8601"
    }
  ]
}
```

### 17.4 Tracker update cadence

| Artifact | Minimum cadence |
|---|---|
| `v2-task-tracker.json` | every task state transition |
| `v2-gate-status.json` | after any check run affecting gate status |
| `v2-daily-status.md` | once per working day |

### 17.5 Non-gating track policy encoding

`artifacts/progress/v2-task-tracker.json` must include `scope_policies` for tracks that are explicitly excluded from stop gating.

Canonical v2 policy for this cycle:

```json
{
  "scope_policies": [
    {
      "track_id": "steam",
      "task_prefix": "ST-",
      "gating": false,
      "reason": "Steam integration is parallel-track and excluded from v2 stop condition."
    }
  ]
}
```

Interpretation rule:
- Any task with `task_id` prefix `ST-` is non-gating for v2 stop.
- Non-gating tasks are still tracked and may execute, but are ignored by stop evaluator task/blocker criteria.

---

## 18. Final Stop Condition (Deterministic)

Execution stops only when all conditions below are true.

### 18.1 Gate completion condition

All gates `G0`..`G9` are `PASS` in `artifacts/progress/v2-gate-status.json`.

### 18.2 Task completion condition

All v2 tasks for iOS and web are in `done` state in `artifacts/progress/v2-task-tracker.json`.

### 18.3 Quality condition

1. No open `P0` or `P1` issues.
2. No unresolved failing required checks.
3. Parity checklist `PC-01..PC-12` fully signed.
4. Rollback drill evidence exists and is passing.

### 18.4 Release evidence condition

The following must exist before stop:

1. `artifacts/release/sc-rr-03-parity-signoff-report.json`
2. `artifacts/release/final-gate-summary-report.json`
3. `docs/reports/v2-release-notes.md`
4. `artifacts/release/route-redirect-verification-report.json`

### 18.5 Stop marker

When 18.1–18.4 are all true, parity-integrator writes:

`artifacts/progress/v2-stop.json`

```json
{
  "stopped_at": "ISO-8601",
  "reason": "All gates passed, all tasks done, parity and rollback verified",
  "release_candidate": "commit-or-tag",
  "approved_by": ["ios-exec", "web-exec", "parity-integrator"]
}
```

No additional feature work may start after stop marker creation without opening a new v2.x execution cycle.

### 18.6 Steam exclusion policy for v2 stop

For this execution cycle, Steam integration is explicitly parallel-track only.

1. `ST-*` tasks are non-gating.
2. `ST-*` tasks do not affect gate pass/fail for `G0..G9`.
3. Open blockers tied only to `ST-*` tasks do not block v2 stop.
4. Steam progress should still be reported in daily status under non-gating work.
5. If a Steam issue impacts a required v2 check or gate, it must be linked to a gating task/check to become stop-blocking.

---

## 19. Operator Runbook (Daily Execution)

This is the mandatory day-to-day loop for `ios-exec`, `web-exec`, and `parity-integrator`.

### 19.1 Start-of-day checklist

1. Confirm tracker files exist and parse:
   - `artifacts/progress/v2-task-tracker.json`
   - `artifacts/progress/v2-gate-status.json`
   - `artifacts/progress/v2-check-registry.json`
2. Pull the top-priority `ready` task with all dependencies in `done`.
3. Claim task ownership by setting:
   - `state = in_progress`
   - `owner = <agent>`
   - `started_at = <ISO-8601>`
4. Record planned verification commands from check registry before code changes.

### 19.2 Per-task execution checklist

1. Implement only scoped acceptance criteria for the selected task.
2. Run each mapped check command from `v2-check-registry.json`.
3. For each passing check, append to `checks_passed`:
   - `check_id`
   - `command`
   - `artifact`
   - `passed_at`
4. If all mapped checks pass, transition:
   - `implemented -> verified`
5. Request peer verification and attach reviewer name/timestamp.
6. On peer approval:
   - `verified -> accepted -> done`

### 19.3 Failed-check handling

If any mapped check fails:

1. Task transitions to `in_progress` immediately.
2. Add blocking issue entry:
   - `issue_id`
   - `severity`
   - `check_id`
   - `summary`
3. Do not start another task until blocking issue is resolved or explicitly reassigned.

### 19.4 End-of-day checklist

1. Update `v2-gate-status.json` from latest check outcomes.
2. Publish digest in `docs/reports/v2-daily-status.md`:
   - tasks completed
   - tasks blocked
   - gate deltas
   - risks and next actions
3. Confirm tracker timestamps are current (<24h old for active items).

---

## 20. Verification Enforcement Rules

### 20.1 A check result counts only if all are true

1. Command exits with code `0`.
2. Declared artifact file exists.
3. Artifact indicates pass (for JSON artifacts: `pass=true` or `overall=true`).
4. `passed_at` timestamp is present and valid ISO-8601.

### 20.2 Gate status computation rule

A gate is `PASS` only if every required check is present in tracker evidence and valid per §20.1.

Allowed gate statuses:
- `NOT_STARTED`
- `IN_PROGRESS`
- `PASS`
- `FAIL`
- `BLOCKED`

### 20.3 Severity policy

| Severity | Definition | Effect |
|---|---|---|
| `P0` | release blocker, correctness/safety failure | blocks task and gate progression |
| `P1` | major behavior regression | blocks `accepted -> done` |
| `P2` | non-blocking quality issue | can proceed with tracked mitigation |
| `P3` | minor polish | does not block gates |

---

## 21. Progress and Forecast Computation

### 21.1 Required metrics (computed from tracker)

| Metric | Formula |
|---|---|
| task completion % | `done_tasks / total_tasks` |
| verification completion % | `verified_or_done_tasks / total_tasks` |
| gate completion % | `pass_gates / 10` |
| blocker count | `open P0 + open P1` |
| mean task cycle time | average(`done_at - started_at`) |

### 21.2 Health status thresholds

| Status | Condition |
|---|---|
| `GREEN` | gate completion >= 80%, blockers = 0 |
| `YELLOW` | gate completion 50-79% or blockers = 1 |
| `RED` | gate completion < 50% or blockers >= 2 |

### 21.3 Forecast rule

Projected completion date must be updated daily using:

`remaining_tasks / trailing_5_day_done_rate`

If projected completion slips > 3 working days, parity-integrator must publish mitigation plan in daily status.

---

## 22. Deterministic Stop Evaluator

Use script:

`node scripts/v2/evaluate-stop-condition.mjs`

This script must:

1. Validate all gates `G0..G9` are `PASS`.
2. Validate all tasks are `done`.
3. Validate no open `P0` or `P1` blocking issues.
4. Validate required progress artifacts exist:
   - `artifacts/progress/v2-task-tracker.json`
   - `artifacts/progress/v2-gate-status.json`
   - `artifacts/progress/v2-check-registry.json`
   - `docs/reports/v2-daily-status.md`
5. Validate required release evidence files from §18.4 exist.
6. Ignore non-gating tracks defined by `scope_policies` in `v2-task-tracker.json` (including `ST-*` for this cycle) when evaluating task completion and blockers.
5. Emit machine-readable evaluation result.

Optional finalization:

`node scripts/v2/evaluate-stop-condition.mjs --write-stop --release-candidate <tag-or-sha>`

Output contract:

1. Prints JSON with:
   - `pass` (boolean)
   - `failures` (array)
   - `missing_files` (array)
   - `non_done_tasks` (array)
   - `open_blockers` (array)
2. Exit code `0` only when `pass=true`, else exit code `1`.
3. When passing with `--write-stop`, writes `artifacts/progress/v2-stop.json`.
