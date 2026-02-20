import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { signReceipt, verifyReceiptSignature } from '../crypto/receiptSigning.mjs';

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

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function ensureCrossAdapterState(store) {
  store.state.cross_adapter_cycle_semantics ||= {};
  store.state.cross_adapter_cycle_receipts ||= {};
  store.state.tier2_adapter_preflight_history ||= [];
  store.state.receipts ||= {};
  store.state.idempotency ||= {};

  return {
    semantics: store.state.cross_adapter_cycle_semantics,
    receipts: store.state.cross_adapter_cycle_receipts,
    preflights: store.state.tier2_adapter_preflight_history,
    settlementReceipts: store.state.receipts,
    idempotency: store.state.idempotency
  };
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

  const idemState = ensureCrossAdapterState(store).idempotency;
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

const allowedEcosystems = new Set(['steam', 'polygon', 'solana', 'ethereum']);
const allowedTransferPrimitives = new Set(['custody_proof_bridge', 'escrow_atomic_swap', 'delegated_delivery']);
const allowedExecutionModels = new Set(['non_atomic_best_effort']);
const allowedAcknowledgements = new Set(['non_atomicity_understood', 'non_atomicity_accepted']);
const allowedLegStatuses = new Set(['completed', 'failed', 'pending_compensation']);

function normalizeDisclosure(disclosure) {
  if (!disclosure || typeof disclosure !== 'object' || Array.isArray(disclosure)) return null;

  const disclosureVersion = normalizeOptionalString(disclosure.disclosure_version);
  const acceptedAtRaw = normalizeOptionalString(disclosure.accepted_at);
  const acceptedAtMs = parseIsoMs(acceptedAtRaw);
  const acceptedBy = disclosure.accepted_by;
  const acknowledgement = normalizeOptionalString(disclosure.acknowledgement);

  if (!disclosureVersion
    || disclosure.disclosed !== true
    || !acceptedAtRaw
    || acceptedAtMs === null
    || !acknowledgement
    || !allowedAcknowledgements.has(acknowledgement)
    || !acceptedBy
    || typeof acceptedBy !== 'object'
    || Array.isArray(acceptedBy)
    || !['user', 'partner'].includes(acceptedBy.type)
    || !normalizeOptionalString(acceptedBy.id)) {
    return null;
  }

  return {
    disclosure_version: disclosureVersion,
    disclosed: true,
    accepted_by: {
      type: acceptedBy.type,
      id: normalizeOptionalString(acceptedBy.id)
    },
    acknowledgement,
    accepted_at: new Date(acceptedAtMs).toISOString(),
    ...(normalizeOptionalString(disclosure.notes) ? { notes: normalizeOptionalString(disclosure.notes) } : {})
  };
}

function normalizeSemanticsRequest(request) {
  const semantics = request?.semantics;
  if (!semantics || typeof semantics !== 'object' || Array.isArray(semantics)) return null;

  const cycleId = normalizeOptionalString(semantics.cycle_id);
  const sourceEcosystem = normalizeOptionalString(semantics.source_ecosystem);
  const targetEcosystem = normalizeOptionalString(semantics.target_ecosystem);
  const transferPrimitive = normalizeOptionalString(semantics.transfer_primitive);
  const executionModel = normalizeOptionalString(semantics.execution_model);
  const disclosure = normalizeDisclosure(semantics.non_atomicity_disclosure);
  const preflightId = normalizeOptionalString(semantics.preflight_id);

  if (!cycleId
    || !sourceEcosystem
    || !targetEcosystem
    || sourceEcosystem === targetEcosystem
    || !allowedEcosystems.has(sourceEcosystem)
    || !allowedEcosystems.has(targetEcosystem)
    || !transferPrimitive
    || !allowedTransferPrimitives.has(transferPrimitive)
    || !executionModel
    || !allowedExecutionModels.has(executionModel)
    || !disclosure) {
    return null;
  }

  return {
    cycle_id: cycleId,
    source_ecosystem: sourceEcosystem,
    target_ecosystem: targetEcosystem,
    transfer_primitive: transferPrimitive,
    execution_model: executionModel,
    non_atomicity_disclosure: disclosure,
    ...(preflightId ? { preflight_id: preflightId } : {})
  };
}

function findReadyPreflight({ store, partnerId, semantics }) {
  const state = ensureCrossAdapterState(store);
  const entries = (state.preflights ?? [])
    .filter(row => row?.partner_id === partnerId)
    .filter(row => row?.cycle_id === semantics.cycle_id)
    .filter(row => row?.source_ecosystem === semantics.source_ecosystem)
    .filter(row => row?.target_ecosystem === semantics.target_ecosystem)
    .filter(row => row?.transfer_primitive === semantics.transfer_primitive)
    .filter(row => row?.ready === true)
    .sort((a, b) => {
      const aMs = parseIsoMs(a?.requested_at) ?? -1;
      const bMs = parseIsoMs(b?.requested_at) ?? -1;
      return bMs - aMs;
    });

  if (semantics.preflight_id) {
    return entries.find(x => x?.preflight_id === semantics.preflight_id) ?? null;
  }

  return entries[0] ?? null;
}

function normalizeSemanticsRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  return {
    semantics_id: record.semantics_id,
    partner_id: record.partner_id,
    cycle_id: record.cycle_id,
    version: Number(record.version ?? 0),
    preflight_id: record.preflight_id,
    contract_version: Number(record.contract_version ?? 0),
    source_ecosystem: record.source_ecosystem,
    target_ecosystem: record.target_ecosystem,
    transfer_primitive: record.transfer_primitive,
    execution_model: record.execution_model,
    non_atomicity_disclosure: {
      disclosure_version: record.non_atomicity_disclosure?.disclosure_version,
      disclosed: record.non_atomicity_disclosure?.disclosed === true,
      accepted_by: {
        type: record.non_atomicity_disclosure?.accepted_by?.type,
        id: record.non_atomicity_disclosure?.accepted_by?.id
      },
      acknowledgement: record.non_atomicity_disclosure?.acknowledgement,
      accepted_at: record.non_atomicity_disclosure?.accepted_at,
      ...(normalizeOptionalString(record.non_atomicity_disclosure?.notes)
        ? { notes: normalizeOptionalString(record.non_atomicity_disclosure?.notes) }
        : {})
    },
    integration_mode: 'fixture_only',
    updated_at: record.updated_at
  };
}

function normalizeReceiptRequest(request) {
  const receipt = request?.receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;

  const cycleId = normalizeOptionalString(receipt.cycle_id);
  const sourceLegStatus = normalizeOptionalString(receipt.source_leg_status);
  const targetLegStatus = normalizeOptionalString(receipt.target_leg_status);
  const settlementReceiptId = normalizeOptionalString(receipt.settlement_receipt_id);

  if (!cycleId
    || !sourceLegStatus
    || !targetLegStatus
    || !allowedLegStatuses.has(sourceLegStatus)
    || !allowedLegStatuses.has(targetLegStatus)) {
    return null;
  }

  return {
    cycle_id: cycleId,
    source_leg_status: sourceLegStatus,
    target_leg_status: targetLegStatus,
    ...(settlementReceiptId ? { settlement_receipt_id: settlementReceiptId } : {}),
    ...(normalizeOptionalString(receipt.notes) ? { notes: normalizeOptionalString(receipt.notes) } : {})
  };
}

function discrepancyCode({ sourceLegStatus, targetLegStatus }) {
  if (sourceLegStatus === 'completed' && targetLegStatus === 'completed') return 'none';
  if (sourceLegStatus === 'completed' && targetLegStatus !== 'completed') return 'target_leg_unsettled';
  if (targetLegStatus === 'completed' && sourceLegStatus !== 'completed') return 'source_leg_unsettled';
  return 'both_legs_unsettled';
}

function normalizeCrossReceipt(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  return {
    cross_receipt_id: record.cross_receipt_id,
    partner_id: record.partner_id,
    cycle_id: record.cycle_id,
    settlement_receipt_id: record.settlement_receipt_id,
    settlement_receipt_signature_key_id: record.settlement_receipt_signature_key_id,
    settlement_final_state: record.settlement_final_state,
    semantics_version: Number(record.semantics_version ?? 0),
    source_ecosystem: record.source_ecosystem,
    target_ecosystem: record.target_ecosystem,
    transfer_primitive: record.transfer_primitive,
    execution_model: record.execution_model,
    non_atomicity_disclosure: {
      disclosure_version: record.non_atomicity_disclosure?.disclosure_version,
      disclosed: record.non_atomicity_disclosure?.disclosed === true,
      accepted_by: {
        type: record.non_atomicity_disclosure?.accepted_by?.type,
        id: record.non_atomicity_disclosure?.accepted_by?.id
      },
      acknowledgement: record.non_atomicity_disclosure?.acknowledgement,
      accepted_at: record.non_atomicity_disclosure?.accepted_at,
      ...(normalizeOptionalString(record.non_atomicity_disclosure?.notes)
        ? { notes: normalizeOptionalString(record.non_atomicity_disclosure?.notes) }
        : {})
    },
    source_leg_status: record.source_leg_status,
    target_leg_status: record.target_leg_status,
    discrepancy_code: record.discrepancy_code,
    compensation_required: record.compensation_required === true,
    integration_mode: 'fixture_only',
    created_at: record.created_at,
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {}),
    signature: {
      key_id: record.signature?.key_id,
      alg: record.signature?.alg,
      sig: record.signature?.sig
    }
  };
}

export class CrossAdapterCycleService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureCrossAdapterState(this.store);
  }

  recordCycleSemantics({ actor, auth, idempotencyKey, request }) {
    const op = 'adapter.cross_cycle.semantics.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record cross-adapter cycle semantics', { actor })
      };
    }

    const normalized = normalizeSemanticsRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter cycle semantics payload', {
          reason_code: 'cross_adapter_semantics_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter semantics timestamp', {
          reason_code: 'cross_adapter_semantics_invalid_timestamp'
        })
      };
    }

    const readyPreflight = findReadyPreflight({ store: this.store, partnerId: actor.id, semantics: normalized });
    if (!readyPreflight) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'tier2 preflight is required before cross-adapter semantics', {
          reason_code: 'cross_adapter_semantics_preflight_not_ready',
          cycle_id: normalized.cycle_id
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
        const state = ensureCrossAdapterState(this.store);
        const prior = normalizeSemanticsRecord(state.semantics[normalized.cycle_id] ?? null);
        const nextVersion = Number.isFinite(prior?.version) ? Number(prior.version) + 1 : 1;

        const record = {
          semantics_id: `cross_semantics_${normalized.cycle_id}`,
          partner_id: actor.id,
          cycle_id: normalized.cycle_id,
          version: nextVersion,
          preflight_id: readyPreflight.preflight_id,
          contract_version: Number(readyPreflight.contract_version ?? 0),
          source_ecosystem: normalized.source_ecosystem,
          target_ecosystem: normalized.target_ecosystem,
          transfer_primitive: normalized.transfer_primitive,
          execution_model: normalized.execution_model,
          non_atomicity_disclosure: normalized.non_atomicity_disclosure,
          integration_mode: 'fixture_only',
          updated_at: new Date(occurredAtMs).toISOString()
        };

        state.semantics[normalized.cycle_id] = record;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            semantics: normalizeSemanticsRecord(record)
          }
        };
      }
    });
  }

  recordCrossCycleReceipt({ actor, auth, idempotencyKey, request }) {
    const op = 'adapter.cross_cycle.receipt.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record cross-adapter receipts', { actor })
      };
    }

    const normalized = normalizeReceiptRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter receipt payload', {
          reason_code: 'cross_adapter_receipt_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter receipt timestamp', {
          reason_code: 'cross_adapter_receipt_invalid_timestamp'
        })
      };
    }

    const state = ensureCrossAdapterState(this.store);
    const semantics = normalizeSemanticsRecord(state.semantics[normalized.cycle_id] ?? null);
    if (!semantics || semantics.partner_id !== actor.id) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cross-adapter semantics missing for cycle', {
          reason_code: 'cross_adapter_receipt_semantics_missing',
          cycle_id: normalized.cycle_id
        })
      };
    }

    if (semantics.non_atomicity_disclosure?.disclosed !== true) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'non-atomicity disclosure acceptance is required', {
          reason_code: 'cross_adapter_receipt_disclosure_missing',
          cycle_id: normalized.cycle_id
        })
      };
    }

    const settlementReceipt = state.settlementReceipts[normalized.cycle_id] ?? null;
    if (!settlementReceipt) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'settlement receipt missing for cycle', {
          reason_code: 'cross_adapter_receipt_settlement_receipt_not_found',
          cycle_id: normalized.cycle_id
        })
      };
    }

    if (normalized.settlement_receipt_id && normalized.settlement_receipt_id !== settlementReceipt.id) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'settlement receipt does not match requested receipt id', {
          reason_code: 'cross_adapter_receipt_settlement_receipt_not_found',
          cycle_id: normalized.cycle_id,
          settlement_receipt_id: normalized.settlement_receipt_id
        })
      };
    }

    const settlementSigCheck = verifyReceiptSignature(settlementReceipt);
    if (!settlementSigCheck.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'settlement receipt signature is invalid', {
          reason_code: 'cross_adapter_receipt_settlement_signature_invalid',
          cycle_id: normalized.cycle_id,
          verify_error: settlementSigCheck.error ?? null
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
        const code = discrepancyCode({
          sourceLegStatus: normalized.source_leg_status,
          targetLegStatus: normalized.target_leg_status
        });

        const unsigned = {
          cross_receipt_id: `cross_receipt_${normalized.cycle_id}`,
          partner_id: actor.id,
          cycle_id: normalized.cycle_id,
          settlement_receipt_id: settlementReceipt.id,
          settlement_receipt_signature_key_id: settlementReceipt.signature?.key_id ?? 'unknown',
          settlement_final_state: settlementReceipt.final_state,
          semantics_version: semantics.version,
          source_ecosystem: semantics.source_ecosystem,
          target_ecosystem: semantics.target_ecosystem,
          transfer_primitive: semantics.transfer_primitive,
          execution_model: semantics.execution_model,
          non_atomicity_disclosure: semantics.non_atomicity_disclosure,
          source_leg_status: normalized.source_leg_status,
          target_leg_status: normalized.target_leg_status,
          discrepancy_code: code,
          compensation_required: code !== 'none',
          integration_mode: 'fixture_only',
          created_at: new Date(occurredAtMs).toISOString(),
          ...(normalized.notes ? { notes: normalized.notes } : {})
        };

        const signed = { ...unsigned, signature: signReceipt(unsigned) };
        ensureCrossAdapterState(this.store).receipts[normalized.cycle_id] = signed;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            cross_receipt: normalizeCrossReceipt(signed)
          }
        };
      }
    });
  }

  getCrossCycleReceipt({ actor, auth, query }) {
    const op = 'adapter.cross_cycle.receipt.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read cross-adapter receipts', { actor })
      };
    }

    const cycleId = normalizeOptionalString(query?.cycle_id);
    const nowIsoRaw = normalizeOptionalString(query?.now_iso) ?? new Date().toISOString();
    const nowIsoMs = parseIsoMs(nowIsoRaw);

    if (!cycleId || nowIsoMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cross-adapter receipt query', {
          reason_code: 'cross_adapter_receipt_query_invalid'
        })
      };
    }

    const state = ensureCrossAdapterState(this.store);
    const semantics = normalizeSemanticsRecord(state.semantics[cycleId] ?? null);
    const receipt = normalizeCrossReceipt(state.receipts[cycleId] ?? null);

    let signatureValid = false;
    if (receipt) {
      signatureValid = verifyReceiptSignature(receipt).ok;
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        cycle_id: cycleId,
        as_of: new Date(nowIsoMs).toISOString(),
        integration_mode: 'fixture_only',
        semantics: semantics && semantics.partner_id === actor.id ? semantics : null,
        cross_receipt: receipt && receipt.partner_id === actor.id ? receipt : null,
        signature_valid: receipt && receipt.partner_id === actor.id ? signatureValid : false
      }
    };
  }
}
