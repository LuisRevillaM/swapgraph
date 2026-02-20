import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { buildSignedDisputeCompensationLinkageExportPayload } from '../crypto/policyIntegritySigning.mjs';

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

function ensureDisputeLinkageState(store) {
  store.state.partner_program_disputes ||= [];
  store.state.cross_adapter_compensation_cases ||= {};
  store.state.cross_adapter_compensation_ledger ||= [];
  store.state.cross_adapter_dispute_linkages ||= [];
  store.state.cross_adapter_dispute_linkage_counter ||= 0;
  store.state.idempotency ||= {};

  return {
    disputes: store.state.partner_program_disputes,
    cases: store.state.cross_adapter_compensation_cases,
    ledger: store.state.cross_adapter_compensation_ledger,
    linkages: store.state.cross_adapter_dispute_linkages,
    idempotency: store.state.idempotency
  };
}

function nextLinkageCounter(store) {
  const current = Number.parseInt(String(store.state.cross_adapter_dispute_linkage_counter ?? 0), 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  store.state.cross_adapter_dispute_linkage_counter = next;
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

  const idemState = ensureDisputeLinkageState(store).idempotency;
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

const allowedLinkageStatus = new Set(['linked', 'compensation_recorded', 'closed']);

function normalizeRecordRequest(request) {
  const payload = request?.linkage;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const disputeId = normalizeOptionalString(payload.dispute_id);
  const caseId = normalizeOptionalString(payload.case_id);

  if (!disputeId || !caseId) return null;

  return {
    dispute_id: disputeId,
    case_id: caseId,
    ...(normalizeOptionalString(payload.decision_reason_code) ? { decision_reason_code: normalizeOptionalString(payload.decision_reason_code) } : {}),
    ...(normalizeOptionalString(payload.notes) ? { notes: normalizeOptionalString(payload.notes) } : {})
  };
}

function normalizeUpdateRequest(request) {
  const payload = request?.linkage_update;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const linkageId = normalizeOptionalString(payload.linkage_id);
  const nextStatus = normalizeOptionalString(payload.next_status);
  const ledgerEntryId = normalizeOptionalString(payload.ledger_entry_id);

  if (!linkageId || !nextStatus || !allowedLinkageStatus.has(nextStatus)) return null;
  if (nextStatus === 'compensation_recorded' && !ledgerEntryId) return null;

  return {
    linkage_id: linkageId,
    next_status: nextStatus,
    ...(ledgerEntryId ? { ledger_entry_id: ledgerEntryId } : {}),
    ...(normalizeOptionalString(payload.decision_reason_code) ? { decision_reason_code: normalizeOptionalString(payload.decision_reason_code) } : {}),
    ...(normalizeOptionalString(payload.notes) ? { notes: normalizeOptionalString(payload.notes) } : {})
  };
}

function normalizeHistoryEntry(entry) {
  return {
    from_status: entry.from_status ?? null,
    to_status: entry.to_status,
    decision_reason_code: entry.decision_reason_code ?? null,
    ledger_entry_id: entry.ledger_entry_id ?? null,
    occurred_at: entry.occurred_at,
    ...(normalizeOptionalString(entry.notes) ? { notes: normalizeOptionalString(entry.notes) } : {})
  };
}

function normalizeLinkage(record) {
  return {
    linkage_id: record.linkage_id,
    partner_id: record.partner_id,
    dispute_id: record.dispute_id,
    case_id: record.case_id,
    cycle_id: record.cycle_id,
    cross_receipt_id: record.cross_receipt_id,
    status: record.status,
    ledger_entry_id: record.ledger_entry_id ?? null,
    decision_reason_code: record.decision_reason_code ?? null,
    opened_at: record.opened_at,
    updated_at: record.updated_at,
    closed_at: record.closed_at ?? null,
    integration_mode: 'fixture_only',
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {}),
    history: Array.isArray(record.history)
      ? record.history.map(normalizeHistoryEntry)
      : []
  };
}

function transitionAllowed({ fromStatus, toStatus }) {
  const map = {
    linked: new Set(['compensation_recorded', 'closed']),
    compensation_recorded: new Set(['closed']),
    closed: new Set([])
  };

  const allowed = map[fromStatus] ?? new Set();
  return allowed.has(toStatus);
}

function findDispute({ disputes, partnerId, disputeId }) {
  return (disputes ?? []).find(row => row?.partner_id === partnerId && row?.dispute_id === disputeId) ?? null;
}

function findCase({ cases, partnerId, caseId }) {
  const row = cases?.[caseId] ?? null;
  if (!row || row.partner_id !== partnerId) return null;
  return row;
}

function findLedgerEntry({ ledger, partnerId, caseId, entryId }) {
  return (ledger ?? []).find(row => row?.partner_id === partnerId && row?.case_id === caseId && row?.entry_id === entryId) ?? null;
}

function linkageCursorKey(row) {
  const updatedAt = normalizeOptionalString(row?.updated_at) ?? '';
  const linkageId = normalizeOptionalString(row?.linkage_id) ?? '';
  return `${updatedAt}|${linkageId}`;
}

function summarizeLinkages(all, page) {
  const rows = Array.isArray(all) ? all : [];
  const returned = Array.isArray(page) ? page : [];

  const byStatus = new Map();
  for (const row of rows) {
    const status = row.status;
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }

  return {
    total_linkages: rows.length,
    returned_linkages: returned.length,
    linked_to_ledger_count: rows.filter(row => normalizeOptionalString(row.ledger_entry_id)).length,
    closed_count: rows.filter(row => row.status === 'closed').length,
    by_status: Array.from(byStatus.entries()).map(([status, count]) => ({ status, count })).sort((a, b) => String(a.status).localeCompare(String(b.status)))
  };
}

export class CrossAdapterDisputeLinkageService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureDisputeLinkageState(this.store);
  }

  recordLinkage({ actor, auth, idempotencyKey, request }) {
    const op = 'compensation.dispute_linkage.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record dispute-compensation linkages', { actor })
      };
    }

    const normalized = normalizeRecordRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute-compensation linkage payload', {
          reason_code: 'cross_adapter_dispute_linkage_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute-compensation linkage timestamp', {
          reason_code: 'cross_adapter_dispute_linkage_invalid_timestamp'
        })
      };
    }

    const state = ensureDisputeLinkageState(this.store);
    const dispute = findDispute({ disputes: state.disputes, partnerId: actor.id, disputeId: normalized.dispute_id });
    if (!dispute) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'dispute not found for linkage', {
          reason_code: 'cross_adapter_dispute_linkage_dispute_not_found',
          dispute_id: normalized.dispute_id
        })
      };
    }

    const compensationCase = findCase({ cases: state.cases, partnerId: actor.id, caseId: normalized.case_id });
    if (!compensationCase) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'compensation case not found for linkage', {
          reason_code: 'cross_adapter_dispute_linkage_case_not_found',
          case_id: normalized.case_id
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
        const duplicate = state.linkages.find(row => row?.partner_id === actor.id && row?.dispute_id === normalized.dispute_id && row?.case_id === normalized.case_id) ?? null;
        if (duplicate) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'dispute-compensation linkage already exists', {
              reason_code: 'cross_adapter_dispute_linkage_exists',
              linkage_id: duplicate.linkage_id
            })
          };
        }

        const linkageCounter = nextLinkageCounter(this.store);
        const linkageId = `dispute_comp_link_${String(linkageCounter).padStart(6, '0')}`;
        const nowIso = new Date(occurredAtMs).toISOString();

        const linkage = {
          linkage_id: linkageId,
          partner_id: actor.id,
          dispute_id: normalized.dispute_id,
          case_id: normalized.case_id,
          cycle_id: compensationCase.cycle_id,
          cross_receipt_id: compensationCase.cross_receipt_id,
          status: 'linked',
          ledger_entry_id: null,
          decision_reason_code: normalized.decision_reason_code ?? 'linkage_opened',
          opened_at: nowIso,
          updated_at: nowIso,
          closed_at: null,
          integration_mode: 'fixture_only',
          ...(normalized.notes ? { notes: normalized.notes } : {}),
          history: [
            {
              from_status: null,
              to_status: 'linked',
              decision_reason_code: normalized.decision_reason_code ?? 'linkage_opened',
              ledger_entry_id: null,
              occurred_at: nowIso
            }
          ]
        };

        state.linkages.push(linkage);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            linkage: normalizeLinkage(linkage)
          }
        };
      }
    });
  }

  updateLinkage({ actor, auth, idempotencyKey, request }) {
    const op = 'compensation.dispute_linkage.update';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can update dispute-compensation linkages', { actor })
      };
    }

    const normalized = normalizeUpdateRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute-compensation linkage update payload', {
          reason_code: 'cross_adapter_dispute_linkage_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute-compensation linkage update timestamp', {
          reason_code: 'cross_adapter_dispute_linkage_invalid_timestamp'
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
        const state = ensureDisputeLinkageState(this.store);
        const linkage = state.linkages.find(row => row?.partner_id === actor.id && row?.linkage_id === normalized.linkage_id) ?? null;

        if (!linkage) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'dispute-compensation linkage not found', {
              reason_code: 'cross_adapter_dispute_linkage_not_found',
              linkage_id: normalized.linkage_id
            })
          };
        }

        if (!transitionAllowed({ fromStatus: linkage.status, toStatus: normalized.next_status })) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute-compensation linkage transition', {
              reason_code: 'cross_adapter_dispute_linkage_transition_invalid',
              linkage_id: linkage.linkage_id,
              from_status: linkage.status,
              to_status: normalized.next_status
            })
          };
        }

        const dispute = findDispute({ disputes: state.disputes, partnerId: actor.id, disputeId: linkage.dispute_id });
        if (!dispute) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'linked dispute not found', {
              reason_code: 'cross_adapter_dispute_linkage_dispute_not_found',
              dispute_id: linkage.dispute_id
            })
          };
        }

        const compensationCase = findCase({ cases: state.cases, partnerId: actor.id, caseId: linkage.case_id });
        if (!compensationCase) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'linked compensation case not found', {
              reason_code: 'cross_adapter_dispute_linkage_case_not_found',
              case_id: linkage.case_id
            })
          };
        }

        let ledgerEntryId = null;
        if (normalized.next_status === 'compensation_recorded') {
          const ledgerEntry = findLedgerEntry({
            ledger: state.ledger,
            partnerId: actor.id,
            caseId: linkage.case_id,
            entryId: normalized.ledger_entry_id
          });

          if (!ledgerEntry) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'ledger entry not found for linkage update', {
                reason_code: 'cross_adapter_dispute_linkage_ledger_not_found',
                linkage_id: linkage.linkage_id,
                ledger_entry_id: normalized.ledger_entry_id ?? null
              })
            };
          }

          ledgerEntryId = ledgerEntry.entry_id;
        }

        if (normalized.next_status === 'closed' && dispute.status !== 'resolved') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'dispute must be resolved before closing linkage', {
              reason_code: 'cross_adapter_dispute_linkage_close_requires_resolved_dispute',
              linkage_id: linkage.linkage_id,
              dispute_id: linkage.dispute_id,
              dispute_status: dispute.status
            })
          };
        }

        const nowIso = new Date(occurredAtMs).toISOString();
        const fromStatus = linkage.status;

        linkage.status = normalized.next_status;
        linkage.updated_at = nowIso;

        if (ledgerEntryId) {
          linkage.ledger_entry_id = ledgerEntryId;
        }

        if (normalized.decision_reason_code) {
          linkage.decision_reason_code = normalized.decision_reason_code;
        }

        if (normalized.next_status === 'closed') {
          linkage.closed_at = nowIso;
        }

        linkage.history ||= [];
        linkage.history.push({
          from_status: fromStatus,
          to_status: normalized.next_status,
          decision_reason_code: normalized.decision_reason_code ?? null,
          ledger_entry_id: ledgerEntryId,
          occurred_at: nowIso,
          ...(normalized.notes ? { notes: normalized.notes } : {})
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            linkage: normalizeLinkage(linkage)
          }
        };
      }
    });
  }

  exportLinkages({ actor, auth, query }) {
    const op = 'compensation.dispute_linkage.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export dispute-compensation linkages', { actor })
      };
    }

    const disputeId = normalizeOptionalString(query?.dispute_id);
    const caseId = normalizeOptionalString(query?.case_id);
    const status = normalizeOptionalString(query?.status);
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

    if ((status && !allowedLinkageStatus.has(status))
      || (fromIso && fromMs === null)
      || (toIso && toMs === null)
      || (fromMs !== null && toMs !== null && toMs < fromMs)
      || limit === null
      || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute-compensation linkage export query', {
          reason_code: 'cross_adapter_dispute_linkage_export_query_invalid'
        })
      };
    }

    const state = ensureDisputeLinkageState(this.store);
    const all = (state.linkages ?? [])
      .filter(row => row?.partner_id === actor.id)
      .map(normalizeLinkage)
      .filter(row => !disputeId || row.dispute_id === disputeId)
      .filter(row => !caseId || row.case_id === caseId)
      .filter(row => !status || row.status === status)
      .filter(row => {
        const rowMs = parseIsoMs(row.updated_at);
        if (rowMs === null) return false;
        if (fromMs !== null && rowMs < fromMs) return false;
        if (toMs !== null && rowMs > toMs) return false;
        return true;
      })
      .sort((a, b) => linkageCursorKey(a).localeCompare(linkageCursorKey(b)));

    let startIndex = 0;
    if (cursorAfter) {
      const idx = all.findIndex(row => linkageCursorKey(row) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found in dispute-compensation linkage export window', {
            reason_code: 'cross_adapter_dispute_linkage_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      startIndex = idx + 1;
    }

    const linkages = all.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < all.length
      ? linkageCursorKey(linkages[linkages.length - 1])
      : null;

    const summary = summarizeLinkages(all, linkages);
    const normalizedExportedAtIso = new Date(exportedAtMs).toISOString();

    const signedPayload = buildSignedDisputeCompensationLinkageExportPayload({
      exportedAt: normalizedExportedAtIso,
      query: {
        ...(disputeId ? { dispute_id: disputeId } : {}),
        ...(caseId ? { case_id: caseId } : {}),
        ...(status ? { status } : {}),
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: normalizedExportedAtIso
      },
      summary,
      linkages,
      totalFiltered: all.length,
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
