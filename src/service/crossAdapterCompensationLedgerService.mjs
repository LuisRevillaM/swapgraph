import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { buildSignedCrossAdapterCompensationLedgerExportPayload } from '../crypto/policyIntegritySigning.mjs';

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

function normalizeLimit(value) {
  return parsePositiveInt(value, { min: 1, max: 200 });
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

function ensureCrossAdapterCompensationLedgerState(store) {
  store.state.cross_adapter_compensation_cases ||= {};
  store.state.cross_adapter_compensation_ledger ||= [];
  store.state.cross_adapter_compensation_ledger_counter ||= 0;
  store.state.idempotency ||= {};

  return {
    cases: store.state.cross_adapter_compensation_cases,
    ledger: store.state.cross_adapter_compensation_ledger,
    idempotency: store.state.idempotency
  };
}

function nextLedgerCounter(store) {
  const current = Number.parseInt(String(store.state.cross_adapter_compensation_ledger_counter ?? 0), 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  store.state.cross_adapter_compensation_ledger_counter = next;
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

  const idemState = ensureCrossAdapterCompensationLedgerState(store).idempotency;
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

const allowedEntryTypes = new Set(['payout', 'reversal', 'adjustment']);
const payableCaseStatus = new Set(['approved', 'resolved']);

function normalizeLedgerRecordRequest(request) {
  const payload = request?.entry;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const caseId = normalizeOptionalString(payload.case_id);
  const entryType = normalizeOptionalString(payload.entry_type);
  const amountUsdMicros = parsePositiveInt(payload.amount_usd_micros, { min: 1, max: 1000000000000 });
  const reasonCode = normalizeOptionalString(payload.reason_code);

  if (!caseId
    || !entryType
    || !allowedEntryTypes.has(entryType)
    || amountUsdMicros === null
    || !reasonCode) {
    return null;
  }

  return {
    case_id: caseId,
    entry_type: entryType,
    amount_usd_micros: amountUsdMicros,
    reason_code: reasonCode,
    ...(normalizeOptionalString(payload.settlement_reference) ? { settlement_reference: normalizeOptionalString(payload.settlement_reference) } : {}),
    ...(normalizeOptionalString(payload.notes) ? { notes: normalizeOptionalString(payload.notes) } : {})
  };
}

function normalizeCompensationCaseView(record) {
  return {
    case_id: record.case_id,
    status: record.status,
    requested_amount_usd_micros: Number(record.requested_amount_usd_micros ?? 0),
    approved_amount_usd_micros: record.approved_amount_usd_micros ?? null,
    resolution_reference: record.resolution_reference ?? null,
    updated_at: record.updated_at
  };
}

function normalizeLedgerEntry(record) {
  return {
    entry_id: record.entry_id,
    partner_id: record.partner_id,
    case_id: record.case_id,
    cycle_id: record.cycle_id,
    cross_receipt_id: record.cross_receipt_id,
    entry_type: record.entry_type,
    amount_usd_micros: Number(record.amount_usd_micros ?? 0),
    reason_code: record.reason_code,
    settlement_reference: record.settlement_reference ?? null,
    integration_mode: 'fixture_only',
    recorded_at: record.recorded_at,
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {})
  };
}

function ledgerCursorKey(row) {
  const recordedAt = normalizeOptionalString(row?.recorded_at) ?? '';
  const entryId = normalizeOptionalString(row?.entry_id) ?? '';
  return `${recordedAt}|${entryId}`;
}

function normalizeLedgerEntries(rows) {
  return (rows ?? []).map(normalizeLedgerEntry).sort((a, b) => ledgerCursorKey(a).localeCompare(ledgerCursorKey(b)));
}

function exportSummary({ allEntries, pageEntries }) {
  const all = Array.isArray(allEntries) ? allEntries : [];
  const page = Array.isArray(pageEntries) ? pageEntries : [];

  const breakdownMap = new Map();
  for (const row of all) {
    const type = row.entry_type;
    const prior = breakdownMap.get(type) ?? {
      entry_type: type,
      entries: 0,
      amount_usd_micros: 0
    };

    prior.entries += 1;
    prior.amount_usd_micros += Number(row.amount_usd_micros ?? 0);
    breakdownMap.set(type, prior);
  }

  const totalAmount = all.reduce((acc, row) => acc + Number(row.amount_usd_micros ?? 0), 0);
  const returnedAmount = page.reduce((acc, row) => acc + Number(row.amount_usd_micros ?? 0), 0);

  return {
    total_entries: all.length,
    returned_entries: page.length,
    total_amount_usd_micros: totalAmount,
    returned_amount_usd_micros: returnedAmount,
    entry_type_breakdown: Array.from(breakdownMap.values()).sort((a, b) => String(a.entry_type).localeCompare(String(b.entry_type)))
  };
}

export class CrossAdapterCompensationLedgerService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureCrossAdapterCompensationLedgerState(this.store);
  }

  recordLedgerEntry({ actor, auth, idempotencyKey, request }) {
    const op = 'compensation.cross_adapter.ledger.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record compensation ledger entries', { actor })
      };
    }

    const normalized = normalizeLedgerRecordRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation ledger payload', {
          reason_code: 'cross_adapter_compensation_ledger_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation ledger timestamp', {
          reason_code: 'cross_adapter_compensation_ledger_invalid_timestamp'
        })
      };
    }

    const state = ensureCrossAdapterCompensationLedgerState(this.store);
    const compensationCase = state.cases[normalized.case_id] ?? null;

    if (!compensationCase || compensationCase.partner_id !== actor.id) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cross-adapter compensation case not found', {
          reason_code: 'cross_adapter_compensation_case_not_found',
          case_id: normalized.case_id
        })
      };
    }

    if (!payableCaseStatus.has(compensationCase.status)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cross-adapter compensation case is not payable', {
          reason_code: 'cross_adapter_compensation_case_not_payable',
          case_id: normalized.case_id,
          status: compensationCase.status
        })
      };
    }

    if (normalized.entry_type === 'payout') {
      const approvedAmount = Number(compensationCase.approved_amount_usd_micros ?? 0);
      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0 || normalized.amount_usd_micros > approvedAmount) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'ledger payout exceeds approved compensation amount', {
            reason_code: 'cross_adapter_compensation_ledger_amount_exceeds_approved',
            case_id: normalized.case_id,
            approved_amount_usd_micros: Number.isFinite(approvedAmount) ? approvedAmount : null,
            requested_amount_usd_micros: normalized.amount_usd_micros
          })
        };
      }
    }

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      mutate: () => {
        const entryCounter = nextLedgerCounter(this.store);
        const entryId = `comp_ledger_${String(entryCounter).padStart(6, '0')}`;
        const recordedAt = new Date(occurredAtMs).toISOString();

        const entry = {
          entry_id: entryId,
          partner_id: actor.id,
          case_id: compensationCase.case_id,
          cycle_id: compensationCase.cycle_id,
          cross_receipt_id: compensationCase.cross_receipt_id,
          entry_type: normalized.entry_type,
          amount_usd_micros: normalized.amount_usd_micros,
          reason_code: normalized.reason_code,
          settlement_reference: normalized.settlement_reference ?? null,
          integration_mode: 'fixture_only',
          recorded_at: recordedAt,
          ...(normalized.notes ? { notes: normalized.notes } : {})
        };

        state.ledger.push(entry);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            entry: normalizeLedgerEntry(entry),
            case: normalizeCompensationCaseView(compensationCase)
          }
        };
      }
    });
  }

  exportLedger({ actor, auth, query }) {
    const op = 'compensation.cross_adapter.ledger.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export compensation ledger', { actor })
      };
    }

    const caseId = normalizeOptionalString(query?.case_id);
    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const limit = normalizeLimit(query?.limit ?? 50);
    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const exportedAtRaw = normalizeOptionalString(query?.exported_at_iso)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const exportedAtMs = parseIsoMs(exportedAtRaw);

    if ((fromIso && fromMs === null)
      || (toIso && toMs === null)
      || (fromMs !== null && toMs !== null && toMs < fromMs)
      || limit === null
      || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter compensation ledger export query', {
          reason_code: 'cross_adapter_compensation_ledger_export_query_invalid'
        })
      };
    }

    const state = ensureCrossAdapterCompensationLedgerState(this.store);
    const allEntries = normalizeLedgerEntries(state.ledger)
      .filter(row => row.partner_id === actor.id)
      .filter(row => !caseId || row.case_id === caseId)
      .filter(row => {
        const rowMs = parseIsoMs(row.recorded_at);
        if (rowMs === null) return false;
        if (fromMs !== null && rowMs < fromMs) return false;
        if (toMs !== null && rowMs > toMs) return false;
        return true;
      });

    let startIndex = 0;
    if (cursorAfter) {
      const idx = allEntries.findIndex(row => ledgerCursorKey(row) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found in compensation ledger export window', {
            reason_code: 'cross_adapter_compensation_ledger_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      startIndex = idx + 1;
    }

    const entries = allEntries.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allEntries.length
      ? ledgerCursorKey(entries[entries.length - 1])
      : null;

    const summary = exportSummary({ allEntries, pageEntries: entries });
    const normalizedExportedAtIso = new Date(exportedAtMs).toISOString();

    const signedPayload = buildSignedCrossAdapterCompensationLedgerExportPayload({
      exportedAt: normalizedExportedAtIso,
      query: {
        ...(caseId ? { case_id: caseId } : {}),
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: normalizedExportedAtIso
      },
      summary,
      entries,
      totalFiltered: allEntries.length,
      nextCursor,
      withAttestation: true
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        integration_mode: 'fixture_only',
        ...signedPayload
      }
    };
  }
}
