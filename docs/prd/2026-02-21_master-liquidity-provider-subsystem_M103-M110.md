# SwapGraph Liquidity Provider Subsystem Plan (M103–M110)

Date: 2026-02-21

Goal: define an additive PRD tranche that makes a liquidity provider subsystem (house bots + partner LPs) a first-class part of the platform, without breaking the current API-first architecture.

## Operating mode (explicit)
- M103 is implementation-closed (fixtures-first).
- M104–M106 are implementation-closed (fixtures-first).
- M107 is implementation-closed (fixtures-first, integration-gated verifier mode).
- M108 is implementation-closed (fixtures-first).
- M109 is implementation-closed (fixtures-first).
- M110 is implementation-closed (fixtures-first).
- This tranche is **additive** to v2 coverage (M0–M102), not a replacement.

## Why this tranche exists
The system already has a strong clearing core (intents, proposals, commit, settlement, receipts, vault, risk controls). To make liquidity providers integral (not a hack), we need explicit contracts for:
1. LP identity/disclosure,
2. LP inventory and reservation guarantees,
3. LP decision policy + auditability,
4. operator-safe execution modes (especially Steam-first constraints),
5. user transparency and control surfaces,
6. partner LP onboarding and governance.

## Codebase integration map (inspection summary)
| Current anchor | Current state | Required LP extension |
|---|---|---|
| `docs/spec/schemas/ActorRef.schema.json` | actor types limited to `user|partner|agent` | Keep ActorRef compatibility in first tranche; add LP attribution object rather than forcing a new auth principal type immediately |
| `scripts/validate-api-auth.mjs` + `src/core/authz.mjs` | strict allowed actor types/scopes and manifest-driven auth | LP contracts should initially reuse existing scope families to avoid breaking auth validator semantics |
| `docs/spec/schemas/SwapIntent.schema.json` | strict schema (`additionalProperties:false`), no LP attribution fields | add deterministic LP attribution + disclosure fields |
| `docs/spec/schemas/CycleProposal.schema.json`, `Commit.schema.json`, `SwapReceipt.schema.json` | participant identity is ActorRef-only; no LP metadata | add LP disclosure/attribution to proposal/commit/receipt projections |
| `src/service/swapIntentsService.mjs` | idempotent intent writes with policy audit hooks | add LP-origin intent path with policy refs and explicit audit lineage |
| `src/commit/commitService.mjs` + API manifest | `cycleProposals.accept/decline` are user-only contracts | add explicit LP decision contracts (no DB shortcut path) |
| `src/settlement/settlementService.mjs` + `src/vault/vaultLifecycleService.mjs` | vault lifecycle exists (`available/reserved/withdrawn`) and settlement bindings already enforced | extend for LP operating modes and operator-assisted execution controls |
| `docs/spec/events/manifest.v1.json` | no LP-specific event taxonomy | add LP lifecycle + disclosure-related event contracts |
| `src/store/jsonStateStore.mjs` | no `liquidity_providers` / personas / policy namespace | define canonical state surfaces for LP registry, policy, decisions, and simulation runs |
| M99/M100/M101/M102 PRDs | trust/safety, metrics, product projection, and commercial policy are already scoped | bind LP subsystem contracts to these approved PRD surfaces |

## Milestone definitions

### M103 — Liquidity provider primitives + attribution contracts (**implementation-ready PRD**)
- Add canonical LP objects (`LiquidityProviderRef`, `BotPersonaRef`, `LiquidityPolicyRef`).
- Extend intent/proposal/receipt/read contracts with LP attribution + disclosure flags.
- Define LP registry/read APIs.

### M104 — Swarm simulation contracts (**implementation-ready PRD**)
- Define simulation-only liquidity sessions and sandbox settlement receipts.
- Ensure internal swarm flows use API contracts (no DB-side bypasses).
- Separate simulation artifacts from real custody/receipt surfaces.

### M105 — LP vault inventory and reservation lifecycle contracts (**implementation-ready PRD**)
- Define LP inventory accounting contracts and reservation lifecycle guarantees.
- Bind LP holdings to existing vault + settlement binding semantics.
- Add export/audit surfaces for LP inventory fulfillment guarantees.

### M106 — House LP listing + proposal participation contracts (**implementation-ready PRD**)
- Define deterministic contract path for LP listing generation and proposal participation.
- Define decision capture contracts (`accept|decline`) with reason lineage and correlation.
- Require explainable LP decisions in auditable records.

### M107 — Operator-assisted settlement and Steam-safe execution controls (**implemented, integration-gated verifier mode**) 
- Define execution modes: `simulation`, `operator_assisted`, `constrained_auto`.
- Require operator approval contracts for high-risk/platform-restricted flows.
- Tie to runbook-driven controls and deterministic denial reasons.

### M108 — LP autonomy policy + anti-farming controls (**implemented, fixtures-first**)
- Define policy-evaluation contracts for LP actions (value/risk/velocity constraints).
- Add anti-farming safeguards and exposure caps.
- Add signed LP decision audit export continuity contracts.

### M109 — Partner LP onboarding and governance contracts (**implemented, fixtures-first**)
- Define partner LP onboarding/eligibility contracts.
- Bind BRD-03/BRD-04 policy and segmentation to LP governance contracts.
- Define rollout, downgrade, and offboarding policy surfaces.

### M110 — Swarm transparency and user controls (**implemented, fixtures-first**)
- Implemented bot/persona directory and disclosure projections.
- Implemented user controls (`allow_bots`, `allow_house_liquidity`, category-level filters).
- Implemented proposal/receipt transparency disclosure payload contracts.

## Cross-tranche dependencies
- M99: trust/safety decision contracts for LP policy gating.
- M100: metrics contracts for LP impact and taper governance.
- M101: web-first projections for LP transparency and controls.
- M102: commercial and policy precedence for partner LP monetization.

## Entry gate for implementation planning (M111+)
Implementation planning for M111+ begins only when:
1. M98–M102 approval board is complete,
2. M103–M110 implementation closures are complete,
3. explicit user approval to implement is given.

## Approval board
- `docs/prd/2026-02-21_cross-agent-approval-board_M103-M110.md`

## Current review artifacts
- M103 closure checklist draft: `docs/prd/2026-02-21_m103-prd-review-closure.md`
- M104 closure checklist draft: `docs/prd/2026-02-21_m104-prd-review-closure.md`
- M105 closure checklist draft: `docs/prd/2026-02-21_m105-prd-review-closure.md`
- M106 closure checklist draft: `docs/prd/2026-02-21_m106-prd-review-closure.md`
- M107 closure checklist: `docs/prd/2026-02-21_m107-prd-review-closure.md`
- M108 closure checklist: `docs/prd/2026-02-21_m108-prd-review-closure.md`
- M109 closure checklist: `docs/prd/2026-02-21_m109-prd-review-closure.md`
- M110 closure checklist draft: `docs/prd/2026-02-21_m110-prd-review-closure.md`
- Fast sign-off proposed review baseline: `docs/prd/2026-02-21_m103-m110-proposed-review-baseline.md`
