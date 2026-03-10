import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { effectiveActorForDelegation } from '../core/tradingPolicyBoundaries.mjs';

const BLUEPRINT_STATUS = new Set(['draft', 'published', 'archived', 'suspended']);
const BLUEPRINT_CATEGORY = new Set(['skill', 'workflow', 'prompt_pack', 'agent_template', 'sdk_module', 'integration_recipe', 'evaluation_harness']);
const BLUEPRINT_DELIVERY_MODE = new Set(['download', 'repo_access', 'bundle_export', 'template_clone', 'hosted_copy']);
const BLUEPRINT_PRICING_MODEL = new Set(['one_time', 'seat', 'usage', 'support_bundle', 'barter_only']);

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseLimit(value, fallback = 25) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 100);
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

function actorEquals(a, b) {
  return (a?.type ?? null) === (b?.type ?? null) && (a?.id ?? null) === (b?.id ?? null);
}

function actorProfileKey(actor) {
  if (!actor?.type || !actor?.id) return null;
  return `${actor.type}:${actor.id}`;
}

function resolveSubjectActor({ actor, auth }) {
  return effectiveActorForDelegation({ actor, auth }) ?? actor;
}

function normalizeRecordedAt(request, auth) {
  return normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
}

function parseRateLimitEnv(name, fallback) {
  const raw = Number.parseInt(String(process.env[name] ?? fallback), 10);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return raw;
}

function startOfHourIso(iso) {
  const ms = parseIsoMs(iso);
  if (ms === null) return null;
  const date = new Date(ms);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function ensureQuotaRecord(store, key, defaults = {}) {
  store.state.market_actor_quotas[key] ||= { ...clone(defaults) };
  const record = store.state.market_actor_quotas[key];
  record.rate_windows ||= {};
  return record;
}

function applyRateLimit({ quotaRecord, actionKey, limit, recordedAt }) {
  const windowStartedAt = startOfHourIso(recordedAt);
  if (!windowStartedAt) return { ok: false, count: 0, limit };
  const existing = quotaRecord.rate_windows[actionKey];
  if (!existing || existing.window_started_at !== windowStartedAt) {
    quotaRecord.rate_windows[actionKey] = {
      window_started_at: windowStartedAt,
      count: 0
    };
  }
  const bucket = quotaRecord.rate_windows[actionKey];
  if (bucket.count >= limit) {
    return {
      ok: false,
      count: bucket.count,
      limit,
      window_started_at: bucket.window_started_at
    };
  }
  bucket.count += 1;
  return {
    ok: true,
    count: bucket.count,
    limit,
    window_started_at: bucket.window_started_at
  };
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.market_blueprints ||= {};
  store.state.market_blueprint_counter ||= 0;
  store.state.market_actor_profiles ||= {};
  store.state.market_actor_quotas ||= {};
}

function nextBlueprintId(store) {
  store.state.market_blueprint_counter = Number(store.state.market_blueprint_counter ?? 0) + 1;
  return `blueprint_${String(store.state.market_blueprint_counter).padStart(6, '0')}`;
}

function actorProfileSummary(store, actor) {
  const record = store.state.market_actor_profiles?.[actorProfileKey(actor)] ?? null;
  if (!record) return null;
  return {
    actor: clone(record.actor),
    display_name: record.display_name,
    handle: record.handle,
    owner_mode: record.owner_mode,
    default_workspace_id: record.default_workspace_id,
    bio: record.bio ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function normalizeBlueprintView(record, store) {
  return {
    blueprint_id: record.blueprint_id,
    workspace_id: record.workspace_id,
    owner_actor: clone(record.owner_actor),
    owner_profile: actorProfileSummary(store, record.owner_actor),
    status: record.status,
    title: record.title,
    summary: record.summary,
    category: record.category,
    artifact_ref: record.artifact_ref,
    artifact_format: record.artifact_format,
    license_terms: record.license_terms,
    support_policy: record.support_policy ? clone(record.support_policy) : null,
    verification_spec: record.verification_spec ? clone(record.verification_spec) : null,
    delivery_mode: record.delivery_mode,
    pricing_model: record.pricing_model,
    valuation_hint: record.valuation_hint ? clone(record.valuation_hint) : null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function publicVisibleBlueprint(record) {
  return !!record && record.status === 'published';
}

function sortByUpdatedDescThenId(rows, idField) {
  rows.sort((a, b) => {
    const at = parseIsoMs(a.updated_at) ?? 0;
    const bt = parseIsoMs(b.updated_at) ?? 0;
    if (bt !== at) return bt - at;
    return String(a[idField] ?? '').localeCompare(String(b[idField] ?? ''));
  });
}

function encodeCursor(parts) {
  return parts.join('|');
}

function decodeCursor(raw, expectedParts) {
  const value = normalizeOptionalString(raw);
  if (!value) return null;
  const parts = value.split('|');
  if (parts.length !== expectedParts) return undefined;
  if (parts.some(part => !part)) return undefined;
  return parts;
}

function buildPaginationSlice({ rows, limit, cursorAfter, keyFn, cursorParts }) {
  let start = 0;
  if (cursorAfter) {
    const decoded = decodeCursor(cursorAfter, cursorParts);
    if (decoded === undefined) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid cursor format',
        details: { reason_code: 'market_feed_query_invalid', cursor_after: cursorAfter }
      };
    }
    if (decoded) {
      const idx = rows.findIndex(row => {
        const key = keyFn(row);
        return key.length === decoded.length && key.every((v, i) => String(v) === String(decoded[i]));
      });
      if (idx < 0) {
        return {
          ok: false,
          code: 'CONSTRAINT_VIOLATION',
          message: 'cursor not found',
          details: { reason_code: 'market_cursor_not_found', cursor_after: cursorAfter }
        };
      }
      start = idx + 1;
    }
  }

  const page = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(keyFn(page[page.length - 1])) : null;
  return {
    ok: true,
    value: {
      page,
      total: rows.length,
      nextCursor
    }
  };
}

function normalizeListQuery(query) {
  const allowed = new Set(['workspace_id', 'owner_actor_type', 'owner_actor_id', 'status', 'category', 'delivery_mode', 'limit', 'cursor_after']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid query parameter',
        details: { reason_code: 'market_feed_query_invalid', key }
      };
    }
  }

  const workspaceId = normalizeOptionalString(query?.workspace_id);
  const ownerActorType = normalizeOptionalString(query?.owner_actor_type);
  const ownerActorId = normalizeOptionalString(query?.owner_actor_id);
  const status = normalizeOptionalString(query?.status)?.toLowerCase() ?? null;
  const category = normalizeOptionalString(query?.category)?.toLowerCase() ?? null;
  const deliveryMode = normalizeOptionalString(query?.delivery_mode)?.toLowerCase() ?? null;
  const limit = parseLimit(query?.limit, 25);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  if (status && !BLUEPRINT_STATUS.has(status)) {
    return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid blueprint status filter', details: { reason_code: 'market_blueprint_invalid', status } };
  }
  if (category && !BLUEPRINT_CATEGORY.has(category)) {
    return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid blueprint category filter', details: { reason_code: 'market_blueprint_invalid', category } };
  }
  if (deliveryMode && !BLUEPRINT_DELIVERY_MODE.has(deliveryMode)) {
    return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid blueprint delivery_mode filter', details: { reason_code: 'market_blueprint_invalid', delivery_mode: deliveryMode } };
  }
  if (limit === null) {
    return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid limit', details: { reason_code: 'market_feed_query_invalid', limit: query?.limit } };
  }

  return {
    ok: true,
    value: {
      workspace_id: workspaceId,
      owner_actor_type: ownerActorType,
      owner_actor_id: ownerActorId,
      status,
      category,
      delivery_mode: deliveryMode,
      limit,
      cursor_after: cursorAfter
    }
  };
}

export class MarketBlueprintService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
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

  _subjectActor({ actor, auth }) {
    return resolveSubjectActor({ actor, auth });
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

  _loadBlueprintOrError({ blueprintId, correlationId: corr }) {
    const record = this.store.state.market_blueprints?.[blueprintId] ?? null;
    if (!record) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'blueprint not found', {
          reason_code: 'market_blueprint_not_found',
          blueprint_id: blueprintId
        })
      };
    }
    return { ok: true, record };
  }

  _normalizeCreate({ request, actor, auth, correlationId: corr }) {
    const blueprint = request?.blueprint;
    if (!isPlainObject(blueprint)) {
      return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint payload', { reason_code: 'market_blueprint_invalid' }) };
    }
    const recordedAt = normalizeRecordedAt(request, auth);
    if (parseIsoMs(recordedAt) === null) {
      return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint timestamp', { reason_code: 'market_blueprint_invalid', recorded_at: request?.recorded_at ?? null }) };
    }
    const subjectActor = this._subjectActor({ actor, auth });
    const ownerActor = isPlainObject(blueprint.owner_actor) ? {
      type: normalizeOptionalString(blueprint.owner_actor.type),
      id: normalizeOptionalString(blueprint.owner_actor.id)
    } : subjectActor;
    if (!ownerActor?.type || !ownerActor?.id || !actorEquals(ownerActor, subjectActor)) {
      return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'blueprint owner actor required', { reason_code: 'market_blueprint_forbidden', actor: subjectActor, owner_actor: ownerActor ?? null }) };
    }
    const workspaceId = normalizeOptionalString(blueprint.workspace_id);
    const title = normalizeOptionalString(blueprint.title);
    const category = normalizeOptionalString(blueprint.category)?.toLowerCase() ?? null;
    const deliveryMode = normalizeOptionalString(blueprint.delivery_mode)?.toLowerCase() ?? null;
    const pricingModel = normalizeOptionalString(blueprint.pricing_model)?.toLowerCase() ?? 'one_time';
    const artifactRef = normalizeOptionalString(blueprint.artifact_ref);
    const artifactFormat = normalizeOptionalString(blueprint.artifact_format);
    const status = normalizeOptionalString(blueprint.status)?.toLowerCase() ?? 'draft';
    if (!workspaceId || !title || !category || !BLUEPRINT_CATEGORY.has(category) || !deliveryMode || !BLUEPRINT_DELIVERY_MODE.has(deliveryMode)
      || !BLUEPRINT_PRICING_MODEL.has(pricingModel) || !artifactRef || !artifactFormat || !BLUEPRINT_STATUS.has(status) || status === 'suspended') {
      return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint payload', { reason_code: 'market_blueprint_invalid' }) };
    }
    if (blueprint.verification_spec !== undefined && blueprint.verification_spec !== null && !isPlainObject(blueprint.verification_spec)) {
      return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint verification spec', { reason_code: 'market_blueprint_invalid' }) };
    }
    if (blueprint.support_policy !== undefined && blueprint.support_policy !== null && !isPlainObject(blueprint.support_policy)) {
      return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint support policy', { reason_code: 'market_blueprint_invalid' }) };
    }
    if (blueprint.valuation_hint !== undefined && blueprint.valuation_hint !== null && !isPlainObject(blueprint.valuation_hint)) {
      return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint valuation hint', { reason_code: 'market_blueprint_invalid' }) };
    }

    return {
      ok: true,
      value: {
        blueprint_id: normalizeOptionalString(blueprint.blueprint_id),
        workspace_id: workspaceId,
        owner_actor: ownerActor,
        status,
        title,
        summary: normalizeOptionalString(blueprint.summary),
        category,
        artifact_ref: artifactRef,
        artifact_format: artifactFormat,
        license_terms: normalizeOptionalString(blueprint.license_terms),
        support_policy: isPlainObject(blueprint.support_policy) ? clone(blueprint.support_policy) : null,
        verification_spec: isPlainObject(blueprint.verification_spec) ? clone(blueprint.verification_spec) : null,
        delivery_mode: deliveryMode,
        pricing_model: pricingModel,
        valuation_hint: isPlainObject(blueprint.valuation_hint) ? clone(blueprint.valuation_hint) : null,
        recorded_at: recordedAt
      }
    };
  }

  create({ actor, auth, idempotencyKey, request }) {
    const op = 'marketBlueprints.create';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const normalized = this._normalizeCreate({ request, actor, auth, correlationId: corr });
        if (!normalized.ok) return { ok: false, body: normalized.body };

        const ownerQuotaKey = actorProfileKey(normalized.value.owner_actor);
        const ownerQuota = ensureQuotaRecord(this.store, ownerQuotaKey, {
          actor: clone(normalized.value.owner_actor),
          trust_tier: 'open_signup',
          credit_balance: 1000,
          listings_created: 0,
          edges_created: 0,
          deals_created: 0,
          created_at: normalized.value.recorded_at,
          updated_at: normalized.value.recorded_at
        });
        if ((ownerQuota.trust_tier ?? 'open_signup') === 'blocked') {
          return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'actor trust tier blocks blueprint creation', { reason_code: 'market_actor_blocked', actor: normalized.value.owner_actor }) };
        }
        const rateLimit = applyRateLimit({ quotaRecord: ownerQuota, actionKey: 'blueprint_create', limit: parseRateLimitEnv('MARKET_BLUEPRINT_RATE_LIMIT_PER_HOUR', 40), recordedAt: normalized.value.recorded_at });
        ownerQuota.updated_at = normalized.value.recorded_at;
        if (!rateLimit.ok) {
          return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'blueprint rate limit exceeded', { reason_code: 'market_blueprint_rate_limited', limit: rateLimit.limit, window_started_at: rateLimit.window_started_at }) };
        }

        const blueprintId = normalized.value.blueprint_id ?? nextBlueprintId(this.store);
        if (this.store.state.market_blueprints[blueprintId]) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'blueprint already exists', { reason_code: 'market_blueprint_invalid', blueprint_id: blueprintId }) };
        }

        const record = {
          ...normalized.value,
          blueprint_id: blueprintId,
          created_at: normalized.value.recorded_at,
          updated_at: normalized.value.recorded_at
        };
        this.store.state.market_blueprints[blueprintId] = record;
        return { ok: true, body: { correlation_id: corr, blueprint: normalizeBlueprintView(record, this.store) } };
      }
    });
  }

  patch({ actor, auth, blueprintId, idempotencyKey, request }) {
    const op = 'marketBlueprints.patch';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const load = this._loadBlueprintOrError({ blueprintId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };
        const record = load.record;
        const subjectActor = this._subjectActor({ actor, auth });
        if (!actorEquals(record.owner_actor, subjectActor)) {
          return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'blueprint owner actor required', { reason_code: 'market_blueprint_forbidden', blueprint_id: blueprintId, actor: subjectActor, owner_actor: record.owner_actor }) };
        }
        if (record.status === 'archived' || record.status === 'suspended') {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'blueprint status does not allow patch', { reason_code: 'market_blueprint_invalid', blueprint_id: blueprintId, status: record.status }) };
        }
        const patch = request?.patch;
        if (!isPlainObject(patch)) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint patch payload', { reason_code: 'market_blueprint_invalid' }) };
        }
        const allowed = new Set(['title', 'summary', 'category', 'artifact_ref', 'artifact_format', 'license_terms', 'support_policy', 'verification_spec', 'delivery_mode', 'pricing_model', 'valuation_hint']);
        for (const key of Object.keys(patch)) {
          if (!allowed.has(key)) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint patch field', { reason_code: 'market_blueprint_invalid', key }) };
        }
        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint timestamp', { reason_code: 'market_blueprint_invalid', recorded_at: request?.recorded_at ?? null }) };
        }
        if (patch.title !== undefined) {
          const title = normalizeOptionalString(patch.title);
          if (!title) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint title', { reason_code: 'market_blueprint_invalid' }) };
          record.title = title;
        }
        if (patch.summary !== undefined) record.summary = normalizeOptionalString(patch.summary);
        if (patch.category !== undefined) {
          const category = normalizeOptionalString(patch.category)?.toLowerCase() ?? null;
          if (!category || !BLUEPRINT_CATEGORY.has(category)) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint category', { reason_code: 'market_blueprint_invalid' }) };
          record.category = category;
        }
        if (patch.artifact_ref !== undefined) {
          const artifactRef = normalizeOptionalString(patch.artifact_ref);
          if (!artifactRef) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint artifact_ref', { reason_code: 'market_blueprint_invalid' }) };
          record.artifact_ref = artifactRef;
        }
        if (patch.artifact_format !== undefined) {
          const artifactFormat = normalizeOptionalString(patch.artifact_format);
          if (!artifactFormat) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint artifact_format', { reason_code: 'market_blueprint_invalid' }) };
          record.artifact_format = artifactFormat;
        }
        if (patch.license_terms !== undefined) record.license_terms = normalizeOptionalString(patch.license_terms);
        if (patch.support_policy !== undefined) {
          if (patch.support_policy !== null && !isPlainObject(patch.support_policy)) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint support policy', { reason_code: 'market_blueprint_invalid' }) };
          record.support_policy = patch.support_policy ? clone(patch.support_policy) : null;
        }
        if (patch.verification_spec !== undefined) {
          if (patch.verification_spec !== null && !isPlainObject(patch.verification_spec)) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint verification spec', { reason_code: 'market_blueprint_invalid' }) };
          record.verification_spec = patch.verification_spec ? clone(patch.verification_spec) : null;
        }
        if (patch.delivery_mode !== undefined) {
          const deliveryMode = normalizeOptionalString(patch.delivery_mode)?.toLowerCase() ?? null;
          if (!deliveryMode || !BLUEPRINT_DELIVERY_MODE.has(deliveryMode)) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint delivery mode', { reason_code: 'market_blueprint_invalid' }) };
          record.delivery_mode = deliveryMode;
        }
        if (patch.pricing_model !== undefined) {
          const pricingModel = normalizeOptionalString(patch.pricing_model)?.toLowerCase() ?? null;
          if (!pricingModel || !BLUEPRINT_PRICING_MODEL.has(pricingModel)) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint pricing model', { reason_code: 'market_blueprint_invalid' }) };
          record.pricing_model = pricingModel;
        }
        if (patch.valuation_hint !== undefined) {
          if (patch.valuation_hint !== null && !isPlainObject(patch.valuation_hint)) return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint valuation hint', { reason_code: 'market_blueprint_invalid' }) };
          record.valuation_hint = patch.valuation_hint ? clone(patch.valuation_hint) : null;
        }
        record.updated_at = recordedAt;
        return { ok: true, body: { correlation_id: corr, blueprint: normalizeBlueprintView(record, this.store) } };
      }
    });
  }

  _transitionStatus({ actor, auth, blueprintId, idempotencyKey, request, operationId, targetStatus }) {
    const corr = correlationId(operationId);
    const authz = this._authorize({ actor, auth, operationId, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const load = this._loadBlueprintOrError({ blueprintId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };
        const record = load.record;
        const subjectActor = this._subjectActor({ actor, auth });
        if (!actorEquals(record.owner_actor, subjectActor)) {
          return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'blueprint owner actor required', { reason_code: 'market_blueprint_forbidden', blueprint_id: blueprintId, actor: subjectActor, owner_actor: record.owner_actor }) };
        }
        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid blueprint timestamp', { reason_code: 'market_blueprint_invalid', recorded_at: request?.recorded_at ?? null }) };
        }
        if (record.status === targetStatus) {
          return { ok: true, body: { correlation_id: corr, blueprint: normalizeBlueprintView(record, this.store) } };
        }
        if (record.status === 'suspended') {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'blueprint status does not allow transition', { reason_code: 'market_blueprint_invalid', blueprint_id: blueprintId, status: record.status }) };
        }
        record.status = targetStatus;
        record.updated_at = recordedAt;
        return { ok: true, body: { correlation_id: corr, blueprint: normalizeBlueprintView(record, this.store) } };
      }
    });
  }

  publish({ actor, auth, blueprintId, idempotencyKey, request }) {
    return this._transitionStatus({ actor, auth, blueprintId, idempotencyKey, request, operationId: 'marketBlueprints.publish', targetStatus: 'published' });
  }

  archive({ actor, auth, blueprintId, idempotencyKey, request }) {
    return this._transitionStatus({ actor, auth, blueprintId, idempotencyKey, request, operationId: 'marketBlueprints.archive', targetStatus: 'archived' });
  }

  get({ actor, auth, blueprintId }) {
    const op = 'marketBlueprints.get';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };
    const load = this._loadBlueprintOrError({ blueprintId, correlationId: corr });
    if (!load.ok) return load;
    const record = load.record;
    const subjectActor = this._subjectActor({ actor, auth });
    const isPublic = publicVisibleBlueprint(record);
    const isOwner = subjectActor && actorEquals(record.owner_actor, subjectActor);
    if (!isPublic && !isOwner) {
      return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'blueprint not found', { reason_code: 'market_blueprint_not_found', blueprint_id: blueprintId }) };
    }
    return { ok: true, body: { correlation_id: corr, blueprint: normalizeBlueprintView(record, this.store) } };
  }

  list({ actor, auth, query }) {
    const op = 'marketBlueprints.list';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };
    const normalized = normalizeListQuery(query ?? {});
    if (!normalized.ok) return { ok: false, body: errorResponse(corr, normalized.code, normalized.message, normalized.details) };
    const subjectActor = this._subjectActor({ actor, auth });
    const rows = Object.values(this.store.state.market_blueprints ?? {}).filter(record => {
      if (!record) return false;
      if (normalized.value.workspace_id && record.workspace_id !== normalized.value.workspace_id) return false;
      if (normalized.value.owner_actor_type && record.owner_actor?.type !== normalized.value.owner_actor_type) return false;
      if (normalized.value.owner_actor_id && record.owner_actor?.id !== normalized.value.owner_actor_id) return false;
      if (normalized.value.status && record.status !== normalized.value.status) return false;
      if (normalized.value.category && record.category !== normalized.value.category) return false;
      if (normalized.value.delivery_mode && record.delivery_mode !== normalized.value.delivery_mode) return false;
      const isPublic = publicVisibleBlueprint(record);
      const isOwner = subjectActor && actorEquals(record.owner_actor, subjectActor);
      if (!isPublic && !isOwner) return false;
      return true;
    }).map(record => normalizeBlueprintView(record, this.store));

    sortByUpdatedDescThenId(rows, 'blueprint_id');
    const page = buildPaginationSlice({ rows, limit: normalized.value.limit, cursorAfter: normalized.value.cursor_after, keyFn: row => [row.updated_at, row.blueprint_id], cursorParts: 2 });
    if (!page.ok) return { ok: false, body: errorResponse(corr, page.code, page.message, page.details) };
    return { ok: true, body: { correlation_id: corr, blueprints: page.value.page, total: page.value.total, next_cursor: page.value.nextCursor } };
  }
}
