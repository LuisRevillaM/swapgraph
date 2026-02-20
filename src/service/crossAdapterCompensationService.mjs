import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { verifyReceiptSignature } from '../crypto/receiptSigning.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return {
    correlation_id: correlationId,
    error: {
      code,
      message,
      details
    }
  };
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePositiveInt(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function ensureCrossAdapterCompensationState(store) {
  store.state.cross_adapter_compensation_cases ||= {};
  store.state.cross_adapter_compensation_case_counter ||= 0;
  store.state.cross_adapter_cycle_receipts ||= {};
  store.state.idempotency ||= {};

  return {
    cases: store.state.cross_adapter_compensation_cases,
    crossReceipts: store.state.cross_adapter_cycle_receipts,
    idempotency: store.state.idempotency
  };
}

function nextCaseCounter(store) {
  const current = Number.parseInt(String(store.state.cross_adapter_compensation_case_counter ?? 0), 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  store.state.cross_adapter_compensation_case_counter = next;
  return next;
}

function applyIdempotentMutation({ store, actor, operationId, idempotencyKey, requestPayload, mutate, correlationId: corr }) {
  const key = normalizeOptionalString(idempotencyKey);
  if (!key) {
    return {
      ok: false,
      body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'idempotency key is required', {
        operation_id: operationId
      })
    };
  }

  const idemState = ensureCrossAdapterCompensationState(store).idempotency;
  const scopeKey = `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}|${operationId}|${key}`;
  const incomingHash = payloadHash(requestPayload);
  const prior = idemState[scopeKey] ?? null;

  if (prior) {
    if (prior.payload_hash !== incomingHash) {
      return {
        ok: false,
        body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reuse with different payload', {
          operation_id: operationId,
          idempotency_key: key
        })
      };
    }

    return {
      ok: true,
      body: {
        ...prior.result,
        replayed: true
      }
    };
  }

  const mutated = mutate();
  if (!mutated.ok) return mutated;

  idemState[scopeKey] = {
    payload_hash: incomingHash,
    result: mutated.body
  };

  return {
    ok: true,
    body: {
      ...mutated.body,
      replayed: false
    }
  };
}

const allowedDiscrepancyCodes = new Set(['target_leg_unsettled', 'source_leg_unsettled', 'both_legs_unsettled']);
const allowedCaseStatus = new Set(['open', 'approved', 'rejected', 'resolved']);

function normalizeRequestedBy(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
  const id = normalizeOptionalString(actor.id);
  if (!id || !['user', 'partner'].includes(actor.type)) return null;
  return {
    type: actor.type,
    id
  };
}

function normalizeCaseCreateRequest(request) {
  const payload = request?.case;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const cycleId = normalizeOptionalString(payload.cycle_id);
  const crossReceiptId = normalizeOptionalString(payload.cross_receipt_id);
  const discrepancyCode = normalizeOptionalString(payload.discrepancy_code);
  const requestedBy = normalizeRequestedBy(payload.requested_by);
  const requestedAmountUsdMicros = parsePositiveInt(payload.requested_amount_usd_micros, { min: 1, max: 1000000000000 });

  if (!cycleId
    || !crossReceiptId
    || !discrepancyCode
    || !allowedDiscrepancyCodes.has(discrepancyCode)
    || !requestedBy
    || requestedAmountUsdMicros === null) {
    return null;
  }

  return {
    cycle_id: cycleId,
    cross_receipt_id: crossReceiptId,
    discrepancy_code: discrepancyCode,
    requested_by: requestedBy,
    requested_amount_usd_micros: requestedAmountUsdMicros,
    ...(normalizeOptionalString(payload.notes) ? { notes: normalizeOptionalString(payload.notes) } : {})
  };
}

function normalizeCaseUpdateRequest(request) {
  const payload = request?.case_update;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const caseId = normalizeOptionalString(payload.case_id);
  const nextStatus = normalizeOptionalString(payload.next_status);
  const decisionReasonCode = normalizeOptionalString(payload.decision_reason_code);
  const resolutionReference = normalizeOptionalString(payload.resolution_reference);
  const approvedAmount = payload.approved_amount_usd_micros === undefined
    ? null
    : parsePositiveInt(payload.approved_amount_usd_micros, { min: 1, max: 1000000000000 });

  if (!caseId || !nextStatus || !allowedCaseStatus.has(nextStatus)) return null;

  if ((nextStatus === 'approved' || nextStatus === 'rejected') && !decisionReasonCode) return null;
  if (nextStatus === 'approved' && approvedAmount === null) return null;
  if (nextStatus === 'resolved' && !resolutionReference) return null;

  return {
    case_id: caseId,
    next_status: nextStatus,
    ...(decisionReasonCode ? { decision_reason_code: decisionReasonCode } : {}),
    ...(approvedAmount !== null ? { approved_amount_usd_micros: approvedAmount } : {}),
    ...(resolutionReference ? { resolution_reference: resolutionReference } : {}),
    ...(normalizeOptionalString(payload.notes) ? { notes: normalizeOptionalString(payload.notes) } : {})
  };
}

function transitionAllowed({ fromStatus, toStatus }) {
  const map = {
    open: new Set(['approved', 'rejected']),
    approved: new Set(['resolved']),
    rejected: new Set(['resolved']),
    resolved: new Set([])
  };

  const allowed = map[fromStatus] ?? new Set();
  return allowed.has(toStatus);
}

function normalizeHistoryEntry(entry) {
  return {
    from_status: entry.from_status ?? null,
    to_status: entry.to_status,
    decision_reason_code: entry.decision_reason_code ?? null,
    resolution_reference: entry.resolution_reference ?? null,
    occurred_at: entry.occurred_at,
    ...(normalizeOptionalString(entry.notes) ? { notes: normalizeOptionalString(entry.notes) } : {})
  };
}

function normalizeCompensationCase(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  return {
    case_id: record.case_id,
    partner_id: record.partner_id,
    cycle_id: record.cycle_id,
    cross_receipt_id: record.cross_receipt_id,
    discrepancy_code: record.discrepancy_code,
    requested_by: {
      type: record.requested_by?.type,
      id: record.requested_by?.id
    },
    requested_amount_usd_micros: Number(record.requested_amount_usd_micros ?? 0),
    status: record.status,
    decision_reason_code: record.decision_reason_code ?? null,
    approved_amount_usd_micros: record.approved_amount_usd_micros ?? null,
    resolution_reference: record.resolution_reference ?? null,
    opened_at: record.opened_at,
    updated_at: record.updated_at,
    resolved_at: record.resolved_at ?? null,
    integration_mode: 'fixture_only',
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {}),
    history: Array.isArray(record.history)
      ? record.history.map(normalizeHistoryEntry)
      : []
  };
}

function findCaseByCycle({ cases, partnerId, cycleId }) {
  const rows = Object.values(cases ?? {})
    .filter(x => x?.partner_id === partnerId && x?.cycle_id === cycleId)
    .sort((a, b) => {
      const aMs = parseIsoMs(a?.updated_at) ?? -1;
      const bMs = parseIsoMs(b?.updated_at) ?? -1;
      return bMs - aMs;
    });

  return rows[0] ?? null;
}

export class CrossAdapterCompensationService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureCrossAdapterCompensationState(this.store);
  }

  createCase({ actor, auth, idempotencyKey, request }) {
    const op = 'compensation.cross_adapter.case.create';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can create cross-adapter compensation cases', { actor })
      };
    }

    const normalized = normalizeCaseCreateRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation case payload', {
          reason_code: 'cross_adapter_compensation_case_invalid'
        })
      };
    }

    const occurredAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const occurredAtMs = parseIsoMs(occurredAtRaw);

    if (occurredAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation case timestamp', {
          reason_code: 'cross_adapter_compensation_case_invalid_timestamp'
        })
      };
    }

    const state = ensureCrossAdapterCompensationState(this.store);
    const crossReceipt = state.crossReceipts[normalized.cycle_id] ?? null;

    if (!crossReceipt
      || crossReceipt.partner_id !== actor.id
      || crossReceipt.cross_receipt_id !== normalized.cross_receipt_id
      || crossReceipt.discrepancy_code !== normalized.discrepancy_code
      || crossReceipt.compensation_required !== true) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cross-adapter discrepancy is required for compensation case', {
          reason_code: 'cross_adapter_compensation_case_discrepancy_missing',
          cycle_id: normalized.cycle_id
        })
      };
    }

    const sigCheck = verifyReceiptSignature(crossReceipt);
    if (!sigCheck.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cross-adapter receipt signature is invalid', {
          reason_code: 'cross_adapter_compensation_cross_receipt_signature_invalid',
          cycle_id: normalized.cycle_id,
          verify_error: sigCheck.error ?? null
        })
      };
    }

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      mutate: () => {
        const existingForCycle = findCaseByCycle({
          cases: state.cases,
          partnerId: actor.id,
          cycleId: normalized.cycle_id
        });

        if (existingForCycle) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'compensation case already exists for cycle', {
              reason_code: 'cross_adapter_compensation_case_exists',
              cycle_id: normalized.cycle_id,
              case_id: existingForCycle.case_id
            })
          };
        }

        const caseCounter = nextCaseCounter(this.store);
        const caseId = `comp_case_${String(caseCounter).padStart(6, '0')}`;
        const nowIso = new Date(occurredAtMs).toISOString();

        const record = {
          case_id: caseId,
          partner_id: actor.id,
          cycle_id: normalized.cycle_id,
          cross_receipt_id: normalized.cross_receipt_id,
          discrepancy_code: normalized.discrepancy_code,
          requested_by: normalized.requested_by,
          requested_amount_usd_micros: normalized.requested_amount_usd_micros,
          status: 'open',
          decision_reason_code: 'case_opened',
          approved_amount_usd_micros: null,
          resolution_reference: null,
          opened_at: nowIso,
          updated_at: nowIso,
          resolved_at: null,
          integration_mode: 'fixture_only',
          ...(normalized.notes ? { notes: normalized.notes } : {}),
          history: [
            {
              from_status: null,
              to_status: 'open',
              decision_reason_code: 'case_opened',
              resolution_reference: null,
              occurred_at: nowIso
            }
          ]
        };

        state.cases[caseId] = record;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            case: normalizeCompensationCase(record)
          }
        };
      }
    });
  }

  updateCase({ actor, auth, idempotencyKey, request }) {
    const op = 'compensation.cross_adapter.case.update';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can update cross-adapter compensation cases', { actor })
      };
    }

    const normalized = normalizeCaseUpdateRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation case update payload', {
          reason_code: 'cross_adapter_compensation_case_invalid'
        })
      };
    }

    const occurredAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const occurredAtMs = parseIsoMs(occurredAtRaw);

    if (occurredAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation update timestamp', {
          reason_code: 'cross_adapter_compensation_case_invalid_timestamp'
        })
      };
    }

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      mutate: () => {
        const state = ensureCrossAdapterCompensationState(this.store);
        const record = state.cases[normalized.case_id] ?? null;

        if (!record || record.partner_id !== actor.id) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cross-adapter compensation case not found', {
              reason_code: 'cross_adapter_compensation_case_not_found',
              case_id: normalized.case_id
            })
          };
        }

        const fromStatus = record.status;
        const toStatus = normalized.next_status;

        if (!transitionAllowed({ fromStatus, toStatus })) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation transition', {
              reason_code: 'cross_adapter_compensation_transition_invalid',
              case_id: record.case_id,
              from_status: fromStatus,
              to_status: toStatus
            })
          };
        }

        const nowIso = new Date(occurredAtMs).toISOString();

        if (toStatus === 'approved') {
          record.approved_amount_usd_micros = normalized.approved_amount_usd_micros;
          record.decision_reason_code = normalized.decision_reason_code;
        } else if (toStatus === 'rejected') {
          record.approved_amount_usd_micros = 0;
          record.decision_reason_code = normalized.decision_reason_code;
        } else if (toStatus === 'resolved') {
          record.resolution_reference = normalized.resolution_reference;
          if (normalized.decision_reason_code) {
            record.decision_reason_code = normalized.decision_reason_code;
          }
          record.resolved_at = nowIso;
        }

        record.status = toStatus;
        record.updated_at = nowIso;

        const historyEntry = {
          from_status: fromStatus,
          to_status: toStatus,
          decision_reason_code: normalized.decision_reason_code ?? null,
          resolution_reference: normalized.resolution_reference ?? null,
          occurred_at: nowIso,
          ...(normalized.notes ? { notes: normalized.notes } : {})
        };

        record.history ||= [];
        record.history.push(historyEntry);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            case: normalizeCompensationCase(record)
          }
        };
      }
    });
  }

  getCase({ actor, auth, query }) {
    const op = 'compensation.cross_adapter.case.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read cross-adapter compensation cases', { actor })
      };
    }

    const caseId = normalizeOptionalString(query?.case_id);
    const cycleId = normalizeOptionalString(query?.cycle_id);
    const asOfRaw = normalizeOptionalString(query?.now_iso)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const asOfMs = parseIsoMs(asOfRaw);

    if ((!caseId && !cycleId) || asOfMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation case query', {
          reason_code: 'cross_adapter_compensation_query_invalid'
        })
      };
    }

    const state = ensureCrossAdapterCompensationState(this.store);
    let record = null;

    if (caseId) {
      const candidate = state.cases[caseId] ?? null;
      if (candidate && candidate.partner_id === actor.id) record = candidate;
    } else if (cycleId) {
      record = findCaseByCycle({
        cases: state.cases,
        partnerId: actor.id,
        cycleId
      });
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        as_of: new Date(asOfMs).toISOString(),
        integration_mode: 'fixture_only',
        case: record ? normalizeCompensationCase(record) : null
      }
    };
  }
}
