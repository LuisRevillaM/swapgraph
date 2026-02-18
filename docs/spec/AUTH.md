# Auth + scopes (v1)

SwapGraph supports multiple principal types:
- **user** (first-party clients)
- **partner** (marketplaces / integrators)
- **agent** (delegated automation)

In fixtures-first verification, we model the authenticated principal directly as an `ActorRef` in scenario operations.
In production, the principal is derived from request headers.

## Headers
### Partner auth
- `X-Partner-Key: <partner_api_key>`
  - resolves to a stable server-assigned `partner_id`
  - partner identity is modeled as `ActorRef { type:"partner", id:"<partner_id>" }`

### User auth
- `Authorization: Bearer <session_token>`
  - resolves to `ActorRef { type:"user", id:"<user_id>" }`

### Agent auth (delegation tokens)
- `Authorization: Bearer <delegation_token>`
  - resolves to `ActorRef { type:"agent", id:"<agent_id>" }`
  - also resolves to a `DelegationGrant` (who the agent may act for, what scopes it has, and a `TradingPolicy`)

In fixtures-first verification (no HTTP layer yet), we model this as:
- `auth.scopes`: the granted scopes
- `auth.delegation`: a `DelegationGrant` object (see `DelegationGrant.schema.json`)

## Scope taxonomy
Scopes are stable strings.

Core scopes (v1):
- `swap_intents:read`
- `swap_intents:write`
- `cycle_proposals:read`
- `commits:read`
- `commits:write`
- `settlement:read`
- `settlement:write`
- `receipts:read`
- `keys:read`

Notes:
- `keys:*` endpoints are public in v1 (no auth required), but we still model a scope for completeness.
- Agent scopes exist only with delegation; v1 fixtures support agent access for SwapIntents under delegation, and return `FORBIDDEN` for agent access in other services until later milestones.

## Enforcement source of truth
Endpoint scope requirements are annotated in:
- `docs/spec/api/manifest.v1.json`

Verification:
- `scripts/validate-api-auth.mjs` enforces that every endpoint declares auth + scopes.
