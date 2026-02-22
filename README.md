# SwapGraph

API-first multi-reciprocity swap clearing network (Steam-first initial settlement adapter).

## Canonical spec
- `docs/source/LATEST.md`

## Repo rules
- This repo is **spec-first**: every milestone must have `docs/prd/Mx.md` + `milestones/Mx.yaml` + `verify/mx.sh`.
- A milestone is only done when `node verify/runner.mjs milestones/Mx.yaml` passes.

## Quickstart
```bash
npm i
npm run verify:m0
npm run verify:baseline
npm run verify:m98
npm run verify:m99
npm run verify:m100
```

## Runtime API Shell
This repo now includes a thin HTTP transport over the existing service layer so you can run request/response validation without the milestone scripts.

```bash
npm run start:api
```

Health:
```bash
curl -s http://127.0.0.1:3005/healthz | jq
```

Seed deterministic demo fixtures (M5 intents + proposals):
```bash
curl -s -X POST http://127.0.0.1:3005/dev/seed/m5 \
  -H 'content-type: application/json' \
  -d '{"reset":true,"partner_id":"partner_demo"}' | jq
```

Example authenticated read:
```bash
curl -s http://127.0.0.1:3005/cycle-proposals \
  -H 'x-actor-type: partner' \
  -H 'x-actor-id: partner_demo' | jq
```

Auth in local runtime shell:
- `x-actor-type` + `x-actor-id` for user/partner/agent identity.
- Optional `x-auth-scopes` (comma or space-separated) when running strict auth mode (for example, `cycle_proposals:read` for `GET /cycle-proposals`).
- Delegation tokens are supported via `Authorization: Bearer sgdt1...`.
