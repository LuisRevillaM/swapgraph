import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

const PROVIDER_TYPES = new Set(['house_bot', 'partner_lp', 'user']);
const NO_ELIGIBLE_BEHAVIOR = 'no_match';

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

function parseLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
}

function parseBooleanLike(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;

  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) return fallback;

  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return null;
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

function actorScopeKey(actor) {
  return `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}`;
}

function deterministicId(prefix, input) {
  const digest = createHash('sha256').update(String(input), 'utf8').digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.liquidity_providers ||= {};
  store.state.liquidity_provider_personas ||= {};
  store.state.liquidity_decisions ||= {};
  store.state.counterparty_preferences ||= {};
  store.state.proposals ||= {};
  store.state.timelines ||= {};
  store.state.receipts ||= {};
  store.state.intents ||= {};
  store.state.tenancy ||= {};
  store.state.tenancy.proposals ||= {};
  store.state.tenancy.cycles ||= {};
}

function defaultCounterpartyPreferences({ actor, nowIso }) {
  return {
    actor: {
      type: actor?.type ?? 'unknown',
      id: actor?.id ?? 'unknown'
    },
    allow_bots: true,
    allow_house_liquidity: true,
    allow_partner_lp: true,
    category_filters: [],
    no_eligible_counterparty_behavior: NO_ELIGIBLE_BEHAVIOR,
    updated_at: nowIso
  };
}

function normalizeCategoryFilters(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;

  const out = [];
  const seen = new Set();

  for (const rule of raw) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;

    const category = normalizeOptionalString(rule.category)?.toLowerCase();
    const allow = rule.allow;

    if (!category || typeof allow !== 'boolean' || seen.has(category)) return null;

    seen.add(category);
    out.push({ category, allow });
  }

  out.sort((a, b) => a.category.localeCompare(b.category));
  return out;
}

function normalizeCounterpartyPreferences(record) {
  return {
    actor: {
      type: record.actor.type,
      id: record.actor.id
    },
    allow_bots: record.allow_bots === true,
    allow_house_liquidity: record.allow_house_liquidity === true,
    allow_partner_lp: record.allow_partner_lp === true,
    category_filters: clone(record.category_filters ?? []),
    no_eligible_counterparty_behavior: NO_ELIGIBLE_BEHAVIOR,
    updated_at: record.updated_at
  };
}

function proposalPartnerId({ store, proposalId }) {
  return store?.state?.tenancy?.proposals?.[proposalId]?.partner_id
    ?? store?.state?.tenancy?.cycles?.[proposalId]?.partner_id
    ?? null;
}

function userParticipatesInProposal({ actor, proposal }) {
  if (actor?.type !== 'user') return false;
  return (proposal?.participants ?? []).some(participant => participant?.actor?.type === 'user' && participant?.actor?.id === actor.id);
}

function userParticipatesInTimeline({ actor, timeline }) {
  if (actor?.type !== 'user') return false;
  return (timeline?.legs ?? []).some(leg => leg?.from_actor?.type === 'user' && leg?.from_actor?.id === actor.id)
    || (timeline?.legs ?? []).some(leg => leg?.to_actor?.type === 'user' && leg?.to_actor?.id === actor.id);
}

function actorCanReadProposal({ store, actor, proposalId, proposal }) {
  if (!actor || !proposalId || !proposal) return false;

  if (actor.type === 'partner') return proposalPartnerId({ store, proposalId }) === actor.id;
  if (actor.type === 'user') return userParticipatesInProposal({ actor, proposal });
  return false;
}

function actorCanReadCycle({ store, actor, cycleId }) {
  if (!actor || !cycleId) return false;

  if (actor.type === 'partner') return proposalPartnerId({ store, proposalId: cycleId }) === actor.id;

  if (actor.type === 'user') {
    const proposal = store.state?.proposals?.[cycleId] ?? null;
    if (proposal && userParticipatesInProposal({ actor, proposal })) return true;

    const timeline = store.state?.timelines?.[cycleId] ?? null;
    if (timeline && userParticipatesInTimeline({ actor, timeline })) return true;
  }

  return false;
}

function isValidPolicyRef(policyRef) {
  return !!policyRef
    && typeof policyRef === 'object'
    && !Array.isArray(policyRef)
    && normalizeOptionalString(policyRef.policy_id)
    && Number.isFinite(Number.parseInt(String(policyRef.policy_version ?? ''), 10))
    && Number.parseInt(String(policyRef.policy_version ?? ''), 10) >= 1
    && normalizeOptionalString(policyRef.policy_mode)
    && normalizeOptionalString(policyRef.constraints_hash);
}

function normalizePersonaForDisclosure(persona, { providerId, nowIso }) {
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return null;

  const personaId = normalizeOptionalString(persona.persona_id);
  const displayName = normalizeOptionalString(persona.display_name);
  const strategySummary = normalizeOptionalString(persona.strategy_summary);
  const disclosureText = normalizeOptionalString(persona.disclosure_text);
  const active = typeof persona.active === 'boolean' ? persona.active : true;
  const updatedAt = normalizeOptionalString(persona.updated_at) ?? nowIso;

  if (!personaId || !displayName || !strategySummary || !disclosureText || parseIsoMs(updatedAt) === null) return null;

  return {
    provider_id: normalizeOptionalString(persona.provider_id) ?? providerId,
    persona_id: personaId,
    display_name: displayName,
    strategy_summary: strategySummary,
    disclosure_text: disclosureText,
    active,
    updated_at: updatedAt
  };
}

function normalizeProviderForDisclosure(provider, { providerIdHint, nowIso }) {
  const fallbackProviderId = normalizeOptionalString(providerIdHint) ?? 'lp_unknown';
  const providerId = normalizeOptionalString(provider?.provider_id) ?? fallbackProviderId;
  const providerType = normalizeOptionalString(provider?.provider_type);
  const actorType = normalizeOptionalString(provider?.owner_actor?.type) ?? 'partner';
  const actorId = normalizeOptionalString(provider?.owner_actor?.id) ?? 'unknown';
  const displayLabel = normalizeOptionalString(provider?.display_label) ?? providerId;
  const disclosureText = normalizeOptionalString(provider?.disclosure_text) ?? 'Liquidity provider counterparty.';
  const createdAt = normalizeOptionalString(provider?.created_at) ?? nowIso;
  const updatedAt = normalizeOptionalString(provider?.updated_at) ?? nowIso;

  const normalized = {
    provider_id: providerId,
    provider_type: PROVIDER_TYPES.has(providerType) ? providerType : 'partner_lp',
    owner_actor: {
      type: actorType,
      id: actorId
    },
    is_automated: provider?.is_automated === true,
    is_house_inventory: provider?.is_house_inventory === true,
    label_required: provider?.label_required !== false,
    display_label: displayLabel,
    disclosure_text: disclosureText,
    active: provider?.active !== false,
    created_at: parseIsoMs(createdAt) === null ? nowIso : createdAt,
    updated_at: parseIsoMs(updatedAt) === null ? nowIso : updatedAt
  };

  if (isValidPolicyRef(provider?.policy_ref)) {
    normalized.policy_ref = {
      policy_id: provider.policy_ref.policy_id,
      policy_version: Number.parseInt(String(provider.policy_ref.policy_version), 10),
      policy_mode: provider.policy_ref.policy_mode,
      constraints_hash: provider.policy_ref.constraints_hash
    };
  }

  const personaRef = normalizePersonaForDisclosure(provider?.persona_ref, {
    providerId: normalized.provider_id,
    nowIso
  });
  if (personaRef) normalized.persona_ref = personaRef;

  return normalized;
}

function providerCategories(providerRef) {
  const out = new Set();
  const providerType = normalizeOptionalString(providerRef?.provider_type);

  if (providerType) out.add(providerType);
  if (providerRef?.is_automated === true) out.add('automated');
  if (providerRef?.is_house_inventory === true) out.add('house_inventory');
  if (providerRef?.provider_type === 'house_bot') out.add('house_bot');
  if (providerRef?.provider_type === 'partner_lp') out.add('partner_lp');
  if (providerRef?.is_automated !== true) out.add('manual');

  return Array.from(out).sort();
}

function evaluatePreferencesForProvider({ preferences, providerRef }) {
  const blocked = [];

  if (providerRef.is_automated && preferences.allow_bots !== true) blocked.push('counterparty_preferences_conflict');
  if (providerRef.is_house_inventory && preferences.allow_house_liquidity !== true) blocked.push('counterparty_preferences_conflict');
  if (providerRef.provider_type === 'partner_lp' && preferences.allow_partner_lp !== true) blocked.push('counterparty_preferences_conflict');

  const categories = providerCategories(providerRef);
  for (const rule of preferences.category_filters ?? []) {
    if (rule.allow === false && categories.includes(rule.category)) {
      blocked.push('counterparty_preferences_conflict');
    }
  }

  const blockedReasonCodes = Array.from(new Set(blocked)).sort();
  return {
    allowed: blockedReasonCodes.length === 0,
    blocked_reason_codes: blockedReasonCodes
  };
}

function findLatestDecisionForProvider({ store, proposalId, providerId }) {
  const rows = Object.values(store.state?.liquidity_decisions ?? {})
    .filter(row => row?.proposal_id === proposalId && row?.provider_id === providerId)
    .sort((a, b) => {
      const aMs = parseIsoMs(a?.recorded_at) ?? 0;
      const bMs = parseIsoMs(b?.recorded_at) ?? 0;
      if (aMs !== bMs) return aMs - bMs;
      return String(a?.decision_id ?? '').localeCompare(String(b?.decision_id ?? ''));
    });

  return rows.length > 0 ? rows[rows.length - 1] : null;
}

function decisionRationale(decision) {
  if (!decision) {
    return {
      reference_id: null,
      summary: 'No decision rationale recorded for this counterparty.',
      link: null
    };
  }

  const reasonCodes = Array.isArray(decision.decision_reason_codes) ? decision.decision_reason_codes : [];
  const suffix = reasonCodes.length > 0 ? ` [${reasonCodes.join(', ')}]` : '';

  return {
    reference_id: decision.decision_id,
    summary: `${decision.decision} decision${suffix}`,
    link: `liquidity-decisions://${decision.decision_id}`
  };
}

function buildDirectoryProviderView({ providerRef, personaRef }) {
  return {
    provider_id: providerRef.provider_id,
    provider_type: providerRef.provider_type,
    owner_actor_type: providerRef.owner_actor.type,
    is_automated: providerRef.is_automated,
    is_house_inventory: providerRef.is_house_inventory,
    label_required: providerRef.label_required,
    display_label: providerRef.display_label,
    disclosure_text: providerRef.disclosure_text,
    active: providerRef.active,
    categories: providerCategories(providerRef),
    persona_ref: personaRef ?? null,
    updated_at: providerRef.updated_at
  };
}

function normalizeDirectoryQuery(query) {
  const allowed = new Set(['provider_type', 'automated_only', 'house_inventory_only', 'include_inactive', 'limit']);

  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return { ok: false, details: { key, reason_code: 'liquidity_directory_query_invalid' } };
    }
  }

  const providerType = normalizeOptionalString(query?.provider_type);
  if (providerType && !PROVIDER_TYPES.has(providerType)) {
    return {
      ok: false,
      details: {
        key: 'provider_type',
        provider_type: providerType,
        reason_code: 'liquidity_directory_query_invalid'
      }
    };
  }

  const automatedOnly = parseBooleanLike(query?.automated_only, null);
  const houseInventoryOnly = parseBooleanLike(query?.house_inventory_only, null);
  const includeInactive = parseBooleanLike(query?.include_inactive, false);
  const limit = parseLimit(query?.limit, 50);

  if ((query?.automated_only !== undefined && automatedOnly === null)
    || (query?.house_inventory_only !== undefined && houseInventoryOnly === null)
    || (query?.include_inactive !== undefined && includeInactive === null)
    || limit === null) {
    return {
      ok: false,
      details: {
        reason_code: 'liquidity_directory_query_invalid'
      }
    };
  }

  return {
    ok: true,
    value: {
      provider_type: providerType,
      automated_only: automatedOnly,
      house_inventory_only: houseInventoryOnly,
      include_inactive: includeInactive,
      limit
    }
  };
}

function normalizeDisclosureEntry({
  source,
  sourceId,
  intentId,
  counterpartyActor,
  providerRef,
  personaRef,
  decision,
  preferenceEvaluation
}) {
  return {
    disclosure_id: deterministicId('cpd', `${source}|${sourceId}|${providerRef.provider_id}|${intentId ?? 'none'}`),
    source,
    source_id: sourceId,
    intent_id: intentId,
    counterparty_actor: counterpartyActor,
    provider_ref: clone(providerRef),
    automation_disclosure: {
      is_automated: providerRef.is_automated,
      is_house_inventory: providerRef.is_house_inventory,
      label_required: providerRef.label_required,
      disclosure_text: providerRef.disclosure_text
    },
    persona_ref: personaRef ? clone(personaRef) : null,
    strategy_summary_ref: personaRef
      ? {
          provider_id: personaRef.provider_id,
          persona_id: personaRef.persona_id,
          display_name: personaRef.display_name,
          strategy_summary: personaRef.strategy_summary
        }
      : null,
    decision_rationale: decisionRationale(decision),
    preference_evaluation: {
      allowed: preferenceEvaluation.allowed,
      blocked_reason_codes: clone(preferenceEvaluation.blocked_reason_codes)
    }
  };
}

export class LiquidityTransparencyService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _nowIso(auth) {
    return normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
  }

  _authorize({ actor, auth, operationId, corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        ok: false,
        response: {
          ok: false,
          body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    return { ok: true };
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, corr, handler }) {
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

  _preferencesForActor({ actor, auth }) {
    const nowIso = this._nowIso(auth);
    const key = actorScopeKey(actor);
    const stored = this.store.state.counterparty_preferences[key];

    if (!stored) {
      return defaultCounterpartyPreferences({ actor, nowIso });
    }

    return normalizeCounterpartyPreferences(stored);
  }

  listDirectory({ actor, auth, query }) {
    const op = 'liquidityDirectory.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, corr });
    if (!authz.ok) return authz.response;

    const parsed = normalizeDirectoryQuery(query);
    if (!parsed.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity directory query', parsed.details)
      };
    }

    const rows = Object.values(this.store.state.liquidity_providers ?? {})
      .filter(provider => parsed.value.include_inactive ? true : provider?.active !== false)
      .filter(provider => !parsed.value.provider_type || provider?.provider_type === parsed.value.provider_type)
      .filter(provider => parsed.value.automated_only === null ? true : provider?.is_automated === parsed.value.automated_only)
      .filter(provider => parsed.value.house_inventory_only === null ? true : provider?.is_house_inventory === parsed.value.house_inventory_only)
      .map(provider => {
        const nowIso = this._nowIso(auth);
        const providerRef = normalizeProviderForDisclosure(provider, {
          providerIdHint: provider?.provider_id,
          nowIso
        });

        const persona = this.store.state.liquidity_provider_personas?.[providerRef.provider_id]
          ?? providerRef.persona_ref
          ?? provider?.persona_ref
          ?? null;
        const personaRef = normalizePersonaForDisclosure(persona, {
          providerId: providerRef.provider_id,
          nowIso
        });

        return buildDirectoryProviderView({ providerRef, personaRef });
      })
      .sort((a, b) => String(a.provider_id).localeCompare(String(b.provider_id)));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        providers: rows.slice(0, parsed.value.limit),
        total_filtered: rows.length
      }
    };
  }

  getDirectoryProvider({ actor, auth, providerId }) {
    const op = 'liquidityDirectory.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, corr });
    if (!authz.ok) return authz.response;

    const normalizedProviderId = normalizeOptionalString(providerId);
    if (!normalizedProviderId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'provider_id is required', {
          reason_code: 'liquidity_directory_query_invalid'
        })
      };
    }

    const provider = this.store.state.liquidity_providers?.[normalizedProviderId] ?? null;
    if (!provider) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'liquidity directory provider not found', {
          provider_id: normalizedProviderId,
          reason_code: 'counterparty_disclosure_not_found'
        })
      };
    }

    const nowIso = this._nowIso(auth);
    const providerRef = normalizeProviderForDisclosure(provider, {
      providerIdHint: normalizedProviderId,
      nowIso
    });
    const persona = this.store.state.liquidity_provider_personas?.[normalizedProviderId]
      ?? providerRef.persona_ref
      ?? provider?.persona_ref
      ?? null;
    const personaRef = normalizePersonaForDisclosure(persona, {
      providerId: providerRef.provider_id,
      nowIso
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider: buildDirectoryProviderView({ providerRef, personaRef })
      }
    };
  }

  listDirectoryPersonas({ actor, auth, providerId }) {
    const op = 'liquidityDirectory.persona.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, corr });
    if (!authz.ok) return authz.response;

    const normalizedProviderId = normalizeOptionalString(providerId);
    if (!normalizedProviderId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'provider_id is required', {
          reason_code: 'liquidity_directory_query_invalid'
        })
      };
    }

    const provider = this.store.state.liquidity_providers?.[normalizedProviderId] ?? null;
    if (!provider) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'liquidity directory provider not found', {
          provider_id: normalizedProviderId,
          reason_code: 'counterparty_disclosure_not_found'
        })
      };
    }

    const nowIso = this._nowIso(auth);
    const personas = [];

    const primaryPersona = normalizePersonaForDisclosure(this.store.state.liquidity_provider_personas?.[normalizedProviderId], {
      providerId: normalizedProviderId,
      nowIso
    });
    if (primaryPersona) personas.push(primaryPersona);

    const providerPersona = normalizePersonaForDisclosure(provider?.persona_ref, {
      providerId: normalizedProviderId,
      nowIso
    });
    if (providerPersona && !personas.some(row => row.persona_id === providerPersona.persona_id)) {
      personas.push(providerPersona);
    }

    personas.sort((a, b) => String(a.persona_id).localeCompare(String(b.persona_id)));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: normalizedProviderId,
        personas
      }
    };
  }

  getCounterpartyPreferences({ actor, auth }) {
    const op = 'counterpartyPreferences.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, corr });
    if (!authz.ok) return authz.response;

    return {
      ok: true,
      body: {
        correlation_id: corr,
        preferences: this._preferencesForActor({ actor, auth })
      }
    };
  }

  upsertCounterpartyPreferences({ actor, auth, idempotencyKey, request }) {
    const op = 'counterpartyPreferences.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, corr });
    if (!authz.ok) return { replayed: false, result: authz.response };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      corr,
      handler: () => {
        const payload = request?.preferences;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid counterparty preferences payload', {
              reason_code: 'counterparty_preferences_invalid'
            })
          };
        }

        const allowBots = payload.allow_bots;
        const allowHouseLiquidity = payload.allow_house_liquidity;
        const allowPartnerLp = payload.allow_partner_lp;
        const categoryFilters = normalizeCategoryFilters(payload.category_filters);

        if (typeof allowBots !== 'boolean'
          || typeof allowHouseLiquidity !== 'boolean'
          || typeof allowPartnerLp !== 'boolean'
          || categoryFilters === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid counterparty preferences payload', {
              reason_code: 'counterparty_preferences_invalid'
            })
          };
        }

        const recordedAt = normalizeOptionalString(request?.recorded_at)
          ?? this._nowIso(auth);

        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid counterparty preferences timestamp', {
              reason_code: 'counterparty_preferences_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const conflictRule = categoryFilters.find(rule => rule.allow === true && (
          ((rule.category === 'automated' || rule.category === 'house_bot') && allowBots !== true)
          || ((rule.category === 'house_inventory' || rule.category === 'house_bot') && allowHouseLiquidity !== true)
          || (rule.category === 'partner_lp' && allowPartnerLp !== true)
        ));

        if (conflictRule) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'counterparty preferences contain conflicting overrides', {
              reason_code: 'counterparty_preferences_conflict',
              category: conflictRule.category,
              allow: conflictRule.allow,
              no_eligible_counterparty_behavior: NO_ELIGIBLE_BEHAVIOR
            })
          };
        }

        const row = {
          actor: {
            type: actor.type,
            id: actor.id
          },
          allow_bots: allowBots,
          allow_house_liquidity: allowHouseLiquidity,
          allow_partner_lp: allowPartnerLp,
          category_filters: categoryFilters,
          no_eligible_counterparty_behavior: NO_ELIGIBLE_BEHAVIOR,
          updated_at: recordedAt
        };

        this.store.state.counterparty_preferences[actorScopeKey(actor)] = row;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            preferences: normalizeCounterpartyPreferences(row)
          }
        };
      }
    });
  }

  getProposalCounterpartyDisclosure({ actor, auth, proposalId }) {
    const op = 'proposalCounterpartyDisclosure.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, corr });
    if (!authz.ok) return authz.response;

    const normalizedProposalId = normalizeOptionalString(proposalId);
    const proposal = normalizedProposalId ? (this.store.state.proposals?.[normalizedProposalId] ?? null) : null;

    if (!proposal) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'proposal counterparty disclosure not found', {
          proposal_id: normalizedProposalId,
          reason_code: 'counterparty_disclosure_not_found'
        })
      };
    }

    if (!actorCanReadProposal({ store: this.store, actor, proposalId: normalizedProposalId, proposal })) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'actor cannot access this proposal disclosure', {
          proposal_id: normalizedProposalId,
          actor
        })
      };
    }

    const nowIso = this._nowIso(auth);
    const preferences = this._preferencesForActor({ actor, auth });
    const disclosures = [];

    for (const participant of proposal.participants ?? []) {
      const providerHint = participant?.liquidity_provider_ref;
      if (!providerHint || typeof providerHint !== 'object') continue;

      const providerId = normalizeOptionalString(providerHint.provider_id) ?? `lp_${participant.intent_id ?? 'unknown'}`;
      const providerRecord = this.store.state.liquidity_providers?.[providerId] ?? null;
      const providerRef = normalizeProviderForDisclosure(providerRecord ?? providerHint, {
        providerIdHint: providerId,
        nowIso
      });

      const personaCandidate = participant?.persona_ref
        ?? providerRecord?.persona_ref
        ?? this.store.state.liquidity_provider_personas?.[providerRef.provider_id]
        ?? null;
      const personaRef = normalizePersonaForDisclosure(personaCandidate, {
        providerId: providerRef.provider_id,
        nowIso
      });

      const decision = findLatestDecisionForProvider({
        store: this.store,
        proposalId: normalizedProposalId,
        providerId: providerRef.provider_id
      });

      const preferenceEvaluation = evaluatePreferencesForProvider({
        preferences,
        providerRef
      });

      disclosures.push(normalizeDisclosureEntry({
        source: 'proposal',
        sourceId: normalizedProposalId,
        intentId: normalizeOptionalString(participant?.intent_id),
        counterpartyActor: clone(participant?.actor ?? { type: 'user', id: 'unknown' }),
        providerRef,
        personaRef,
        decision,
        preferenceEvaluation
      }));
    }

    disclosures.sort((a, b) => {
      const providerCmp = String(a?.provider_ref?.provider_id ?? '').localeCompare(String(b?.provider_ref?.provider_id ?? ''));
      if (providerCmp !== 0) return providerCmp;
      const intentCmp = String(a?.intent_id ?? '').localeCompare(String(b?.intent_id ?? ''));
      if (intentCmp !== 0) return intentCmp;
      return String(a.disclosure_id).localeCompare(String(b.disclosure_id));
    });
    const filteredCounterparties = disclosures.filter(item => item.preference_evaluation.allowed !== true).length;

    return {
      ok: true,
      body: {
        correlation_id: corr,
        proposal_id: normalizedProposalId,
        cycle_id: normalizedProposalId,
        disclosures,
        total_counterparties: disclosures.length,
        filtered_counterparties: filteredCounterparties,
        preference_snapshot: preferences
      }
    };
  }

  getReceiptCounterpartyDisclosure({ actor, auth, receiptId }) {
    const op = 'receiptCounterpartyDisclosure.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, corr });
    if (!authz.ok) return authz.response;

    const normalizedReceiptId = normalizeOptionalString(receiptId);
    const receipt = Object.values(this.store.state.receipts ?? {})
      .find(row => normalizeOptionalString(row?.id) === normalizedReceiptId) ?? null;

    if (!receipt) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'receipt counterparty disclosure not found', {
          receipt_id: normalizedReceiptId,
          reason_code: 'counterparty_disclosure_not_found'
        })
      };
    }

    if (!actorCanReadCycle({ store: this.store, actor, cycleId: receipt.cycle_id })) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'actor cannot access this receipt disclosure', {
          receipt_id: normalizedReceiptId,
          cycle_id: receipt.cycle_id,
          actor
        })
      };
    }

    const nowIso = this._nowIso(auth);
    const preferences = this._preferencesForActor({ actor, auth });
    const disclosures = [];

    if (Array.isArray(receipt?.liquidity_provider_summary) && receipt.liquidity_provider_summary.length > 0) {
      for (const row of receipt.liquidity_provider_summary) {
        const providerHint = row?.provider;
        if (!providerHint || typeof providerHint !== 'object') continue;

        const providerId = normalizeOptionalString(providerHint.provider_id) ?? 'lp_unknown';
        const providerRecord = this.store.state.liquidity_providers?.[providerId] ?? null;
        const providerRef = normalizeProviderForDisclosure(providerRecord ?? providerHint, {
          providerIdHint: providerId,
          nowIso
        });

        const intentId = normalizeOptionalString(row?.counterparty_intent_ids?.[0] ?? null);
        const intent = intentId ? (this.store.state.intents?.[intentId] ?? null) : null;

        const personaCandidate = providerHint?.persona_ref
          ?? providerRecord?.persona_ref
          ?? this.store.state.liquidity_provider_personas?.[providerRef.provider_id]
          ?? null;
        const personaRef = normalizePersonaForDisclosure(personaCandidate, {
          providerId: providerRef.provider_id,
          nowIso
        });

        const decision = findLatestDecisionForProvider({
          store: this.store,
          proposalId: receipt.cycle_id,
          providerId: providerRef.provider_id
        });

        const preferenceEvaluation = evaluatePreferencesForProvider({
          preferences,
          providerRef
        });

        disclosures.push(normalizeDisclosureEntry({
          source: 'receipt',
          sourceId: normalizedReceiptId,
          intentId,
          counterpartyActor: clone(intent?.actor ?? { type: 'user', id: 'unknown' }),
          providerRef,
          personaRef,
          decision,
          preferenceEvaluation
        }));
      }
    } else {
      const seen = new Set();
      for (const intentId of receipt?.intent_ids ?? []) {
        const intent = this.store.state.intents?.[intentId] ?? null;
        const providerHint = intent?.liquidity_provider_ref;
        if (!providerHint || typeof providerHint !== 'object') continue;

        const providerId = normalizeOptionalString(providerHint.provider_id) ?? `lp_${intentId}`;
        const dedupeKey = `${providerId}|${intentId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const providerRecord = this.store.state.liquidity_providers?.[providerId] ?? null;
        const providerRef = normalizeProviderForDisclosure(providerRecord ?? providerHint, {
          providerIdHint: providerId,
          nowIso
        });

        const personaCandidate = intent?.persona_ref
          ?? providerRecord?.persona_ref
          ?? this.store.state.liquidity_provider_personas?.[providerRef.provider_id]
          ?? null;
        const personaRef = normalizePersonaForDisclosure(personaCandidate, {
          providerId: providerRef.provider_id,
          nowIso
        });

        const decision = findLatestDecisionForProvider({
          store: this.store,
          proposalId: receipt.cycle_id,
          providerId: providerRef.provider_id
        });

        const preferenceEvaluation = evaluatePreferencesForProvider({
          preferences,
          providerRef
        });

        disclosures.push(normalizeDisclosureEntry({
          source: 'receipt',
          sourceId: normalizedReceiptId,
          intentId,
          counterpartyActor: clone(intent?.actor ?? { type: 'user', id: 'unknown' }),
          providerRef,
          personaRef,
          decision,
          preferenceEvaluation
        }));
      }
    }

    disclosures.sort((a, b) => {
      const providerCmp = String(a?.provider_ref?.provider_id ?? '').localeCompare(String(b?.provider_ref?.provider_id ?? ''));
      if (providerCmp !== 0) return providerCmp;
      const intentCmp = String(a?.intent_id ?? '').localeCompare(String(b?.intent_id ?? ''));
      if (intentCmp !== 0) return intentCmp;
      return String(a.disclosure_id).localeCompare(String(b.disclosure_id));
    });
    const filteredCounterparties = disclosures.filter(item => item.preference_evaluation.allowed !== true).length;

    return {
      ok: true,
      body: {
        correlation_id: corr,
        receipt_id: normalizedReceiptId,
        cycle_id: receipt.cycle_id,
        disclosures,
        total_counterparties: disclosures.length,
        filtered_counterparties: filteredCounterparties,
        preference_snapshot: preferences
      }
    };
  }
}
