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

#### Delegation token format (v1)
- Prefix: `sgdt1.`
- Payload: base64url(canonical_json(DelegationToken))

Where `DelegationToken` is:
- `docs/spec/schemas/DelegationToken.schema.json`

Signature bytes are computed over:
- canonical_json(token_without_signature)

Server-side parsing/verification in fixtures-first:
- `src/core/authHeaders.mjs` parses `Authorization` and verifies token signature
- `src/core/authz.mjs` enforces revocation/expiry and scopes (including persisted revocations)

#### Fixtures-first modeling
In fixtures-first verification (no HTTP layer yet), some scenarios pass auth directly, equivalent to what header parsing would produce:
- `auth.delegation`: a `DelegationGrant` object
- `auth.now_iso`: optional ISO timestamp used for deterministic delegation expiry checks in verifiers

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
- `delegations:read`
- `delegations:write`

Notes:
- `keys:*` endpoints are public in v1 (no auth required), but we still model a scope for completeness.
- `delegations:*` endpoints are user-scoped in v1 (users create/revoke grants for their own user identity).
- Agent scopes exist only with delegation; v1 fixtures support agent access for SwapIntents and reads under delegation (when `AUTHZ_ENFORCE=1`).

## Enforcement source of truth
Endpoint scope requirements are annotated in:
- `docs/spec/api/manifest.v1.json`

Verification:
- `scripts/validate-api-auth.mjs` enforces that every endpoint declares auth + scopes.
