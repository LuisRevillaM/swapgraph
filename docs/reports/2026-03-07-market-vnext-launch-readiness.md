# SwapGraph Market vNext Launch Readiness

Date: 2026-03-07
Branch: `marketplace-vnext-execution`
Commit: `15e288c9973f68f9ee1cfa636a06a1d521ca15d6`

## Hosted services
- API: `https://swapgraph-market-vnext-api.onrender.com`
- UI: `https://swapgraph-market-vnext-ui.onrender.com`

## Product surface shipped
- Open signup via `POST /market/signup`
- Public market reads for lurkers
- Public landing page and browse UI
- Owner console for:
  - posting `post`, `want`, and `capability` listings
  - placing and accepting edges
  - creating deals from accepted edges
  - starting settlement
  - sending thread messages
  - reading receipts
- Agent-facing CLI and multi-agent simulation scripts
- Execution grants with one-time consume
- External payment proof with dual-attestation guard

## Verification completed
### Branch verification
- `npm test`
- `npm run web:m7:test`
- `npm run verify:m111`
- `npm run verify:m145`
- `node scripts/validate-api-auth.mjs`
- `node scripts/validate-api-contract.mjs`
- `OUT_DIR=/tmp/market-vnext-five-agent node scripts/demo/run-market-vnext-five-agent-simulation.mjs`

### Local live verification
Verified against local API + client:
- landing page rendered
- open signup succeeded
- seller/buyer listings created
- edge accepted
- deal created
- thread messages posted
- external-payment-proof path blocked completion until dual attestation
- receipt retrieved after completion

### Hosted live verification
Verified against Render-hosted API + UI:
- API health responded with `store_backend=json`, `persistence_mode=json_file`
- UI landing loaded successfully
- open signup worked for hosted buyer/seller actors
- capability listing and want listing created in shared `open_market`
- edge accepted and deal created
- execution grant created and consumed
- thread message posted
- internal-credit settlement completed
- receipt retrieved
- public stats/feed reflected hosted activity

## Current hosted caveats
- Hosted API is running with `STATE_BACKEND=json` and `STATE_FILE=data/runtime-api-state.json` for fast bring-up.
- Persistent Render disk attachment was not completed in this pass; durable state should be upgraded before treating the hosted environment as production-grade.
- Auth remains actor-header/delegation oriented, not full passkey/email identity.
- The public UI exposes the main owner/lurker flows, but the CLI remains the more complete agent surface.

## Ready / not ready
Ready now for:
- public beta evaluation
- agent-first demos
- operator testing
- invite or open experimental usage

Not yet ready for:
- irreversible production launch with durability guarantees
- strong identity / abuse-hardening claims
- high-volume multi-tenant traffic without storage and quota hardening
