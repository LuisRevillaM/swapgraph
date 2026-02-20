import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';

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

function normalizeStringSet(values) {
  if (!Array.isArray(values)) return [];
  const out = values
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim());
  return Array.from(new Set(out)).sort();
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function ensureSteamLiveProofState(store) {
  store.state.steam_tier1_adapter_contract ||= {};
  store.state.steam_tier1_live_deposit_per_swap_proofs ||= [];
  store.state.steam_tier1_live_vault_proofs ||= [];
  store.state.idempotency ||= {};

  return {
    contracts: store.state.steam_tier1_adapter_contract,
    liveDepositPerSwapProofs: store.state.steam_tier1_live_deposit_per_swap_proofs,
    liveVaultProofs: store.state.steam_tier1_live_vault_proofs,
    idempotency: store.state.idempotency
  };
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function normalizeStoredContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;

  return {
    partner_id: normalizeOptionalString(contract.partner_id),
    version: Number(contract.version ?? 0),
    transfer_primitive: normalizeOptionalString(contract.transfer_primitive),
    settlement_modes: normalizeStringSet(contract.settlement_modes),
    max_batch_size: Number(contract.max_batch_size ?? 0),
    dry_run_only: contract.dry_run_only !== false
  };
}

function normalizeEvidenceRefs(values) {
  if (!Array.isArray(values)) return [];
  const out = values
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim());
  return Array.from(new Set(out));
}

function normalizeDepositPerSwapLiveProofRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;

  const cycleId = normalizeOptionalString(request.cycle_id);
  const settlementId = normalizeOptionalString(request.settlement_id);
  const preflightId = normalizeOptionalString(request.preflight_id);
  const receiptId = normalizeOptionalString(request.receipt_id);
  const steamTradeOfferId = normalizeOptionalString(request.steam_trade_offer_id);
  const steamTradeStatus = normalizeOptionalString(request.steam_trade_status);
  const depositReference = normalizeOptionalString(request.deposit_reference);
  const assetCount = parsePositiveInt(request.asset_count, { min: 1, max: 100000 });
  const liveMode = request.live_mode === true;
  const operatorRef = normalizeOptionalString(request.operator_ref);
  const evidenceRefs = normalizeEvidenceRefs(request.evidence_refs);
  const notes = normalizeOptionalString(request.notes);

  const allowedTradeStatuses = new Set(['accepted', 'completed']);

  if (!cycleId
    || !settlementId
    || !receiptId
    || !steamTradeOfferId
    || !steamTradeStatus
    || !allowedTradeStatuses.has(steamTradeStatus)
    || !depositReference
    || assetCount === null
    || !operatorRef
    || evidenceRefs.length === 0) {
    return null;
  }

  return {
    cycle_id: cycleId,
    settlement_id: settlementId,
    ...(preflightId ? { preflight_id: preflightId } : {}),
    receipt_id: receiptId,
    steam_trade_offer_id: steamTradeOfferId,
    steam_trade_status: steamTradeStatus,
    deposit_reference: depositReference,
    asset_count: assetCount,
    live_mode: liveMode,
    operator_ref: operatorRef,
    evidence_refs: evidenceRefs,
    ...(notes ? { notes } : {})
  };
}

function normalizeVaultLiveProofRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;

  const cycleId = normalizeOptionalString(request.cycle_id);
  const settlementId = normalizeOptionalString(request.settlement_id);
  const preflightId = normalizeOptionalString(request.preflight_id);
  const receiptId = normalizeOptionalString(request.receipt_id);
  const vaultHoldingIds = normalizeStringSet(request.vault_holding_ids);
  const vaultReservationIds = normalizeStringSet(request.vault_reservation_ids);
  const vaultSettlementMode = normalizeOptionalString(request.vault_settlement_mode);
  const lifecycleEvents = normalizeStringSet(request.lifecycle_events);
  const instantReady = request.instant_ready === true;
  const liveMode = request.live_mode === true;
  const operatorRef = normalizeOptionalString(request.operator_ref);
  const evidenceRefs = normalizeEvidenceRefs(request.evidence_refs);
  const notes = normalizeOptionalString(request.notes);

  const allowedSettlementModes = new Set(['vault_escrow', 'hybrid']);
  const allowedLifecycleEvents = new Set(['deposit', 'reserve', 'release', 'withdraw']);

  if (!cycleId
    || !settlementId
    || !receiptId
    || vaultHoldingIds.length === 0
    || vaultReservationIds.length === 0
    || !vaultSettlementMode
    || !allowedSettlementModes.has(vaultSettlementMode)
    || lifecycleEvents.length === 0
    || lifecycleEvents.some(x => !allowedLifecycleEvents.has(x))
    || !operatorRef
    || evidenceRefs.length === 0) {
    return null;
  }

  return {
    cycle_id: cycleId,
    settlement_id: settlementId,
    ...(preflightId ? { preflight_id: preflightId } : {}),
    receipt_id: receiptId,
    vault_holding_ids: vaultHoldingIds,
    vault_reservation_ids: vaultReservationIds,
    vault_settlement_mode: vaultSettlementMode,
    lifecycle_events: lifecycleEvents,
    instant_ready: instantReady,
    live_mode: liveMode,
    operator_ref: operatorRef,
    evidence_refs: evidenceRefs,
    ...(notes ? { notes } : {})
  };
}

function normalizeDepositPerSwapLiveProofRecord(record) {
  return {
    proof_id: record.proof_id,
    partner_id: record.partner_id,
    contract_version: record.contract_version,
    cycle_id: record.cycle_id,
    settlement_id: record.settlement_id,
    ...(record.preflight_id ? { preflight_id: record.preflight_id } : {}),
    receipt_id: record.receipt_id,
    steam_trade_offer_id: record.steam_trade_offer_id,
    steam_trade_status: record.steam_trade_status,
    deposit_reference: record.deposit_reference,
    asset_count: record.asset_count,
    live_mode: record.live_mode === true,
    operator_ref: record.operator_ref,
    evidence_refs: normalizeEvidenceRefs(record.evidence_refs),
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {}),
    integration_mode: 'live',
    recorded_at: record.recorded_at,
    proof_hash: record.proof_hash
  };
}

function normalizeVaultLiveProofRecord(record) {
  return {
    proof_id: record.proof_id,
    partner_id: record.partner_id,
    contract_version: record.contract_version,
    cycle_id: record.cycle_id,
    settlement_id: record.settlement_id,
    ...(record.preflight_id ? { preflight_id: record.preflight_id } : {}),
    receipt_id: record.receipt_id,
    vault_holding_ids: normalizeStringSet(record.vault_holding_ids),
    vault_reservation_ids: normalizeStringSet(record.vault_reservation_ids),
    vault_settlement_mode: record.vault_settlement_mode,
    lifecycle_events: normalizeStringSet(record.lifecycle_events),
    instant_ready: record.instant_ready === true,
    live_mode: record.live_mode === true,
    operator_ref: record.operator_ref,
    evidence_refs: normalizeEvidenceRefs(record.evidence_refs),
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {}),
    integration_mode: 'live',
    recorded_at: record.recorded_at,
    proof_hash: record.proof_hash
  };
}

function applyIdempotentMutation({ store, actor, operationId, idempotencyKey, requestPayload, mutate, correlationId }) {
  const key = normalizeOptionalString(idempotencyKey);
  if (!key) {
    return {
      ok: false,
      body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'idempotency key is required', {
        operation_id: operationId
      })
    };
  }

  const idemState = ensureSteamLiveProofState(store).idempotency;
  const scopeKey = `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}|${operationId}|${key}`;
  const incomingHash = payloadHash(requestPayload);
  const prior = idemState[scopeKey] ?? null;

  if (prior) {
    if (prior.payload_hash !== incomingHash) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reuse with different payload', {
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

function integrationEnabledConflict(correlation) {
  return {
    ok: false,
    body: errorResponse(correlation, 'CONFLICT', 'integration gate is disabled', {
      reason_code: 'steam_live_proof_integration_disabled',
      required_env: 'INTEGRATION_ENABLED=1'
    })
  };
}

export class SteamAdapterLiveProofService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureSteamLiveProofState(this.store);
  }

  recordDepositPerSwapLiveProof({ actor, auth, idempotencyKey, request }) {
    const op = 'adapter.steam_tier1.live_proof.deposit_per_swap.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record steam live proof', { actor })
      };
    }

    if (process.env.INTEGRATION_ENABLED !== '1') return integrationEnabledConflict(corr);

    const normalized = normalizeDepositPerSwapLiveProofRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid steam live proof payload', {
          reason_code: 'steam_live_proof_invalid'
        })
      };
    }

    if (normalized.live_mode !== true) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONFLICT', 'steam live proof requires live_mode=true', {
          reason_code: 'steam_live_proof_requires_live_mode'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for steam live proof', {
          reason_code: 'steam_live_proof_invalid_timestamp'
        })
      };
    }

    const state = ensureSteamLiveProofState(this.store);
    const contract = normalizeStoredContract(state.contracts[actor.id] ?? null);
    if (!contract) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'steam adapter contract missing', {
          reason_code: 'steam_live_proof_contract_missing'
        })
      };
    }

    if (!contract.settlement_modes.includes('deposit_per_swap') || contract.dry_run_only === true) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONFLICT', 'steam adapter contract does not allow live deposit-per-swap proof', {
          reason_code: 'steam_live_proof_contract_unsupported_mode',
          contract_version: contract.version
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
        const proofId = `steam_live_dps_${String(state.liveDepositPerSwapProofs.length + 1).padStart(6, '0')}`;
        const canonicalProofPayload = {
          proof_id: proofId,
          partner_id: actor.id,
          contract_version: contract.version,
          ...normalized,
          integration_mode: 'live',
          recorded_at: new Date(occurredAtMs).toISOString()
        };

        const proofHash = createHash('sha256').update(canonicalStringify(canonicalProofPayload), 'utf8').digest('hex');

        const proofRecord = {
          ...canonicalProofPayload,
          proof_hash: proofHash
        };

        state.liveDepositPerSwapProofs.push(proofRecord);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            proof: normalizeDepositPerSwapLiveProofRecord(proofRecord)
          }
        };
      }
    });
  }

  recordVaultLiveProof({ actor, auth, idempotencyKey, request }) {
    const op = 'adapter.steam_tier1.live_proof.vault.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record steam vault live proof', { actor })
      };
    }

    if (process.env.INTEGRATION_ENABLED !== '1') return integrationEnabledConflict(corr);

    const normalized = normalizeVaultLiveProofRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid steam vault live proof payload', {
          reason_code: 'steam_live_proof_vault_invalid'
        })
      };
    }

    if (normalized.live_mode !== true) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONFLICT', 'steam live proof requires live_mode=true', {
          reason_code: 'steam_live_proof_requires_live_mode'
        })
      };
    }

    const requiredLifecycle = ['deposit', 'reserve', 'release', 'withdraw'];
    const missingLifecycle = requiredLifecycle.filter(x => !normalized.lifecycle_events.includes(x));
    if (missingLifecycle.length > 0) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONFLICT', 'steam vault lifecycle evidence is incomplete', {
          reason_code: 'steam_live_proof_vault_lifecycle_incomplete',
          missing_events: missingLifecycle
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for steam vault live proof', {
          reason_code: 'steam_live_proof_invalid_timestamp'
        })
      };
    }

    const state = ensureSteamLiveProofState(this.store);
    const contract = normalizeStoredContract(state.contracts[actor.id] ?? null);
    if (!contract) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'steam adapter contract missing', {
          reason_code: 'steam_live_proof_contract_missing'
        })
      };
    }

    if (!contract.settlement_modes.includes(normalized.vault_settlement_mode) || contract.dry_run_only === true) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONFLICT', 'steam adapter contract does not allow live vault proof', {
          reason_code: 'steam_live_proof_contract_unsupported_mode',
          contract_version: contract.version,
          settlement_mode: normalized.vault_settlement_mode
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
        const proofId = `steam_live_vault_${String(state.liveVaultProofs.length + 1).padStart(6, '0')}`;
        const canonicalProofPayload = {
          proof_id: proofId,
          partner_id: actor.id,
          contract_version: contract.version,
          ...normalized,
          integration_mode: 'live',
          recorded_at: new Date(occurredAtMs).toISOString()
        };

        const proofHash = createHash('sha256').update(canonicalStringify(canonicalProofPayload), 'utf8').digest('hex');

        const proofRecord = {
          ...canonicalProofPayload,
          proof_hash: proofHash
        };

        state.liveVaultProofs.push(proofRecord);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            proof: normalizeVaultLiveProofRecord(proofRecord)
          }
        };
      }
    });
  }
}
