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

function ensureTier2State(store) {
  store.state.tier2_adapter_capabilities ||= {};
  store.state.tier2_adapter_preflight_history ||= [];
  store.state.idempotency ||= {};

  return {
    capabilities: store.state.tier2_adapter_capabilities,
    preflightHistory: store.state.tier2_adapter_preflight_history,
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

  const idemState = ensureTier2State(store).idempotency;
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

const allowedEcosystems = new Set(['steam', 'polygon', 'solana', 'ethereum']);
const allowedTransferPrimitives = new Set(['custody_proof_bridge', 'escrow_atomic_swap', 'delegated_delivery']);
const allowedSettlementModes = new Set(['offchain_intent', 'escrow_bridge', 'hybrid']);

function normalizeCapabilityContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;

  const adapterVersion = normalizeOptionalString(contract.adapter_version);
  const sourceEcosystem = normalizeOptionalString(contract.source_ecosystem);
  const targetEcosystem = normalizeOptionalString(contract.target_ecosystem);
  const transferPrimitives = normalizeStringSet(contract.transfer_primitives);
  const settlementModes = normalizeStringSet(contract.settlement_modes);
  const capabilityFlags = normalizeStringSet(contract.capability_flags);
  const supportedRegions = normalizeStringSet(contract.supported_regions);
  const maxRouteHops = parsePositiveInt(contract.max_route_hops, { min: 1, max: 10 });

  if (!adapterVersion
    || !sourceEcosystem
    || !targetEcosystem
    || sourceEcosystem === targetEcosystem
    || !allowedEcosystems.has(sourceEcosystem)
    || !allowedEcosystems.has(targetEcosystem)
    || transferPrimitives.length === 0
    || transferPrimitives.some(x => !allowedTransferPrimitives.has(x))
    || settlementModes.length === 0
    || settlementModes.some(x => !allowedSettlementModes.has(x))
    || maxRouteHops === null) {
    return null;
  }

  return {
    adapter_version: adapterVersion,
    source_ecosystem: sourceEcosystem,
    target_ecosystem: targetEcosystem,
    transfer_primitives: transferPrimitives,
    settlement_modes: settlementModes,
    capability_flags: capabilityFlags,
    supported_regions: supportedRegions,
    max_route_hops: maxRouteHops,
    requires_trust_anchor: contract.requires_trust_anchor !== false,
    dry_run_only: contract.dry_run_only !== false,
    ...(normalizeOptionalString(contract.notes) ? { notes: normalizeOptionalString(contract.notes) } : {})
  };
}

function normalizeStoredCapability(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;

  return {
    partner_id: contract.partner_id,
    version: Number(contract.version ?? 0),
    integration_mode: 'fixture_only',
    adapter_version: contract.adapter_version,
    source_ecosystem: contract.source_ecosystem,
    target_ecosystem: contract.target_ecosystem,
    transfer_primitives: normalizeStringSet(contract.transfer_primitives),
    settlement_modes: normalizeStringSet(contract.settlement_modes),
    capability_flags: normalizeStringSet(contract.capability_flags),
    supported_regions: normalizeStringSet(contract.supported_regions),
    max_route_hops: Number(contract.max_route_hops ?? 0),
    requires_trust_anchor: contract.requires_trust_anchor !== false,
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

function normalizePreflightResult(preflight) {
  return {
    preflight_id: preflight.preflight_id,
    partner_id: preflight.partner_id,
    contract_version: preflight.contract_version,
    cycle_id: preflight.cycle_id,
    source_ecosystem: preflight.source_ecosystem,
    target_ecosystem: preflight.target_ecosystem,
    transfer_primitive: preflight.transfer_primitive,
    route_hops: preflight.route_hops,
    dry_run: preflight.dry_run === true,
    requested_at: preflight.requested_at,
    ready: preflight.ready === true,
    reason_code: preflight.reason_code ?? null,
    integration_mode: 'fixture_only'
  };
}

export class Tier2AdapterCapabilityService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureTier2State(this.store);
  }

  upsertCapability({ actor, auth, idempotencyKey, request }) {
    const op = 'adapter.tier2.capability.upsert';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can upsert tier2 adapter capability', { actor })
      };
    }

    const normalized = normalizeCapabilityContract(request?.capability);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid tier2 adapter capability payload', {
          reason_code: 'adapter_tier2_capability_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for tier2 capability upsert', {
          reason_code: 'adapter_tier2_capability_invalid_timestamp'
        })
      };
    }

    const state = ensureTier2State(this.store);

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      mutate: () => {
        const prior = normalizeStoredCapability(state.capabilities[actor.id] ?? null);
        const nextVersion = Number.isFinite(prior?.version) ? Number(prior.version) + 1 : 1;

        const capability = {
          partner_id: actor.id,
          version: nextVersion,
          integration_mode: 'fixture_only',
          ...normalized,
          updated_at: new Date(updatedAtMs).toISOString()
        };

        state.capabilities[actor.id] = capability;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            capability: normalizeStoredCapability(capability)
          }
        };
      }
    });
  }

  getCapability({ actor, auth, query }) {
    const op = 'adapter.tier2.capability.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read tier2 adapter capability', { actor })
      };
    }

    const nowIso = normalizeOptionalString(query?.now_iso) ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIso);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid tier2 capability query', {
          reason_code: 'adapter_tier2_capability_query_invalid'
        })
      };
    }

    const state = ensureTier2State(this.store);
    const capability = normalizeStoredCapability(state.capabilities[actor.id] ?? null);
    const preflights = (state.preflightHistory ?? []).filter(x => x.partner_id === actor.id);

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        as_of: new Date(nowMs).toISOString(),
        integration_mode: 'fixture_only',
        capability,
        preflight_summary: preflightSummary(preflights)
      }
    };
  }

  preflightCapability({ actor, auth, idempotencyKey, request }) {
    const op = 'adapter.tier2.preflight';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can run tier2 adapter preflight', { actor })
      };
    }

    const cycleId = normalizeOptionalString(request?.cycle_id);
    const sourceEcosystem = normalizeOptionalString(request?.source_ecosystem);
    const targetEcosystem = normalizeOptionalString(request?.target_ecosystem);
    const transferPrimitive = normalizeOptionalString(request?.transfer_primitive);
    const routeHops = parsePositiveInt(request?.route_hops, { min: 1, max: 20 });
    const dryRun = request?.dry_run !== false;

    if (!cycleId
      || !sourceEcosystem
      || !targetEcosystem
      || !transferPrimitive
      || routeHops === null
      || !allowedEcosystems.has(sourceEcosystem)
      || !allowedEcosystems.has(targetEcosystem)
      || !allowedTransferPrimitives.has(transferPrimitive)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid tier2 adapter preflight payload', {
          reason_code: 'adapter_tier2_preflight_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for tier2 preflight', {
          reason_code: 'adapter_tier2_preflight_invalid_timestamp'
        })
      };
    }

    const state = ensureTier2State(this.store);
    const capability = normalizeStoredCapability(state.capabilities[actor.id] ?? null);
    if (!capability) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'tier2 adapter capability missing', {
          reason_code: 'adapter_tier2_capability_missing'
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

        if (capability.source_ecosystem !== sourceEcosystem || capability.target_ecosystem !== targetEcosystem) {
          ready = false;
          reasonCode = 'adapter_tier2_ecosystem_mismatch';
        } else if (!capability.transfer_primitives.includes(transferPrimitive)) {
          ready = false;
          reasonCode = 'adapter_tier2_transfer_primitive_unsupported';
        } else if (routeHops > capability.max_route_hops) {
          ready = false;
          reasonCode = 'adapter_tier2_route_hops_exceeded';
        } else if (capability.dry_run_only && dryRun !== true) {
          ready = false;
          reasonCode = 'adapter_tier2_dry_run_required';
        }

        const preflightId = `tier2_preflight_${String(state.preflightHistory.length + 1).padStart(6, '0')}`;
        const preflight = {
          preflight_id: preflightId,
          partner_id: actor.id,
          contract_version: capability.version,
          cycle_id: cycleId,
          source_ecosystem: sourceEcosystem,
          target_ecosystem: targetEcosystem,
          transfer_primitive: transferPrimitive,
          route_hops: routeHops,
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
            capability: capability
          }
        };
      }
    });
  }
}
