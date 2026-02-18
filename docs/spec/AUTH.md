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

Delegation-token key publication / rotation:
- `GET /keys/delegation-token-signing`
- response includes `active_key_id` and key statuses (`active` / `verify_only`)
- verification is key-id based (`signature.key_id`) so previously issued tokens remain verifiable across rotation windows

Delegation-token introspection contract:
- `POST /auth/delegation-token/introspect`
- returns `{ active, reason, delegation?, details }` for deterministic lifecycle checks

#### Fixtures-first modeling
In fixtures-first verification (no HTTP layer yet), some scenarios pass auth directly, equivalent to what header parsing would produce:
- `auth.delegation`: a `DelegationGrant` object
- `auth.now_iso`: optional ISO timestamp used for deterministic delegation expiry checks in verifiers

#### Delegated policy boundaries (M37)
When actor type is `agent`, delegated reads are policy-gated at downstream boundaries:
- matching boundary: `cycleProposals.list/get`
- commit boundary: `commits.get`
- settlement boundary: `settlement.status`, `settlement.instructions`, `receipts.get`

Policy checks currently enforced at these boundaries:
- `min_confidence_score`
- `max_cycle_length`
- `quiet_hours` (for `settlement.instructions` when `auth.now_iso` is provided)

Delegated write-path policy controls (M38/M39):
- `swapIntents.create/update` enforce:
  - `max_value_per_swap_usd`
  - `max_value_per_day_usd` (UTC day bucket, deterministic via `auth.now_iso`)
  - optional `high_value_consent_threshold_usd` hook via `auth.user_consent`
- when consent-tier hardening is enabled (`POLICY_CONSENT_TIER_ENFORCE=1`), high-value actions require:
  - `auth.user_consent.consent_tier` (`step_up` or `passkey`)
  - `auth.user_consent.consent_proof` (non-empty proof handle)
  - higher-value intents may require `passkey` tier
- delegated write decisions are recorded in store-backed audit records (`policy_audit`) for deterministic proofing
- users can read audit entries via `GET /policy-audit/delegated-writes`
  - includes pagination cursor support and retention-window filtering
  - in fixtures-first, retention uses `POLICY_AUDIT_RETENTION_DAYS` and deterministic `now_iso` query override

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
