# S0 Friends Pilot - 5 Person Execution Plan

Date: 2026-02-24  
Scope: Staging-only friends pilot for Marketplace + Steam Tier-1 readiness  
Linked baseline: `docs/reports/2026-02-24_steam-live-friends-pilot-readiness.md`

## 1) Pilot objective
- Validate end-to-end user experience with real item-like flows in a controlled cohort of 5 friends.
- Validate operator runbooks and evidence capture process before any broader rollout.
- Produce a go/no-go decision for next phase ("true Steam transfer automation" milestone).

## 2) Team and owner matrix

| Role | Owner | Responsibilities |
|---|---|---|
| Product Lead | You | Pilot scope, participant comms, go/no-go decisions |
| Ops Lead | Assigned operator | Staging guardrails, runbook execution, incident control |
| Backend Lead | Assigned engineer | Contract/preflight/live-proof verification and logs |
| Client QA Lead | Assigned engineer | iOS + web UX observation, bug triage, session tracking |
| Research Recorder | Assigned observer | Session notes, confusion points, post-session synthesis |

## 3) Participant model
- Cohort size: 5 friends.
- Access model: invite-only, pseudonymous aliases in UI.
- Credentials policy: no credential sharing between participants.
- Data policy: staging-only, low-risk inventory set.

## 4) Timeline (5 days)

| Day | Window | Owner | Deliverable | Gate |
|---|---|---|---|---|
| D-2 | 2h | Product Lead + Ops Lead | Final participant list, aliases, consent script | All participants confirmed |
| D-1 | 3h | Ops Lead + Backend Lead | Account/inventory seeding complete | Each participant has >=2 tradable assets |
| D0 | 2h | Backend Lead | Preflight and integration readiness run | `verify:m84/m85/m86` pass |
| D1 | 2h | QA Lead + Research Recorder | Session wave A (2 participants) | >=2 successful cycles |
| D2 | 3h | QA Lead + Research Recorder | Session wave B (3 participants) | >=8 additional successful cycles |
| D3 | 2h | Ops Lead + Backend Lead | Evidence bundle and continuity verification | `verify:m97` pass |
| D4 | 90m | Product Lead + all owners | Debrief and go/no-go decision | Decision memo signed |

## 5) Session script (per participant)

### Before participant starts
- Confirm alias is active and public handle is hidden.
- Confirm participant account can see seeded inventory.
- Confirm system flag posture:
  - `INTEGRATION_ENABLED` unset before setup.
  - `INTEGRATION_ENABLED=1` only during controlled execution window.

### Participant flow
1. Post one structured intent.
2. Review one proposal and choose accept or decline.
3. Follow one active timeline to receipt state.
4. Answer short survey:
   - "Did you understand what to do next at each step?"
   - "Was accept/decline confidence clear?"
   - "Was receipt meaning clear?"

### Operator flow in parallel
1. Capture evidence refs for each major event.
2. Record live proof with idempotency key.
3. Re-run same idempotency key once (replay check).
4. Log any error code/reason code with timestamp.

## 6) Mandatory command gates

Run from repo root:

```bash
npm run verify:m84
INTEGRATION_ENABLED=1 npm run verify:m85
INTEGRATION_ENABLED=1 npm run verify:m86
npm run verify:m97
```

Expected result:
- All commands exit 0.
- Latest artifacts exist and are updated.

## 7) Artifact checklist

- `artifacts/milestones/M84/latest/steam_tier1_adapter_contract_output.json`
- `artifacts/milestones/M85/latest/steam_deposit_per_swap_live_proof_output.json`
- `artifacts/milestones/M86/latest/steam_vault_live_proof_output.json`
- `artifacts/milestones/M97/latest/staging_evidence_conformance_output.json`
- `artifacts/milestones/M97/latest/commands.log`

## 8) Session logging template

Use one row per participant:

| Alias | Start time | Intent posted | Proposal decision | Receipt reached | Errors (code/reason) | Notes |
|---|---|---|---|---|---|---|
| P1 |  | yes/no | accept/decline | yes/no |  |  |
| P2 |  | yes/no | accept/decline | yes/no |  |  |
| P3 |  | yes/no | accept/decline | yes/no |  |  |
| P4 |  | yes/no | accept/decline | yes/no |  |  |
| P5 |  | yes/no | accept/decline | yes/no |  |  |

## 9) Success thresholds
- At least 10 successful end-to-end cycles across the cohort.
- No unresolved P0/P1 defects in pilot-critical flows.
- "What happens next" comprehension >=80% from post-session survey.
- Evidence continuity validated via M97 output.

## 10) Stop conditions
- Any P0 defect affecting settlement integrity.
- Repeated failure in live-proof record path under valid inputs.
- Evidence continuity/checkpoint mismatch unresolved by end of D3.
- Participant safety or policy concern flagged by Product Lead.

## 11) Go/no-go rubric for next phase
- Go if Sections 6, 7, and 9 pass with no Section 10 triggers.
- Conditional go if one non-critical threshold misses but mitigation is documented with owner/date.
- No-go if any Section 10 trigger fires or M97 conformance fails.

