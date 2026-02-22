import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

const PROVIDER_TYPES = new Set(['user', 'house_bot', 'partner_lp']);
const ACTOR_TYPES = new Set(['user', 'partner', 'agent']);

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorResponse(correlationIdValue, code, message, details = {}) {
  return {
    correlation_id: correlationIdValue,
    error: {
      code,
      message,
      details
    }
  };
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.liquidity_providers ||= {};
  store.state.liquidity_provider_personas ||= {};
  store.state.liquidity_provider_counter ||= 0;
  store.state.liquidity_provider_persona_counter ||= 0;
}

function nextProviderId(store) {
  store.state.liquidity_provider_counter += 1;
  return `lp_${String(store.state.liquidity_provider_counter).padStart(6, '0')}`;
}

function nextPersonaId(store) {
  store.state.liquidity_provider_persona_counter += 1;
  return `lp_persona_${String(store.state.liquidity_provider_persona_counter).padStart(6, '0')}`;
}

function normalizePolicyRef(policy) {
  if (policy === undefined || policy === null) return { ok: true, value: null };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { ok: false, reason_code: 'liquidity_provider_invalid' };
  }

  const policyId = normalizeOptionalString(policy.policy_id);
  const policyVersion = Number.parseInt(String(policy.policy_version ?? ''), 10);
  const policyMode = normalizeOptionalString(policy.policy_mode);
  const constraintsHash = normalizeOptionalString(policy.constraints_hash);

  if (!policyId || !Number.isFinite(policyVersion) || policyVersion < 1 || !policyMode || !constraintsHash) {
    return { ok: false, reason_code: 'liquidity_provider_invalid' };
  }

  return {
    ok: true,
    value: {
      policy_id: policyId,
      policy_version: policyVersion,
      policy_mode: policyMode,
      constraints_hash: constraintsHash
    }
  };
}

function normalizeProviderRecord(record) {
  const out = {
    provider_id: record.provider_id,
    provider_type: record.provider_type,
    owner_actor: clone(record.owner_actor),
    is_automated: record.is_automated,
    is_house_inventory: record.is_house_inventory,
    label_required: record.label_required,
    display_label: record.display_label,
    disclosure_text: record.disclosure_text,
    active: record.active,
    created_at: record.created_at,
    updated_at: record.updated_at
  };

  if (record.policy_ref) out.policy_ref = clone(record.policy_ref);
  if (record.persona_ref) out.persona_ref = clone(record.persona_ref);

  return out;
}

function normalizePersonaRecord(record) {
  return {
    provider_id: record.provider_id,
    persona_id: record.persona_id,
    display_name: record.display_name,
    strategy_summary: record.strategy_summary,
    disclosure_text: record.disclosure_text,
    active: record.active,
    updated_at: record.updated_at
  };
}

export class LiquidityProviderService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _requirePartner({ actor, correlationId: corr, operationId }) {
    if (actor?.type === 'partner' && normalizeOptionalString(actor?.id)) return null;
    return {
      ok: false,
      body: errorResponse(corr, 'FORBIDDEN', 'only partner actors are allowed for liquidity provider operations', {
        operation_id: operationId,
        reason_code: 'liquidity_provider_actor_mismatch',
        actor: actor ?? null
      })
    };
  }

  _authorize({ actor, auth, operationId, correlationId: corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
      };
    }
    return { ok: true };
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const requestHash = payloadHash(requestBody);
    const existing = this.store.state.idempotency[scopeKey];

    if (existing) {
      if (existing.payload_hash === requestHash) {
        return {
          replayed: true,
          result: clone(existing.result)
        };
      }

      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', {
            operation_id: operationId,
            idempotency_key: idempotencyKey
          })
        }
      };
    }

    const result = handler();
    this.store.state.idempotency[scopeKey] = {
      payload_hash: requestHash,
      result: clone(result)
    };

    return { replayed: false, result };
  }

  _normalizeProviderRequest({ requestProvider, actor, recordedAt, correlationId: corr }) {
    if (!requestProvider || typeof requestProvider !== 'object' || Array.isArray(requestProvider)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity provider payload', {
          reason_code: 'liquidity_provider_invalid'
        })
      };
    }

    const providerType = normalizeOptionalString(requestProvider.provider_type);
    if (!providerType || !PROVIDER_TYPES.has(providerType) || providerType === 'user') {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'unsupported liquidity provider type', {
          reason_code: 'liquidity_provider_type_invalid',
          provider_type: providerType,
          allowed_types: ['house_bot', 'partner_lp']
        })
      };
    }

    const ownerType = normalizeOptionalString(requestProvider?.owner_actor?.type);
    const ownerId = normalizeOptionalString(requestProvider?.owner_actor?.id);
    if (!ownerType || !ownerId || !ACTOR_TYPES.has(ownerType)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity provider owner actor', {
          reason_code: 'liquidity_provider_invalid'
        })
      };
    }

    if (ownerType !== 'partner' || ownerId !== actor.id) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'liquidity provider owner actor does not match caller', {
          reason_code: 'liquidity_provider_actor_mismatch',
          owner_actor: { type: ownerType, id: ownerId },
          actor
        })
      };
    }

    if (typeof requestProvider.is_automated !== 'boolean' || typeof requestProvider.is_house_inventory !== 'boolean' || typeof requestProvider.label_required !== 'boolean') {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity provider flags', {
          reason_code: 'liquidity_provider_invalid'
        })
      };
    }

    if (providerType === 'house_bot' && requestProvider.is_automated !== true) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'house_bot providers must be automated', {
          reason_code: 'liquidity_provider_type_invalid',
          provider_type: providerType
        })
      };
    }

    const displayLabel = normalizeOptionalString(requestProvider.display_label);
    const disclosureText = normalizeOptionalString(requestProvider.disclosure_text);
    if (requestProvider.label_required && (!displayLabel || !disclosureText)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'liquidity provider disclosure is required', {
          reason_code: 'liquidity_provider_disclosure_required'
        })
      };
    }

    const active = requestProvider.active === undefined ? true : requestProvider.active;
    if (typeof active !== 'boolean') {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity provider payload', {
          reason_code: 'liquidity_provider_invalid'
        })
      };
    }

    const policy = normalizePolicyRef(requestProvider.policy_ref);
    if (!policy.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity provider policy reference', {
          reason_code: policy.reason_code
        })
      };
    }

    return {
      ok: true,
      value: {
        provider_type: providerType,
        owner_actor: { type: ownerType, id: ownerId },
        is_automated: requestProvider.is_automated,
        is_house_inventory: requestProvider.is_house_inventory,
        label_required: requestProvider.label_required,
        display_label: displayLabel,
        disclosure_text: disclosureText,
        active,
        policy_ref: policy.value,
        recorded_at: recordedAt
      }
    };
  }

  register({ actor, auth, idempotencyKey, request }) {
    const op = 'liquidityProviders.register';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, correlationId: corr, operationId: op });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const recordedAt = normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity provider timestamp', {
              reason_code: 'liquidity_provider_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const normalized = this._normalizeProviderRequest({
          requestProvider: request?.provider,
          actor,
          recordedAt,
          correlationId: corr
        });
        if (!normalized.ok) return { ok: false, body: normalized.body };

        const requestedProviderId = normalizeOptionalString(request?.provider?.provider_id);
        const providerId = requestedProviderId ?? nextProviderId(this.store);
        const existing = this.store.state.liquidity_providers[providerId];
        if (existing) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'liquidity provider already exists', {
              reason_code: 'liquidity_provider_invalid',
              provider_id: providerId
            })
          };
        }

        const providerRecord = {
          provider_id: providerId,
          provider_type: normalized.value.provider_type,
          owner_actor: normalized.value.owner_actor,
          is_automated: normalized.value.is_automated,
          is_house_inventory: normalized.value.is_house_inventory,
          label_required: normalized.value.label_required,
          display_label: normalized.value.display_label,
          disclosure_text: normalized.value.disclosure_text,
          active: normalized.value.active,
          created_at: recordedAt,
          updated_at: recordedAt
        };

        if (normalized.value.policy_ref) {
          providerRecord.policy_ref = normalized.value.policy_ref;
        }

        this.store.state.liquidity_providers[providerId] = providerRecord;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider: normalizeProviderRecord(providerRecord)
          }
        };
      }
    });
  }

  get({ actor, auth, providerId }) {
    const op = 'liquidityProviders.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, correlationId: corr, operationId: op });
    if (partnerGuard) return partnerGuard;

    const normalizedProviderId = normalizeOptionalString(providerId);
    if (!normalizedProviderId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'provider_id is required', {
          reason_code: 'liquidity_provider_invalid'
        })
      };
    }

    const provider = this.store.state.liquidity_providers[normalizedProviderId];
    if (!provider) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'liquidity provider not found', {
          reason_code: 'liquidity_provider_not_found',
          provider_id: normalizedProviderId
        })
      };
    }

    if (provider.owner_actor?.type !== 'partner' || provider.owner_actor?.id !== actor.id) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'liquidity provider owner actor does not match caller', {
          reason_code: 'liquidity_provider_actor_mismatch',
          provider_id: normalizedProviderId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider: normalizeProviderRecord(provider)
      }
    };
  }

  list({ actor, auth, query }) {
    const op = 'liquidityProviders.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, correlationId: corr, operationId: op });
    if (partnerGuard) return partnerGuard;

    const providerTypeFilter = normalizeOptionalString(query?.provider_type);
    if (providerTypeFilter && !PROVIDER_TYPES.has(providerTypeFilter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity provider type filter', {
          reason_code: 'liquidity_provider_type_invalid',
          provider_type: providerTypeFilter
        })
      };
    }

    const providers = Object.values(this.store.state.liquidity_providers ?? {})
      .filter(provider => provider?.owner_actor?.type === 'partner' && provider?.owner_actor?.id === actor.id)
      .filter(provider => !providerTypeFilter || provider.provider_type === providerTypeFilter)
      .map(normalizeProviderRecord)
      .sort((a, b) => String(a.provider_id).localeCompare(String(b.provider_id)));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        providers
      }
    };
  }

  upsertPersona({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityProviders.persona.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, correlationId: corr, operationId: op });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: providerId, request },
      correlationId: corr,
      handler: () => {
        const normalizedProviderId = normalizeOptionalString(providerId);
        if (!normalizedProviderId) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'provider_id is required', {
              reason_code: 'liquidity_provider_invalid'
            })
          };
        }

        const provider = this.store.state.liquidity_providers[normalizedProviderId];
        if (!provider) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'liquidity provider not found', {
              reason_code: 'liquidity_provider_not_found',
              provider_id: normalizedProviderId
            })
          };
        }

        if (provider.owner_actor?.type !== 'partner' || provider.owner_actor?.id !== actor.id) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'liquidity provider owner actor does not match caller', {
              reason_code: 'liquidity_provider_actor_mismatch',
              provider_id: normalizedProviderId
            })
          };
        }

        const recordedAt = normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid persona timestamp', {
              reason_code: 'liquidity_provider_persona_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const persona = request?.persona;
        const existing = this.store.state.liquidity_provider_personas[normalizedProviderId] ?? null;
        const personaId = normalizeOptionalString(persona?.persona_id) ?? existing?.persona_id ?? nextPersonaId(this.store);
        const displayName = normalizeOptionalString(persona?.display_name);
        const strategySummary = normalizeOptionalString(persona?.strategy_summary);
        const disclosureText = normalizeOptionalString(persona?.disclosure_text);
        const active = persona?.active === undefined ? (existing?.active ?? true) : persona.active;

        if (!personaId || !displayName || !strategySummary || !disclosureText || typeof active !== 'boolean') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity provider persona payload', {
              reason_code: 'liquidity_provider_persona_invalid'
            })
          };
        }

        if (provider.label_required && !disclosureText) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'liquidity provider disclosure is required', {
              reason_code: 'liquidity_provider_disclosure_required',
              provider_id: normalizedProviderId
            })
          };
        }

        const personaRecord = {
          provider_id: normalizedProviderId,
          persona_id: personaId,
          display_name: displayName,
          strategy_summary: strategySummary,
          disclosure_text: disclosureText,
          active,
          updated_at: recordedAt
        };

        this.store.state.liquidity_provider_personas[normalizedProviderId] = personaRecord;
        provider.persona_ref = normalizePersonaRecord(personaRecord);
        provider.updated_at = recordedAt;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: normalizedProviderId,
            persona: normalizePersonaRecord(personaRecord),
            provider: normalizeProviderRecord(provider)
          }
        };
      }
    });
  }
}
