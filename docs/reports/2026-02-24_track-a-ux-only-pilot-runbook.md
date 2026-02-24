# Track A Runbook - UX-Only Friends Pilot (Steam Off)

Date: 2026-02-24  
Mode: UX-only pilot with synthetic marketplace data  
Primary command: `npm run start:track-a`

## 1) Purpose
- Run a fast, low-risk pilot to evaluate user comprehension and flow quality.
- Keep Steam execution work fully decoupled (no live Steam dependency).

## 2) What this mode does
- Starts local runtime API on `127.0.0.1:3005`.
- Seeds synthetic intents/proposals using `/dev/seed/m5`.
- Starts mobile-first client on `127.0.0.1:4173`.
- Forces integration gate off (`INTEGRATION_ENABLED=0`) for this stack.

## 3) Startup

From repo root:

```bash
npm run start:track-a
```

Open:
- `http://127.0.0.1:4173`

Stop:
- `Ctrl+C` (stops API + client).

## 3.1) Hosted seed + friend links (deployed runtime/web)

From repo root:

```bash
RUNTIME_SERVICE_URL=https://YOUR-RUNTIME-URL \
TRACK_A_WEB_URL=https://YOUR-WEB-URL \
npm run seed:track-a:hosted
```

What this does:
- Calls `/dev/seed/m5` on your runtime.
- Prints friend claim links (one per actor).
- Prints the themed item universe and per-friend starting item assignment.

## 4) Optional runtime overrides

```bash
TRACK_A_API_PORT=3105 TRACK_A_CLIENT_PORT=4273 npm run start:track-a
```

Supported env vars:
- `TRACK_A_API_HOST` (default `127.0.0.1`)
- `TRACK_A_API_PORT` (default `3005`)
- `TRACK_A_CLIENT_HOST` (default `127.0.0.1`)
- `TRACK_A_CLIENT_PORT` (default `4173`)
- `TRACK_A_PARTNER_ID` (default `partner_demo`)
- `TRACK_A_ACTOR_IDS` (default `u1,u2,u3,u4,u5,u6`; only fixture actor IDs are supported)
- `TRACK_A_RESET` (`1` default; set `0` to keep existing state file)
- `TRACK_A_STATE_FILE` (default `data/runtime-api-track-a.json`)
- `TRACK_A_WEB_URL` (for hosted `seed:track-a:hosted` friend claim links)

## 4.1) Participant invite links

When the stack starts, it prints per-participant links:

- `http://127.0.0.1:4173/?actor_id=u1`
- `http://127.0.0.1:4173/?actor_id=u2`
- ...

These links pin each participant to a deterministic fixture persona so proposal accept/decline actions are authorized for that actor. Keep the full `u1..u6` set for complete seeded proposal coverage.

Aliases shown in UI:
- `u1` Prompt Captain
- `u2` Agent Ops
- `u3` Bug Hunter
- `u4` Latency Slayer
- `u5` Deploy Commander
- `u6` Revenue Ranger

Themed items shown in UI:
- `assetA` Prompt Forge License
- `assetB` Agent Autopilot Pass
- `assetC` Bug Bounty Badge
- `assetD` Deploy Rocket Skin
- `assetE` Revenue Rune
- `assetF` Vibe Coding Crown

Custom actor set example:

```bash
TRACK_A_ACTOR_IDS=u1,u2,u3,u4,u5,u6 npm run start:track-a
```

## 5) Session script (per friend)
1. Post one intent.
2. Open inbox and review at least one proposal.
3. Accept or decline a proposal.
4. Follow active state to receipt.
5. Answer 3 short questions:
   - Did you always know what to do next?
   - Was accept/decline reasoning clear?
   - Was receipt outcome clear?

## 6) Data capture template

| Alias | Intent posted | Proposal decision | Reached receipt | Confusion point | Severity |
|---|---|---|---|---|---|
| P1 | yes/no | accept/decline | yes/no | free text | P0/P1/P2 |
| P2 | yes/no | accept/decline | yes/no | free text | P0/P1/P2 |
| P3 | yes/no | accept/decline | yes/no | free text | P0/P1/P2 |
| P4 | yes/no | accept/decline | yes/no | free text | P0/P1/P2 |
| P5 | yes/no | accept/decline | yes/no | free text | P0/P1/P2 |

## 7) Success criteria
- At least 5/5 participants complete full flow to receipt.
- At least 80% report clear "next action" understanding.
- No unresolved P0/P1 issues in pilot-critical path.

## 8) Stop conditions
- Any P0 that breaks intent -> proposal -> receipt progression.
- Repeated data corruption/state reset issues during session.
- Usability confusion severe enough to block >40% of participants.

## 9) Output artifact
- At end of pilot, write summary to:
  - `docs/reports/2026-02-24_track-a-pilot-results.md`
