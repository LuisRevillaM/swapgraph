import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';

const SEGMENT_TIERS = ['S0', 'S1', 'S2', 'S3'];
const PROVIDER_STATUSES = new Set(['pending_review', 'active', 'restricted', 'offboarded']);
const ROLLOUT_STATUSES = new Set(['active', 'paused', 'blocked']);
const CAPABILITY_FAMILIES = new Set(['core', 'advanced', 'high_risk']);
const AUDIT_EVENT_TYPES = new Set([
  'onboarded',
  'status_upserted',
  'eligibility_evaluated',
  'rollout_upserted'
]);
const DAY_MS = 24 * 60 * 60 * 1000;

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

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function parseNonNegativeInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parseLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
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

function actorRef(actor) {
  return {
    type: actor?.type ?? 'unknown',
    id: actor?.id ?? 'unknown'
  };
}

function segmentRank(segment) {
  return SEGMENT_TIERS.indexOf(segment);
}

function pushReasonCode(out, code) {
  if (!out.includes(code)) out.push(code);
}

function normalizeReasonCodes(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;

  const out = [];
  for (const code of raw) {
    const normalized = normalizeOptionalString(code);
    if (!normalized) return null;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function normalizeCapabilityMatrix(raw) {
  if (!Array.isArray(raw) || raw.length < 1) return null;

  const out = [];
  const seenKeys = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

    const capability = normalizeOptionalString(item.capability);
    const minSegmentTier = normalizeOptionalString(item.min_segment_tier);
    const enabled = item.enabled;

    if (!capability
      || !minSegmentTier
      || segmentRank(minSegmentTier) < 0
      || typeof enabled !== 'boolean') {
      return null;
    }

    const dedupeKey = `${capability}::${minSegmentTier}`;
    if (seenKeys.has(dedupeKey)) return null;
    seenKeys.add(dedupeKey);

    out.push({
      capability,
      min_segment_tier: minSegmentTier,
      enabled
    });
  }

  out.sort((a, b) => {
    const byCapability = a.capability.localeCompare(b.capability);
    if (byCapability !== 0) return byCapability;
    return segmentRank(a.min_segment_tier) - segmentRank(b.min_segment_tier);
  });

  return out;
}

function rolloutCapabilitiesHash(capabilityMatrix) {
  const digest = createHash('sha256')
    .update(canonicalStringify(capabilityMatrix), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function deterministicId(prefix, value) {
  const digest = createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function auditCursor(entry) {
  return `${entry.recorded_at}|${entry.audit_id}`;
}

function auditSort(a, b) {
  const aMs = parseIsoMs(a?.recorded_at) ?? 0;
  const bMs = parseIsoMs(b?.recorded_at) ?? 0;
  if (aMs !== bMs) return aMs - bMs;
  return String(a?.audit_id ?? '').localeCompare(String(b?.audit_id ?? ''));
}

function exportRetentionDays(query) {
  const fromQuery = parsePositiveInt(query?.retention_days);
  if (fromQuery !== null) return Math.min(fromQuery, 3650);

  const fromEnv = parsePositiveInt(process.env.PARTNER_LIQUIDITY_PROVIDER_ROLLOUT_EXPORT_RETENTION_DAYS);
  if (fromEnv !== null) return Math.min(fromEnv, 3650);

  return 180;
}

function checkpointRetentionDays(defaultDays) {
  const env = parsePositiveInt(process.env.PARTNER_LIQUIDITY_PROVIDER_ROLLOUT_EXPORT_CHECKPOINT_RETENTION_DAYS);
  if (env !== null) return Math.min(env, 3650);
  return defaultDays;
}

function checkpointRetentionWindowMs(defaultDays) {
  return checkpointRetentionDays(defaultDays) * DAY_MS;
}

function pruneExpiredCheckpoints({ checkpointState, nowMs, retentionDays }) {
  for (const [checkpointHash, checkpoint] of Object.entries(checkpointState)) {
    const exportedAtMs = parseIsoMs(checkpoint?.exported_at);
    if (exportedAtMs === null || nowMs > exportedAtMs + checkpointRetentionWindowMs(retentionDays)) {
      delete checkpointState[checkpointHash];
    }
  }
}

function continuityContext({ fromIso, toIso, eventType, limit, retentionDays }) {
  return {
    from_iso: fromIso,
    to_iso: toIso,
    event_type: eventType,
    limit,
    retention_days: retentionDays
  };
}

function continuityContextHash(ctx) {
  return createHash('sha256').update(canonicalStringify(ctx), 'utf8').digest('hex');
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.partner_liquidity_providers ||= {};
  store.state.partner_liquidity_provider_counter ||= 0;
  store.state.partner_liquidity_provider_rollout_policies ||= {};
  store.state.partner_liquidity_provider_governance_audit ||= [];
  store.state.partner_liquidity_provider_governance_audit_counter ||= 0;
  store.state.partner_liquidity_provider_rollout_export_checkpoints ||= {};
}

function nextProviderId(store) {
  store.state.partner_liquidity_provider_counter += 1;
  return `plp_${String(store.state.partner_liquidity_provider_counter).padStart(6, '0')}`;
}

function nextAuditId(store) {
  store.state.partner_liquidity_provider_governance_audit_counter += 1;
  return `plpaudit_${String(store.state.partner_liquidity_provider_governance_audit_counter).padStart(6, '0')}`;
}

function normalizeProviderView(provider, rolloutRecord = null) {
  const out = {
    provider_id: provider.provider_id,
    owner_actor: clone(provider.owner_actor),
    external_provider_id: provider.external_provider_id,
    legal_entity_name: provider.legal_entity_name,
    trust_contact_email: provider.trust_contact_email,
    disclosure_text: provider.disclosure_text,
    segment_tier: provider.segment_tier,
    status: provider.status,
    governance: clone(provider.governance),
    created_at: provider.created_at,
    updated_at: provider.updated_at
  };

  if (provider.rollout_policy_ref) out.rollout_policy_ref = clone(provider.rollout_policy_ref);
  if (provider.last_eligibility) out.last_eligibility = clone(provider.last_eligibility);
  if (rolloutRecord) out.rollout = normalizeRolloutView(rolloutRecord);
  return out;
}

function normalizeRolloutView(rolloutRecord) {
  return {
    provider_id: rolloutRecord.provider_id,
    rollout_version: rolloutRecord.rollout_version,
    rollout_status: rolloutRecord.rollout_status,
    effective_segment_tier: rolloutRecord.effective_segment_tier,
    capability_matrix: clone(rolloutRecord.capability_matrix ?? []),
    reason_codes: clone(rolloutRecord.reason_codes ?? []),
    eligibility_ref: clone(rolloutRecord.eligibility_ref ?? null),
    capabilities_hash: rolloutRecord.capabilities_hash,
    updated_at: rolloutRecord.updated_at,
    updated_by: clone(rolloutRecord.updated_by)
  };
}

function normalizeAuditEntry(entry) {
  return {
    audit_id: entry.audit_id,
    provider_id: entry.provider_id,
    event_type: entry.event_type,
    recorded_at: entry.recorded_at,
    actor: clone(entry.actor),
    reason_codes: clone(entry.reason_codes ?? []),
    details: clone(entry.details ?? {})
  };
}

function parseOnboardPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const providerId = normalizeOptionalString(raw.provider_id);
  const ownerType = normalizeOptionalString(raw.owner_actor?.type);
  const ownerId = normalizeOptionalString(raw.owner_actor?.id);
  const externalProviderId = normalizeOptionalString(raw.external_provider_id);
  const legalEntityName = normalizeOptionalString(raw.legal_entity_name);
  const trustContactEmail = normalizeOptionalString(raw.trust_contact_email);
  const disclosureText = normalizeOptionalString(raw.disclosure_text);
  const segmentTier = normalizeOptionalString(raw.segment_tier);
  const status = normalizeOptionalString(raw.status) ?? 'pending_review';

  if (!ownerType
    || !ownerId
    || !externalProviderId
    || !legalEntityName
    || !trustContactEmail
    || !disclosureText
    || !segmentTier
    || segmentRank(segmentTier) < 0
    || !PROVIDER_STATUSES.has(status)
    || !trustContactEmail.includes('@')) {
    return null;
  }

  return {
    provider_id: providerId,
    owner_actor: { type: ownerType, id: ownerId },
    external_provider_id: externalProviderId,
    legal_entity_name: legalEntityName,
    trust_contact_email: trustContactEmail,
    disclosure_text: disclosureText,
    segment_tier: segmentTier,
    status
  };
}

function parseStatusPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const status = normalizeOptionalString(raw.status);
  const segmentTier = normalizeOptionalString(raw.segment_tier);
  const unresolvedCriticalViolations = parseNonNegativeInt(raw.unresolved_critical_violations);
  const reasonCodes = normalizeReasonCodes(raw.reason_codes);
  const operatorNote = normalizeOptionalString(raw.operator_note);

  if (!status
    || !PROVIDER_STATUSES.has(status)
    || !segmentTier
    || segmentRank(segmentTier) < 0
    || typeof raw.trust_safety_baseline_passed !== 'boolean'
    || typeof raw.reliability_baseline_passed !== 'boolean'
    || typeof raw.audit_conformance_passed !== 'boolean'
    || unresolvedCriticalViolations === null
    || reasonCodes === null) {
    return null;
  }

  return {
    status,
    segment_tier: segmentTier,
    trust_safety_baseline_passed: raw.trust_safety_baseline_passed,
    reliability_baseline_passed: raw.reliability_baseline_passed,
    audit_conformance_passed: raw.audit_conformance_passed,
    unresolved_critical_violations: unresolvedCriticalViolations,
    reason_codes: reasonCodes,
    operator_note: operatorNote
  };
}

function parseEligibilityPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const requestedSegmentTier = normalizeOptionalString(raw.requested_segment_tier);
  const unresolvedCriticalViolations = parseNonNegativeInt(raw.unresolved_critical_violations);
  const consecutiveCompliantWindows = parseNonNegativeInt(raw.consecutive_compliant_windows);
  const capabilityFamily = normalizeOptionalString(raw.capability_family);
  const remediationClosed = raw.remediation_closed === undefined ? true : raw.remediation_closed;

  if (!requestedSegmentTier
    || segmentRank(requestedSegmentTier) < 0
    || typeof raw.trust_safety_baseline_passed !== 'boolean'
    || typeof raw.reliability_baseline_passed !== 'boolean'
    || typeof raw.audit_conformance_passed !== 'boolean'
    || unresolvedCriticalViolations === null
    || consecutiveCompliantWindows === null
    || !capabilityFamily
    || !CAPABILITY_FAMILIES.has(capabilityFamily)
    || typeof remediationClosed !== 'boolean') {
    return null;
  }

  return {
    requested_segment_tier: requestedSegmentTier,
    trust_safety_baseline_passed: raw.trust_safety_baseline_passed,
    reliability_baseline_passed: raw.reliability_baseline_passed,
    audit_conformance_passed: raw.audit_conformance_passed,
    unresolved_critical_violations: unresolvedCriticalViolations,
    consecutive_compliant_windows: consecutiveCompliantWindows,
    capability_family: capabilityFamily,
    remediation_closed: remediationClosed
  };
}

function parseRolloutPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const rolloutStatus = normalizeOptionalString(raw.rollout_status);
  const effectiveSegmentTier = normalizeOptionalString(raw.effective_segment_tier);
  const capabilityMatrix = normalizeCapabilityMatrix(raw.capability_matrix);
  const reasonCodes = normalizeReasonCodes(raw.reason_codes);

  if (!rolloutStatus
    || !ROLLOUT_STATUSES.has(rolloutStatus)
    || !effectiveSegmentTier
    || segmentRank(effectiveSegmentTier) < 0
    || capabilityMatrix === null
    || reasonCodes === null) {
    return null;
  }

  return {
    rollout_status: rolloutStatus,
    effective_segment_tier: effectiveSegmentTier,
    capability_matrix: capabilityMatrix,
    reason_codes: reasonCodes
  };
}

export class PartnerLiquidityProviderGovernanceService {
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

  _authorize({ operationId, actor, auth, correlationId: corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
      };
    }

    return { ok: true };
  }

  _requirePartner({ actor, operationId, correlationId: corr }) {
    if (actor?.type === 'partner' && normalizeOptionalString(actor?.id)) return null;
    return {
      ok: false,
      body: errorResponse(corr, 'FORBIDDEN', 'only partner actors are allowed for partner liquidity provider operations', {
        operation_id: operationId,
        reason_code: 'partner_liquidity_provider_invalid',
        actor: actor ?? null
      })
    };
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, scopeSuffix = null, handler }) {
    const operationScope = scopeSuffix ? `${operationId}:${scopeSuffix}` : operationId;
    const scopeKey = idempotencyScopeKey({ actor, operationId: operationScope, idempotencyKey });
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

  _resolveProviderForActor({ actor, providerId, correlationId: corr }) {
    const normalizedProviderId = normalizeOptionalString(providerId);
    if (!normalizedProviderId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'provider_id is required', {
          reason_code: 'partner_liquidity_provider_invalid'
        })
      };
    }

    const provider = this.store.state.partner_liquidity_providers?.[normalizedProviderId];
    if (!provider) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'partner liquidity provider not found', {
          reason_code: 'partner_liquidity_provider_not_found',
          provider_id: normalizedProviderId
        })
      };
    }

    if (provider.owner_actor?.type !== actor?.type || provider.owner_actor?.id !== actor?.id) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'partner liquidity provider ownership mismatch', {
          reason_code: 'partner_liquidity_provider_invalid',
          provider_id: normalizedProviderId,
          owner_actor: provider.owner_actor,
          actor
        })
      };
    }

    return { ok: true, provider_id: normalizedProviderId, provider };
  }

  _appendAudit({ providerId, eventType, actor, recordedAt, reasonCodes, details }) {
    const entry = {
      audit_id: nextAuditId(this.store),
      provider_id: providerId,
      event_type: eventType,
      recorded_at: recordedAt,
      actor: actorRef(actor),
      reason_codes: clone(reasonCodes ?? []),
      details: clone(details ?? {})
    };
    this.store.state.partner_liquidity_provider_governance_audit.push(entry);
    this.store.state.partner_liquidity_provider_governance_audit.sort(auditSort);
    return entry;
  }

  onboard({ actor, auth, idempotencyKey, request }) {
    const op = 'partnerLiquidityProvider.onboard';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const recordedAtMs = parseIsoMs(recordedAtRaw);
        if (recordedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider timestamp', {
              reason_code: 'partner_liquidity_provider_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const parsed = parseOnboardPayload(request?.provider);
        if (!parsed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider payload', {
              reason_code: 'partner_liquidity_provider_invalid'
            })
          };
        }

        if (parsed.owner_actor.type !== 'partner' || parsed.owner_actor.id !== actor.id) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'provider owner actor does not match caller', {
              reason_code: 'partner_liquidity_provider_invalid',
              owner_actor: parsed.owner_actor,
              actor
            })
          };
        }

        const providerId = parsed.provider_id ?? nextProviderId(this.store);
        if (this.store.state.partner_liquidity_providers[providerId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'partner liquidity provider already exists', {
              reason_code: 'partner_liquidity_provider_invalid',
              provider_id: providerId
            })
          };
        }

        const recordedAtIso = new Date(recordedAtMs).toISOString();
        const provider = {
          provider_id: providerId,
          owner_actor: parsed.owner_actor,
          external_provider_id: parsed.external_provider_id,
          legal_entity_name: parsed.legal_entity_name,
          trust_contact_email: parsed.trust_contact_email,
          disclosure_text: parsed.disclosure_text,
          segment_tier: parsed.segment_tier,
          status: parsed.status,
          governance: {
            trust_safety_baseline_passed: false,
            reliability_baseline_passed: false,
            audit_conformance_passed: false,
            unresolved_critical_violations: 0
          },
          rollout_policy_ref: null,
          last_eligibility: null,
          created_at: recordedAtIso,
          updated_at: recordedAtIso
        };

        this.store.state.partner_liquidity_providers[providerId] = provider;
        this.store.state.partner_liquidity_provider_rollout_export_checkpoints[providerId] ||= {};

        this._appendAudit({
          providerId,
          eventType: 'onboarded',
          actor,
          recordedAt: recordedAtIso,
          reasonCodes: [],
          details: {
            segment_tier: provider.segment_tier,
            status: provider.status
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider: normalizeProviderView(provider)
          }
        };
      }
    });
  }

  get({ actor, auth, providerId }) {
    const op = 'partnerLiquidityProvider.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return partnerGuard;

    const resolved = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolved.ok) return { ok: false, body: resolved.body };

    const rolloutRecord = this.store.state.partner_liquidity_provider_rollout_policies?.[resolved.provider_id] ?? null;
    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider: normalizeProviderView(resolved.provider, rolloutRecord)
      }
    };
  }

  upsertStatus({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'partnerLiquidityProvider.status.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolved = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolved.ok) return { replayed: false, result: { ok: false, body: resolved.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolved.provider_id, request },
      correlationId: corr,
      scopeSuffix: resolved.provider_id,
      handler: () => {
        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const recordedAtMs = parseIsoMs(recordedAtRaw);
        if (recordedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider status timestamp', {
              reason_code: 'partner_liquidity_provider_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const parsed = parseStatusPayload(request?.status);
        if (!parsed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider status payload', {
              reason_code: 'partner_liquidity_provider_invalid'
            })
          };
        }

        const requiresDowngrade = !parsed.trust_safety_baseline_passed
          || !parsed.reliability_baseline_passed
          || !parsed.audit_conformance_passed
          || parsed.unresolved_critical_violations > 0;

        if (parsed.status === 'active' && requiresDowngrade) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'active status is blocked until downgrade conditions are cleared', {
              reason_code: 'partner_liquidity_provider_downgrade_required',
              provider_id: resolved.provider_id
            })
          };
        }

        if ((parsed.status === 'restricted' || parsed.status === 'offboarded') && parsed.reason_codes.length < 1) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'restricted/offboarded status requires explicit reason_codes', {
              reason_code: 'partner_liquidity_provider_invalid'
            })
          };
        }

        const recordedAtIso = new Date(recordedAtMs).toISOString();
        resolved.provider.status = parsed.status;
        resolved.provider.segment_tier = parsed.segment_tier;
        resolved.provider.governance = {
          trust_safety_baseline_passed: parsed.trust_safety_baseline_passed,
          reliability_baseline_passed: parsed.reliability_baseline_passed,
          audit_conformance_passed: parsed.audit_conformance_passed,
          unresolved_critical_violations: parsed.unresolved_critical_violations
        };
        resolved.provider.updated_at = recordedAtIso;

        this._appendAudit({
          providerId: resolved.provider_id,
          eventType: 'status_upserted',
          actor,
          recordedAt: recordedAtIso,
          reasonCodes: parsed.reason_codes,
          details: {
            status: parsed.status,
            segment_tier: parsed.segment_tier,
            governance: clone(resolved.provider.governance),
            operator_note: parsed.operator_note
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolved.provider_id,
            status: {
              status: resolved.provider.status,
              segment_tier: resolved.provider.segment_tier,
              trust_safety_baseline_passed: resolved.provider.governance.trust_safety_baseline_passed,
              reliability_baseline_passed: resolved.provider.governance.reliability_baseline_passed,
              audit_conformance_passed: resolved.provider.governance.audit_conformance_passed,
              unresolved_critical_violations: resolved.provider.governance.unresolved_critical_violations,
              reason_codes: parsed.reason_codes,
              updated_at: recordedAtIso,
              updated_by: actorRef(actor)
            }
          }
        };
      }
    });
  }

  evaluateEligibility({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'partnerLiquidityProvider.eligibility.evaluate';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolved = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolved.ok) return { replayed: false, result: { ok: false, body: resolved.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolved.provider_id, request },
      correlationId: corr,
      scopeSuffix: resolved.provider_id,
      handler: () => {
        const evaluatedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const evaluatedAtMs = parseIsoMs(evaluatedAtRaw);
        if (evaluatedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider eligibility timestamp', {
              reason_code: 'partner_liquidity_provider_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const parsed = parseEligibilityPayload(request?.eligibility);
        if (!parsed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider eligibility payload', {
              reason_code: 'partner_liquidity_provider_invalid'
            })
          };
        }

        const reasonCodes = [];
        if (!parsed.trust_safety_baseline_passed
          || !parsed.reliability_baseline_passed
          || !parsed.audit_conformance_passed) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_eligibility_failed');
        }

        if (parsed.unresolved_critical_violations > 0) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_eligibility_failed');
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_downgrade_required');
        }

        const currentSegmentRank = segmentRank(resolved.provider.segment_tier);
        const requestedSegmentRank = segmentRank(parsed.requested_segment_tier);

        if (requestedSegmentRank > currentSegmentRank + 1) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_eligibility_failed');
        }

        if (requestedSegmentRank > currentSegmentRank && parsed.consecutive_compliant_windows < 2) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_eligibility_failed');
        }

        if (requestedSegmentRank > currentSegmentRank && !parsed.remediation_closed) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_eligibility_failed');
        }

        if (parsed.capability_family === 'high_risk' && requestedSegmentRank < segmentRank('S2')) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_eligibility_failed');
        }

        const verdict = reasonCodes.length > 0 ? 'deny' : 'allow';
        const recommendedStatus = reasonCodes.includes('partner_liquidity_provider_downgrade_required')
          ? 'restricted'
          : verdict === 'allow'
            ? 'active'
            : 'pending_review';

        const evaluatedAtIso = new Date(evaluatedAtMs).toISOString();
        const evaluationId = deterministicId(
          'plpelig',
          `${resolved.provider_id}|${evaluatedAtIso}|${payloadHash(parsed)}`
        );

        const eligibilityResult = {
          evaluation_id: evaluationId,
          verdict,
          reason_codes: reasonCodes,
          requested_segment_tier: parsed.requested_segment_tier,
          current_segment_tier: resolved.provider.segment_tier,
          recommended_status: recommendedStatus,
          evaluated_at: evaluatedAtIso,
          inputs: clone(parsed)
        };

        resolved.provider.last_eligibility = clone(eligibilityResult);
        resolved.provider.updated_at = evaluatedAtIso;

        this._appendAudit({
          providerId: resolved.provider_id,
          eventType: 'eligibility_evaluated',
          actor,
          recordedAt: evaluatedAtIso,
          reasonCodes,
          details: clone(eligibilityResult)
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolved.provider_id,
            eligibility: eligibilityResult
          }
        };
      }
    });
  }

  upsertRollout({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'partnerLiquidityProvider.rollout.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolved = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolved.ok) return { replayed: false, result: { ok: false, body: resolved.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolved.provider_id, request },
      correlationId: corr,
      scopeSuffix: resolved.provider_id,
      handler: () => {
        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const recordedAtMs = parseIsoMs(recordedAtRaw);
        if (recordedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider rollout timestamp', {
              reason_code: 'partner_liquidity_provider_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const parsed = parseRolloutPayload(request?.rollout);
        if (!parsed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider rollout payload', {
              reason_code: 'partner_liquidity_provider_invalid'
            })
          };
        }

        const reasonCodes = clone(parsed.reason_codes);
        const lastEligibility = resolved.provider.last_eligibility ?? null;

        if (parsed.rollout_status === 'active' && (!lastEligibility || lastEligibility.verdict !== 'allow')) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_rollout_blocked');
        }

        if (parsed.rollout_status === 'active'
          && resolved.provider.governance?.unresolved_critical_violations > 0) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_rollout_blocked');
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_downgrade_required');
        }

        if (resolved.provider.status === 'offboarded' && parsed.rollout_status === 'active') {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_rollout_blocked');
        }

        const effectiveSegmentRank = segmentRank(parsed.effective_segment_tier);
        const currentSegmentRank = segmentRank(resolved.provider.segment_tier);
        if (effectiveSegmentRank > currentSegmentRank + 1) {
          pushReasonCode(reasonCodes, 'partner_liquidity_provider_rollout_blocked');
        }

        const capabilityMatrix = parsed.capability_matrix.map(item => {
          const minRank = segmentRank(item.min_segment_tier);
          const allowedBySegment = effectiveSegmentRank >= minRank;
          const effectiveEnabled = item.enabled && allowedBySegment;
          if (item.enabled && !allowedBySegment) {
            pushReasonCode(reasonCodes, 'partner_liquidity_provider_rollout_blocked');
          }
          return {
            capability: item.capability,
            min_segment_tier: item.min_segment_tier,
            requested_enabled: item.enabled,
            effective_enabled: effectiveEnabled
          };
        });

        if (parsed.rollout_status === 'active' && reasonCodes.includes('partner_liquidity_provider_rollout_blocked')) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'rollout activation blocked by eligibility or segment constraints', {
              reason_code: 'partner_liquidity_provider_rollout_blocked',
              provider_id: resolved.provider_id
            })
          };
        }

        const previous = this.store.state.partner_liquidity_provider_rollout_policies?.[resolved.provider_id] ?? null;
        const rolloutVersion = (Number(previous?.rollout_version) || 0) + 1;
        const recordedAtIso = new Date(recordedAtMs).toISOString();

        const rolloutRecord = {
          provider_id: resolved.provider_id,
          rollout_version: rolloutVersion,
          rollout_status: parsed.rollout_status,
          effective_segment_tier: parsed.effective_segment_tier,
          capability_matrix: capabilityMatrix,
          reason_codes: reasonCodes,
          eligibility_ref: lastEligibility
            ? {
                evaluation_id: lastEligibility.evaluation_id,
                verdict: lastEligibility.verdict,
                evaluated_at: lastEligibility.evaluated_at
              }
            : null,
          capabilities_hash: rolloutCapabilitiesHash(capabilityMatrix),
          updated_at: recordedAtIso,
          updated_by: actorRef(actor)
        };

        this.store.state.partner_liquidity_provider_rollout_policies[resolved.provider_id] = rolloutRecord;
        resolved.provider.rollout_policy_ref = {
          rollout_version: rolloutRecord.rollout_version,
          rollout_status: rolloutRecord.rollout_status,
          effective_segment_tier: rolloutRecord.effective_segment_tier,
          capabilities_hash: rolloutRecord.capabilities_hash
        };

        if (rolloutRecord.rollout_status === 'active') resolved.provider.status = 'active';
        if (rolloutRecord.rollout_status === 'blocked') resolved.provider.status = 'restricted';
        resolved.provider.segment_tier = rolloutRecord.effective_segment_tier;
        resolved.provider.updated_at = recordedAtIso;

        this._appendAudit({
          providerId: resolved.provider_id,
          eventType: 'rollout_upserted',
          actor,
          recordedAt: recordedAtIso,
          reasonCodes,
          details: normalizeRolloutView(rolloutRecord)
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolved.provider_id,
            rollout: normalizeRolloutView(rolloutRecord)
          }
        };
      }
    });
  }

  exportRollout({ actor, auth, providerId, query }) {
    const op = 'partnerLiquidityProvider.rollout.export';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return partnerGuard;

    const resolved = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolved.ok) return { ok: false, body: resolved.body };

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
    const eventType = normalizeOptionalString(query?.event_type);
    const limit = parseLimit(query?.limit, 50);

    if ((fromIso && parseIsoMs(fromIso) === null)
      || (toIso && parseIsoMs(toIso) === null)
      || limit === null
      || (eventType && !AUDIT_EVENT_TYPES.has(eventType))
      || (cursorAfter && !attestationAfter)
      || (cursorAfter && !checkpointAfter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid partner liquidity provider rollout export query', {
          reason_code: 'partner_liquidity_provider_invalid'
        })
      };
    }

    const retentionDays = exportRetentionDays(query);
    const nowIso = normalizeOptionalString(query?.now_iso) ?? this._nowIso(auth);
    const nowMs = parseIsoMs(nowIso);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid rollout export now_iso', {
          reason_code: 'partner_liquidity_provider_invalid',
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const checkpointsByProvider = this.store.state.partner_liquidity_provider_rollout_export_checkpoints;
    checkpointsByProvider[resolved.provider_id] ||= {};
    const checkpointState = checkpointsByProvider[resolved.provider_id];
    pruneExpiredCheckpoints({ checkpointState, nowMs, retentionDays });

    const continuity = continuityContext({ fromIso, toIso, eventType, limit, retentionDays });
    const continuityHash = continuityContextHash(continuity);

    if (cursorAfter) {
      const checkpoint = checkpointState[checkpointAfter];
      if (!checkpoint) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'rollout export checkpoint was not found', {
            reason_code: 'partner_liquidity_provider_invalid'
          })
        };
      }

      if (checkpoint.cursor_after !== cursorAfter
        || checkpoint.attestation_after !== attestationAfter
        || checkpoint.continuity_hash !== continuityHash) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'rollout export continuation context mismatch', {
            reason_code: 'partner_liquidity_provider_invalid'
          })
        };
      }
    }

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const retentionCutoffMs = nowMs - (retentionDays * DAY_MS);

    const baseEntries = (this.store.state.partner_liquidity_provider_governance_audit ?? [])
      .filter(entry => entry?.provider_id === resolved.provider_id)
      .filter(entry => (eventType ? entry.event_type === eventType : true))
      .filter(entry => {
        const entryMs = parseIsoMs(entry?.recorded_at);
        if (entryMs === null) return false;
        if (entryMs < retentionCutoffMs) return false;
        if (fromMs !== null && entryMs < fromMs) return false;
        if (toMs !== null && entryMs >= toMs) return false;
        return true;
      })
      .sort(auditSort);

    let slicedEntries = baseEntries;
    if (cursorAfter) {
      const cursorIdx = baseEntries.findIndex(entry => auditCursor(entry) === cursorAfter);
      if (cursorIdx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'rollout export cursor was not found', {
            reason_code: 'partner_liquidity_provider_invalid'
          })
        };
      }
      slicedEntries = baseEntries.slice(cursorIdx + 1);
    }

    const totalFiltered = slicedEntries.length;
    const pageEntries = slicedEntries.slice(0, limit);
    const hasMore = slicedEntries.length > pageEntries.length;
    const nextCursor = hasMore && pageEntries.length > 0 ? auditCursor(pageEntries.at(-1)) : null;

    const queryPayload = {
      ...continuity,
      ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
      ...(attestationAfter ? { attestation_after: attestationAfter } : {}),
      ...(checkpointAfter ? { checkpoint_after: checkpointAfter } : {})
    };
    const exportedAt = normalizeOptionalString(query?.exported_at_iso) ?? nowIso;

    const exportPayload = buildSignedPolicyAuditExportPayload({
      exportedAt,
      query: queryPayload,
      entries: pageEntries.map(normalizeAuditEntry),
      totalFiltered,
      nextCursor,
      withAttestation: true,
      withCheckpoint: true
    });

    if (exportPayload?.checkpoint?.checkpoint_hash) {
      checkpointState[exportPayload.checkpoint.checkpoint_hash] = {
        checkpoint_hash: exportPayload.checkpoint.checkpoint_hash,
        provider_id: resolved.provider_id,
        continuity_hash: continuityHash,
        cursor_after: exportPayload.checkpoint.next_cursor ?? null,
        attestation_after: exportPayload.checkpoint.attestation_chain_hash ?? null,
        exported_at: exportedAt
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolved.provider_id,
        export: exportPayload
      }
    };
  }
}
