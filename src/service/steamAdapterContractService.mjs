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

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function ensureSteamAdapterState(store) {
  store.state.steam_tier1_adapter_contract ||= {};
  store.state.steam_tier1_preflight_history ||= [];
  store.state.idempotency ||= {};

  return {
    contracts: store.state.steam_tier1_adapter_contract,
    preflightHistory: store.state.steam_tier1_preflight_history,
    idempotency: store.state.idempotency
  };
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
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

  const idemState = ensureSteamAdapterState(store).idempotency;
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

const allowedTransferPrimitives = new Set(['deposit_per_swap', 'vault_escrow']);
const allowedEscrowModes = new Set(['direct', 'escrow_agent']);
const allowedSettlementModes = new Set(['deposit_per_swap', 'vault_escrow', 'hybrid']);

function normalizeStringSet(values) {
  if (!Array.isArray(values)) return [];
  const out = values
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim());

  return Array.from(new Set(out)).sort();
}

function normalizeContractPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;

  const adapterVersion = normalizeOptionalString(policy.adapter_version);
  const transferPrimitive = normalizeOptionalString(policy.transfer_primitive);
  const escrowMode = normalizeOptionalString(policy.escrow_mode);
  const settlementModes = normalizeStringSet(policy.settlement_modes);
  const capabilityFlags = normalizeStringSet(policy.capability_flags);
  const supportedRegions = normalizeStringSet(policy.supported_regions);
  const maxBatchSize = parsePositiveInt(policy.max_batch_size, { min: 1, max: 1000 });
  const steamAppId = parsePositiveInt(policy.steam_app_id, { min: 1, max: 1000000 });

  if (!adapterVersion
    || !transferPrimitive
    || !allowedTransferPrimitives.has(transferPrimitive)
    || !escrowMode
    || !allowedEscrowModes.has(escrowMode)
    || maxBatchSize === null
    || steamAppId === null
    || settlementModes.length === 0
    || settlementModes.some(mode => !allowedSettlementModes.has(mode))) {
    return null;
  }

  return {
    adapter_version: adapterVersion,
    steam_app_id: steamAppId,
    transfer_primitive: transferPrimitive,
    escrow_mode: escrowMode,
    settlement_modes: settlementModes,
    capability_flags: capabilityFlags,
    supported_regions: supportedRegions,
    max_batch_size: maxBatchSize,
    requires_trade_hold: policy.requires_trade_hold === true,
    requires_mobile_guard: policy.requires_mobile_guard === true,
    dry_run_only: policy.dry_run_only !== false,
    notes: normalizeOptionalString(policy.notes)
  };
}

function normalizeStoredContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;

  return {
    partner_id: contract.partner_id,
    version: Number(contract.version ?? 0),
    integration_mode: 'fixture_only',
    adapter_version: contract.adapter_version,
    steam_app_id: Number(contract.steam_app_id ?? 0),
    transfer_primitive: contract.transfer_primitive,
    escrow_mode: contract.escrow_mode,
    settlement_modes: normalizeStringSet(contract.settlement_modes),
    capability_flags: normalizeStringSet(contract.capability_flags),
    supported_regions: normalizeStringSet(contract.supported_regions),
    max_batch_size: Number(contract.max_batch_size ?? 0),
    requires_trade_hold: contract.requires_trade_hold === true,
    requires_mobile_guard: contract.requires_mobile_guard === true,
    dry_run_only: contract.dry_run_only !== false,
    ...(normalizeOptionalString(contract.notes) ? { notes: normalizeOptionalString(contract.notes) } : {}),
    updated_at: contract.updated_at
  };
}

function preflightSummary(entries) {
  const rows = Array.isArray(entries) ? entries : [];

  return {
    total_preflight_requests: rows.length,
    ready_count: rows.filter(x => x.ready === true).length,
    blocked_count: rows.filter(x => x.ready !== true).length
  };
}

function normalizePreflightResult(entry) {
  return {
    preflight_id: entry.preflight_id,
    partner_id: entry.partner_id,
    contract_version: entry.contract_version,
    cycle_id: entry.cycle_id,
    settlement_mode: entry.settlement_mode,
    asset_count: entry.asset_count,
    dry_run: entry.dry_run === true,
    requested_at: entry.requested_at,
    ready: entry.ready === true,
    reason_code: entry.reason_code ?? null,
    integration_mode: 'fixture_only'
  };
}

export class SteamAdapterContractService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureSteamAdapterState(this.store);
  }

  upsertTier1Contract({ actor, auth, idempotencyKey, request }) {
    const op = 'adapter.steam_tier1.contract.upsert';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can upsert steam adapter contract', { actor })
      };
    }

    const normalized = normalizeContractPolicy(request?.contract);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid steam tier1 adapter contract payload', {
          reason_code: 'steam_adapter_contract_invalid'
        })
      };
    }

    const updatedAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const updatedAtMs = parseIsoMs(updatedAtRaw);
    if (updatedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for steam adapter contract upsert', {
          reason_code: 'steam_adapter_contract_invalid_timestamp'
        })
      };
    }

    const state = ensureSteamAdapterState(this.store);

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      mutate: () => {
        const prior = normalizeStoredContract(state.contracts[actor.id] ?? null);
        const nextVersion = Number.isFinite(prior?.version) ? Number(prior.version) + 1 : 1;

        const contract = {
          partner_id: actor.id,
          version: nextVersion,
          integration_mode: 'fixture_only',
          ...normalized,
          updated_at: new Date(updatedAtMs).toISOString()
        };

        state.contracts[actor.id] = contract;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            contract: normalizeStoredContract(contract)
          }
        };
      }
    });
  }

  getTier1Contract({ actor, auth, query }) {
    const op = 'adapter.steam_tier1.contract.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read steam adapter contract', { actor })
      };
    }

    const nowIso = normalizeOptionalString(query?.now_iso) ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIso);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid steam adapter contract query', {
          reason_code: 'steam_adapter_contract_query_invalid'
        })
      };
    }

    const state = ensureSteamAdapterState(this.store);
    const contract = normalizeStoredContract(state.contracts[actor.id] ?? null);
    const preflights = (state.preflightHistory ?? []).filter(x => x.partner_id === actor.id);

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        as_of: new Date(nowMs).toISOString(),
        integration_mode: 'fixture_only',
        contract,
        preflight_summary: preflightSummary(preflights)
      }
    };
  }

  preflightTier1Contract({ actor, auth, idempotencyKey, request }) {
    const op = 'adapter.steam_tier1.preflight';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can run steam adapter preflight', { actor })
      };
    }

    const cycleId = normalizeOptionalString(request?.cycle_id);
    const settlementMode = normalizeOptionalString(request?.settlement_mode);
    const assetCount = parsePositiveInt(request?.asset_count, { min: 1, max: 100000 });
    const dryRun = request?.dry_run !== false;

    if (!cycleId || !settlementMode || assetCount === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid steam adapter preflight payload', {
          reason_code: 'steam_adapter_preflight_invalid'
        })
      };
    }

    const requestedAtRaw = normalizeOptionalString(request?.requested_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const requestedAtMs = parseIsoMs(requestedAtRaw);
    if (requestedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for steam adapter preflight', {
          reason_code: 'steam_adapter_preflight_invalid_timestamp'
        })
      };
    }

    const state = ensureSteamAdapterState(this.store);
    const contract = normalizeStoredContract(state.contracts[actor.id] ?? null);
    if (!contract) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'steam adapter contract missing', {
          reason_code: 'steam_adapter_contract_missing'
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
        let ready = true;
        let reasonCode = null;

        if (!contract.settlement_modes.includes(settlementMode)) {
          ready = false;
          reasonCode = 'steam_adapter_settlement_mode_unsupported';
        } else if (contract.dry_run_only && dryRun !== true) {
          ready = false;
          reasonCode = 'steam_adapter_dry_run_required';
        } else if (assetCount > contract.max_batch_size) {
          ready = false;
          reasonCode = 'steam_adapter_batch_size_exceeded';
        }

        const preflightId = `steam_preflight_${String(state.preflightHistory.length + 1).padStart(6, '0')}`;
        const preflight = {
          preflight_id: preflightId,
          partner_id: actor.id,
          contract_version: contract.version,
          cycle_id: cycleId,
          settlement_mode: settlementMode,
          asset_count: assetCount,
          dry_run: dryRun,
          requested_at: new Date(requestedAtMs).toISOString(),
          ready,
          reason_code: reasonCode
        };

        state.preflightHistory.push(preflight);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            preflight: normalizePreflightResult(preflight),
            contract: contract
          }
        };
      }
    });
  }
}
