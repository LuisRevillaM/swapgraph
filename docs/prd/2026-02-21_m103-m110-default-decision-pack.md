# M103–M110 Default Decision Pack (Fast Sign-off)

Date: 2026-02-21
Status: Proposed defaults for approval (PRD-only mode)

Purpose: provide a single recommended decision posture across M103–M110 so reviewers can approve quickly without re-litigating each checklist from scratch.

## How to use
- Default stance: **approve each checklist recommendation as written**.
- If any item needs adjustment, mark it `amend` with replacement text.
- If no amendments, this pack acts as a one-shot approval baseline.

## Recommended default posture by milestone

### M103 — LP primitives + attribution
- **Default:** approve D1–D7 as written.
- Key posture:
  - keep `ActorRef` compatibility and add `LiquidityProviderRef` attribution,
  - reuse existing scope families initially,
  - require explicit LP disclosure and attribution on intent/proposal/receipt paths.
- Source checklist: `docs/prd/2026-02-21_m103-prd-review-closure.md`

### M104 — Swarm simulation contracts
- **Default:** approve D1–D7 as written.
- Key posture:
  - simulation is contract/API-parity but chain-isolated from real receipts,
  - simulation artifacts must be explicitly labeled,
  - signed continuity remains mandatory.
- Source checklist: `docs/prd/2026-02-21_m104-prd-review-closure.md`

### M105 — LP inventory/reservation lifecycle
- **Default:** approve D1–D7 as written.
- Key posture:
  - preserve current vault compatibility,
  - enforce one active reservation per asset globally,
  - keep signed reconciliation continuity.
- Source checklist: `docs/prd/2026-02-21_m105-prd-review-closure.md`

### M106 — House LP listing + decision contracts
- **Default:** approve D1–D7 as written.
- Key posture:
  - dedicated LP decision endpoints,
  - mandatory decision explainability payload,
  - trust/safety precedence over LP policy.
- Source checklist: `docs/prd/2026-02-21_m106-prd-review-closure.md`

### M107 — Operator-assisted / Steam-safe execution controls
- **Default:** approve D1–D7 as written.
- Key posture:
  - default `operator_assisted` for restricted contexts,
  - no silent automation escalation,
  - integration-gated checks + signed execution export continuity.
- Source checklist: `docs/prd/2026-02-21_m107-prd-review-closure.md`

### M108 — LP autonomy policy + anti-farming controls
- **Default:** approve D1–D7 as written.
- Key posture:
  - precedence: `safety > trust > LP autonomy > commercial > preference`,
  - mandatory anti-farming control floor,
  - deterministic policy evaluation + signed decision audit exports.
- Source checklist: `docs/prd/2026-02-21_m108-prd-review-closure.md`

### M109 — Partner LP onboarding + governance
- **Default:** approve D1–D7 as written.
- Key posture:
  - adopt BRD-04 segmentation baseline,
  - capability-gated rollout and deterministic downgrade/offboarding triggers,
  - effective-output visibility boundaries.
- Source checklist: `docs/prd/2026-02-21_m109-prd-review-closure.md`

### M110 — Transparency + user controls
- **Default:** approve D1–D7 as written.
- Key posture:
  - mandatory LP disclosure in proposal/receipt/directory surfaces,
  - explicit user controls for bot/house/partner LP matching,
  - deterministic no-silent-override behavior when preferences conflict.
- Source checklist: `docs/prd/2026-02-21_m110-prd-review-closure.md`

## Proposed one-shot approval statement
"Approve default decisions for M103–M110 as documented in `docs/prd/2026-02-21_m103-m110-default-decision-pack.md`; no amendments."

## If amendments are needed
Use this compact format:
- `M10X-DY: amend -> <replacement decision text>`

Example:
- `M107-D1: amend -> default mode = operator_assisted for Steam; constrained_auto allowed only for non-Steam adapters initially.`
