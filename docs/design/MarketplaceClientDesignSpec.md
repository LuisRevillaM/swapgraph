# SwapGraph Marketplace Client — Design Spec

**Status:** Draft v0.1
**Last updated:** 2026-02-24
**Prototype:** `client-prototype/index.html`

---

## 1. Design Position

Every CS2 trading interface today is a dark, noisy dashboard with careless typography. They optimize for information density at the expense of readability and trust. SwapGraph's client takes the opposite position:

**The UI is the gallery wall. The items are the art.**

Light, warm, breathing. A serif display face signals seriousness. Generous spacing signals confidence. Every piece of text is readable at arm's length on a phone. Trust is communicated through clarity, not badges.

### Aesthetic references (what we're adjacent to, not copying)

- Sotheby's auction app (reverence for objects, restraint in chrome)
- Stripe Dashboard (precision, warmth, hierarchy)
- Linear (density done right — everything readable)
- NOT: cs.money, buff163, skinport, any crypto exchange

---

## 2. Typography

Three faces, each chosen for a specific job.

### Fraunces (variable serif)
- **Role:** Display headings, page titles, item names in detail views
- **Why:** Warm, slightly wonky at large optical sizes. Feels human, not corporate. No one in CS2 trading uses a serif — instant differentiation. The variable `opsz` axis adapts letterforms at every size.
- **Source:** Google Fonts (variable, opsz 9–144)

### DM Sans (humanist sans)
- **Role:** Interface text, body copy, descriptions, button labels
- **Why:** Round apertures, generous x-height, excellent legibility at small sizes. Warmer than Helvetica/Inter without being quirky.
- **Source:** Google Fonts

### JetBrains Mono (monospace)
- **Role:** All data: prices, float values, wear conditions, timestamps, constraints, badges, confidence scores
- **Why:** Engineered for reading code and numbers. Every digit is unambiguous (1/l/I, 0/O). Tabular figures for price alignment.
- **Source:** Google Fonts

---

## 3. Readability System

### The rule

> Nothing that carries information may be set below `--t-sm` (11.3px at 15px base).

Only purely decorative/supplementary text (e.g., float values overlaid on dark item images) may use `--t-xs`.

### Type scale

| Token      | rem   | px (at 15px base) | Usage                                          |
|------------|-------|--------------------|-------------------------------------------------|
| `--t-xs`   | 0.68  | 10.2               | Decorative only. Float overlays on dark images. |
| `--t-sm`   | 0.75  | 11.3               | Labels, badges, timestamps, constraints.        |
| `--t-data` | 0.75  | 11.3               | Mono data: prices, floats, wear codes.          |
| `--t-base` | 0.85  | 12.8               | Body text, descriptions, explanations.          |
| `--t-md`   | 0.95  | 14.3               | Item names, card titles.                        |
| `--t-lg`   | 1.1   | 16.5               | Section headings.                               |
| `--t-xl`   | 1.5   | 22.5               | Page titles (Fraunces display).                 |

### How to apply

- **Primary content** (item names, what you give/get): `--t-md` in DM Sans 600
- **Supporting data** (wear, price, float): `--t-data` in JetBrains Mono 500
- **Direction labels** (GIVE, GET, OFFERING, WANT): `--t-sm` in JetBrains Mono 600, uppercase
- **Section labels** (HIGHEST DEMAND, WHY THIS PROPOSAL): `--t-sm` in JetBrains Mono 500, uppercase
- **Body explanations**: `--t-base` in DM Sans 400
- **Timestamps**: `--t-sm` in JetBrains Mono 500

### Contrast requirements

All text must meet WCAG AA (4.5:1) against its background. Current ink values on the warm canvas (#F8F7F4):

| Token    | Hex     | Ratio vs canvas | Use                     |
|----------|---------|-----------------|-------------------------|
| `--ink`  | #1A1A1A | 14.8:1          | Primary text            |
| `--ink-2`| #4A4A4A | 7.9:1           | Secondary text          |
| `--ink-3`| #6B6B6B | 4.9:1           | Tertiary (labels, meta) |
| `--ink-4`| #999999 | 2.9:1           | Decorative/inactive only|

`--ink-4` does NOT pass AA for body text — it is only used for decorative elements (inactive tab icons, separator arrows) that are never the sole source of information.

---

## 4. Color System

### Canvas

| Token       | Hex     | Usage                    |
|-------------|---------|--------------------------|
| `--canvas`  | #F8F7F4 | Page background          |
| `--surface` | #FFFFFF | Card backgrounds         |
| `--well`    | #F0EFEB | Inset fields, tag fills  |

Warm, not clinical. The slight yellow warmth (#F8F7F4 vs pure #FFFFFF) reduces eye strain and differentiates from every dark-mode trading site.

### Semantic colors

| Role    | Token            | Hex     | Usage                                    |
|---------|------------------|---------|------------------------------------------|
| Signal  | `--signal`       | #1A7A4C | Positive actions, active states, trust    |
|         | `--signal-light` | #E3F2EA | Signal backgrounds (badges, banners)      |
|         | `--signal-text`  | #15653E | Signal text on light backgrounds          |
| Caution | `--caution`      | #B07B1A | Pending states, deposit deadlines         |
|         | `--caution-light`| #FBF3E0 | Caution badge backgrounds                 |
| Danger  | `--danger`       | #B8433A | Failed/unwound, errors                    |
|         | `--danger-light` | #FBE9E7 | Danger badge backgrounds                  |

### Why forest green

- Not blue (every fintech), not purple (every crypto/AI dashboard), not lime (gamey)
- Green connotes trust, growth, safety, completion
- Dark enough to work as text on light backgrounds
- Pairs with warm canvas without clashing

### Borders & shadows

| Token            | Value                                                        |
|------------------|--------------------------------------------------------------|
| `--border`       | #E8E5DF — warm, not gray                                     |
| `--border-active`| #D0CCC4 — hover/focus state                                  |
| `--shadow-sm`    | `0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.03)`   |
| `--shadow-md`    | `0 4px 12px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)`  |
| `--shadow-lg`    | `0 8px 28px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.03)`  |

Shadows are deliberately subtle — just enough to lift cards off the canvas without creating visual noise.

---

## 5. Screen Architecture

### Tab bar (5 tabs)

| Tab      | Icon | Purpose                                  |
|----------|------|------------------------------------------|
| Items    | ◇    | Inventory awakening: your tradable items  |
| Intents  | ◎    | Your standing wants (continuously matched)|
| Inbox    | ⬡    | Proposals (system-generated, not user-triggered) |
| Active   | ▸    | In-flight settlement timeline             |
| Receipts | ☰    | Verified settlement records               |

### Screen details

#### Items (home)
- **Purpose:** Inventory awakening. First thing the user sees. "Here's what you have and here's what the network wants."
- **Demand banner:** Green bar at top when proposals are waiting. Taps to Inbox.
- **Item grid:** 2-column. Each card shows skin visual (dark gradient + emoji placeholder for prototype), demand signal ("17 wants"), item name, wear badge, price.
- **Sorting:** "Highest demand" first (items most likely to generate swaps), then "Also tradable."
- **Future:** Real skin screenshots via Steam CDN. Item detail sheet on tap. Create intent directly from an item.

#### Intents
- **Purpose:** Your standing orders. The system matches against these continuously — no "run" button.
- **Card layout:** Give → Want with constraints as tags below. Live "watching" indicator with near-match count.
- **Post new intent:** Bottom sheet modal with structured fields (offering, want, acceptable wear, value tolerance, max cycle length).
- **Key insight:** Intents are not one-shot searches. They persist until the user cancels them or they're fulfilled. The "watching" state is the primary state.

#### Inbox (proposals)
- **Purpose:** Proposals arrived. Not triggered by the user — the matching engine found these.
- **Card layout:** Vertical stacked. GIVE label + item name + meta on one row. Separator. GET label + item name + meta. Footer with confidence, value delta, cycle type, time.
- **Why vertical, not side-by-side:** Side-by-side at mobile width crushes both item names and forces micro-sized labels. Vertical gives each item full width for readable names and meta.
- **Tap → Detail screen.**

#### Proposal Detail
- **Purpose:** Full explanation of a proposal. "You give X → you get Y, and here's why."
- **Exchange hero:** Large give/get cards with skin thumbnails, Fraunces serif item names, full wear + float + price metadata.
- **Cycle visualization:** Horizontal node graph (You → @player → @player → You). Shows what flows between each participant.
- **Explainability cards:** Value delta, confidence score, constraint fit. Each card has a colored dot, title, and plain-language explanation.
- **Actions:** Decline (ghost button) / Accept swap (primary green button).

#### Active Swap
- **Purpose:** Settlement timeline for in-flight swaps.
- **Status bar:** Pulsing dot + headline ("Awaiting @steel's deposit") + deadline.
- **Progress bar:** Simple horizontal fill showing steps completed.
- **Timeline:** Vertical with dots (completed/active/pending). Each event has title, description, timestamp.
- **Key states:** accepted → all committed → your deposit sent → awaiting others → executing → receipt issued.
- **Safety:** Explicit wait reasons at every state. "What happens if someone doesn't deposit" is answered by the timeline, not hidden.

#### Receipts
- **Purpose:** Verified settlement records. Proof of what happened.
- **Card layout:** Status icon (checkmark/X), item flow title, metadata (date, type, verification status), value delta.
- **Future:** Tap for full receipt with cryptographic verification details. Share card generation.

---

## 6. Interaction Patterns

### The system is always running

There is no "Run Matching Cycle" button. The matching engine operates continuously. The user's job:
1. Connect Steam → inventory is synced
2. Post intents (what you have, what you want, under what constraints)
3. Wait for proposals to arrive (push notifications)
4. Accept/decline proposals
5. Follow settlement through to receipt

The user never operates the matching engine. They set traps; the system springs them.

### Intent posting is structured, not freeform

Users build intents from structured fields:
- **Offering:** Select from inventory
- **Want:** Text input with autocomplete (item names, categories like "any CS2 knife")
- **Acceptable wear:** FN / MW / FT / WW / BS toggle tags
- **Value tolerance:** ± $20 / $50 / $100 / $200
- **Max cycle length:** Direct / 3-way / 4-way

This produces a proper SwapIntent object server-side. No ambiguity.

### Every state has a next action

From the UX principles doc: "every state has a next action or explicit wait reason." This means:
- Inventory with no intents → "Post an intent to start matching"
- Intent with 0 matches → "Watching · no matches yet" (explicit)
- Proposal in inbox → "Tap to review" → Accept or Decline
- Active swap waiting → "Awaiting @steel's deposit · 22h remaining" (who, what, when)
- Swap completed → receipt available
- Swap unwound → "Counterparty timeout · your item refunded" (what happened, what was done)

---

## 7. Platform Strategy: iOS + Web

Both clients are thin shells over the same platform APIs. They share:
- **API contract** (OpenAPI spec)
- **Design tokens** (this document, exported as JSON for both SwiftUI and CSS)
- **Copy/strings** (single source for all user-facing text)
- **Readability system** (same type scale, same minimum sizes)

### Where they diverge

| Capability          | iOS (SwiftUI + TCA)                    | Web (Next.js + React)                     |
|---------------------|----------------------------------------|-------------------------------------------|
| Intent capture      | Camera scan for inventory, haptic tags | Keyboard-first, paste-a-link              |
| Notifications       | Rich push with inline Accept action    | Web push + email digest                   |
| Settlement auth     | Face ID / Touch ID for commit          | WebAuthn / passkey                        |
| Offline             | Core Data / GRDB cache                 | Service worker + IndexedDB                |
| Distribution        | App Store, App Clips for first swap    | Zero-install URL, SEO, shareable links    |
| Real-time updates   | WebSocket, background refresh          | SSE / WebSocket, service worker           |
| Cycle visualization | SceneKit or Canvas-based               | SVG + Framer Motion                       |

**Web is the growth engine** (zero friction, shareable URLs).
**iOS is the retention engine** (push, biometrics, haptics, speed).

---

## 8. Design Token Export (for implementation)

```json
{
  "color": {
    "canvas":        "#F8F7F4",
    "surface":       "#FFFFFF",
    "well":          "#F0EFEB",
    "ink":           "#1A1A1A",
    "ink-2":         "#4A4A4A",
    "ink-3":         "#6B6B6B",
    "ink-4":         "#999999",
    "ink-5":         "#D0CEC8",
    "signal":        "#1A7A4C",
    "signal-light":  "#E3F2EA",
    "signal-text":   "#15653E",
    "caution":       "#B07B1A",
    "caution-light": "#FBF3E0",
    "danger":        "#B8433A",
    "danger-light":  "#FBE9E7",
    "border":        "#E8E5DF",
    "border-active": "#D0CCC4"
  },
  "typography": {
    "families": {
      "serif":  "Fraunces",
      "sans":   "DM Sans",
      "mono":   "JetBrains Mono"
    },
    "scale": {
      "xs":   { "rem": 0.68, "px": 10.2, "use": "decorative only" },
      "sm":   { "rem": 0.75, "px": 11.3, "use": "labels, badges, timestamps" },
      "data": { "rem": 0.75, "px": 11.3, "use": "mono data" },
      "base": { "rem": 0.85, "px": 12.8, "use": "body, descriptions" },
      "md":   { "rem": 0.95, "px": 14.3, "use": "item names, card titles" },
      "lg":   { "rem": 1.10, "px": 16.5, "use": "section headings" },
      "xl":   { "rem": 1.50, "px": 22.5, "use": "page titles" }
    },
    "readability-floor": "11.3px (--t-sm) for any informational text"
  },
  "spacing": {
    "card-padding":   "16px",
    "card-radius":    "14px",
    "card-radius-sm": "10px",
    "grid-gap":       "10px",
    "section-gap":    "22px"
  },
  "shadow": {
    "sm": "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.03)",
    "md": "0 4px 12px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.03)",
    "lg": "0 8px 28px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.03)"
  }
}
```

---

## 9. Open Questions

- [ ] Should Intents tab merge into the Items screen (each item shows its intent inline)?
- [ ] Swipe-to-accept on proposal cards (vs tap → detail → accept)?
- [ ] Dark mode variant? Or commit fully to light as the differentiator?
- [ ] Real skin image rendering strategy (Steam CDN URLs, caching, fallbacks)
- [ ] Cycle graph visualization for 4+ party cycles — horizontal scroll or radial layout?
- [ ] In-app chat/messaging per swap for coordination during settlement?
- [ ] Vaulted asset UX (pre-deposit for instant settlement)
- [ ] Agent/policy-based auto-commit UX (how to show "your agent accepted this for you")

---

## 10. Changelog

| Date       | Change                                                        |
|------------|---------------------------------------------------------------|
| 2026-02-24 | v0.1: Initial spec. Light canvas, Fraunces/DM Sans/JetBrains Mono, readability system, 5-screen architecture, prototype. |
