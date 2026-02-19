import { authorizeApiOperation, authzEnforced } from '../core/authz.mjs';
import {
  actorKey,
  effectiveActorForDelegation,
  policyForDelegatedActor,
  evaluateProposalAgainstTradingPolicy,
  evaluateQuietHoursPolicy
} from '../core/tradingPolicyBoundaries.mjs';
import { buildSignedSettlementVaultReconciliationExportPayload } from '../crypto/policyIntegritySigning.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForCycleId(cycleId) {
  return `corr_${cycleId}`;
}

function correlationIdForVaultReconciliationExport(cycleId) {
  return `corr_${cycleId}_vault_reconciliation_export`;
}

// actor/policy helpers are imported from core/tradingPolicyBoundaries.mjs

function isPartner(actor) {
  return actor?.type === 'partner';
}

function isUserParticipant({ actor, timeline }) {
  if (actor?.type !== 'user') return false;
  const participants = new Set((timeline.legs ?? []).flatMap(l => [actorKey(l.from_actor), actorKey(l.to_actor)]));
  return participants.has(actorKey(actor));
}

function cyclePartnerId({ store, cycleId }) {
  return store?.state?.tenancy?.cycles?.[cycleId]?.partner_id ?? null;
}

function authorizeRead({ actor, timeline, store, cycleId }) {
  if (isPartner(actor)) {
    const pid = cyclePartnerId({ store, cycleId });
    if (!pid) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'cycle is not scoped to a partner',
        details: { actor, cycle_partner_id: null }
      };
    }
    if (pid !== actor.id) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'partner cannot access this cycle',
        details: { actor, cycle_partner_id: pid }
      };
    }
    return { ok: true };
  }
  if (actor?.type === 'agent') return { ok: false, code: 'FORBIDDEN', message: 'agent access requires delegation (not implemented)', details: { actor } };
  if (isUserParticipant({ actor, timeline })) return { ok: true };
  return { ok: false, code: 'FORBIDDEN', message: 'actor cannot access this cycle', details: { actor } };
}

function proposalForCycle({ store, cycleId }) {
  return store?.state?.proposals?.[cycleId] ?? null;
}

function enforceAgentPolicyForCycle({ actor, auth, store, correlationId, cycleId, includeQuietHours }) {
  if (actor?.type !== 'agent') return { ok: true };

  const policy = policyForDelegatedActor({ actor, auth });
  if (!policy) {
    return {
      ok: false,
      body: errorResponse(correlationId, 'FORBIDDEN', 'delegation policy is required', { actor, cycle_id: cycleId })
    };
  }

  const proposal = proposalForCycle({ store, cycleId });
  if (proposal) {
    const pol = evaluateProposalAgainstTradingPolicy({ policy, proposal });
    if (!pol.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, pol.code, pol.message, { ...pol.details, cycle_id: cycleId })
      };
    }
  }

  if (includeQuietHours) {
    const nowIso = auth?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? null;
    const qh = evaluateQuietHoursPolicy({ policy, nowIso });
    if (!qh.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, qh.code, qh.message, { ...qh.details, cycle_id: cycleId })
      };
    }

    if (qh.in_quiet_hours) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'FORBIDDEN', 'delegation policy quiet hours', { ...qh.details, cycle_id: cycleId })
      };
    }
  }

  return { ok: true };
}

function redactActor({ actor, viewer }) {
  if (!actor) return actor;
  if (actorKey(actor) === actorKey(viewer)) return actor;
  return { type: actor.type, id: 'redacted' };
}

function redactLeg({ leg, viewer }) {
  const out = JSON.parse(JSON.stringify(leg));
  out.from_actor = redactActor({ actor: out.from_actor, viewer });
  out.to_actor = redactActor({ actor: out.to_actor, viewer });

  // Hide refs/timestamps for legs not owned by the viewer (owned = viewer is from_actor).
  const owned = actorKey(leg.from_actor) === actorKey(viewer);
  if (!owned) {
    delete out.deposit_ref;
    delete out.deposited_at;
    delete out.release_ref;
    delete out.released_at;
    delete out.refund_ref;
    delete out.refunded_at;
  }

  return out;
}

function redactTimeline({ timeline, viewer }) {
  const t = JSON.parse(JSON.stringify(timeline));
  t.legs = (t.legs ?? []).map(leg => redactLeg({ leg, viewer }));
  return t;
}

function buildDepositInstructions({ timeline, mode, viewer }) {
  const pendingLegs = (timeline.legs ?? []).filter(l => l.status === 'pending');

  const legs = mode === 'partner'
    ? pendingLegs
    : pendingLegs.filter(l => actorKey(l.from_actor) === actorKey(viewer));

  const instr = legs.map(l => ({
    actor: l.from_actor,
    kind: 'deposit',
    intent_id: l.intent_id,
    deposit_deadline_at: l.deposit_deadline_at
  }));

  // deterministic ordering
  instr.sort((a, b) => actorKey(a.actor).localeCompare(actorKey(b.actor)));
  return instr;
}

function buildVaultReconciliation({ timeline, store }) {
  const legs = timeline?.legs ?? [];
  const vaultLegs = legs.filter(leg => leg?.vault_holding_id && leg?.vault_reservation_id);
  if (vaultLegs.length === 0) return null;

  const entries = vaultLegs
    .map(leg => {
      const holding = store?.state?.vault_holdings?.[leg.vault_holding_id] ?? null;
      return {
        intent_id: leg.intent_id,
        holding_id: leg.vault_holding_id,
        reservation_id: leg.vault_reservation_id,
        leg_status: leg.status,
        holding_status: holding?.status ?? 'not_found',
        settlement_cycle_id: holding?.settlement_cycle_id ?? null,
        withdrawn_at: holding?.withdrawn_at ?? null
      };
    })
    .sort((a, b) => String(a.intent_id).localeCompare(String(b.intent_id)));

  const counts = {
    withdrawn: 0,
    available: 0,
    reserved: 0,
    not_found: 0
  };

  for (const entry of entries) {
    counts[entry.holding_status] = (counts[entry.holding_status] ?? 0) + 1;
  }

  const mode = entries.length === legs.length ? 'full' : 'partial';

  return {
    summary: {
      mode,
      total: entries.length,
      withdrawn: counts.withdrawn,
      available: counts.available,
      reserved: counts.reserved,
      not_found: counts.not_found
    },
    entries
  };
}

function buildStateTransitions({ store, cycleId }) {
  return (store?.state?.events ?? [])
    .filter(event => event?.type === 'cycle.state_changed' && event?.payload?.cycle_id === cycleId)
    .map(event => ({
      occurred_at: event.occurred_at,
      from_state: event.payload?.from_state,
      to_state: event.payload?.to_state,
      reason_code: event.payload?.reason_code ?? null
    }));
}

function parseOptionalBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  }
  return null;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeLimit(limit) {
  const n = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 200);
}

function exportCheckpointEnforced() {
  return process.env.SETTLEMENT_VAULT_EXPORT_CHECKPOINT_ENFORCE === '1';
}

function partnerProgramEnforced() {
  return process.env.SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE === '1';
}

function ensurePartnerProgramState(store) {
  store.state.partner_program ||= {};
  store.state.partner_program_usage ||= {};
  return {
    programs: store.state.partner_program,
    usage: store.state.partner_program_usage
  };
}

function parsePartnerProgramDailyLimit(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 1000000);
}

function quotaDayFromIso(iso) {
  const ms = parseIsoMs(iso);
  if (ms === null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function ensureVaultExportCheckpointState(store) {
  store.state.settlement_vault_export_checkpoints ||= {};
  return store.state.settlement_vault_export_checkpoints;
}

function settlementVaultExportCheckpointRetentionDays() {
  const raw = Number.parseInt(String(process.env.SETTLEMENT_VAULT_EXPORT_CHECKPOINT_RETENTION_DAYS ?? ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(raw, 3650);
}

function settlementVaultExportCheckpointRetentionWindowMs() {
  return settlementVaultExportCheckpointRetentionDays() * 24 * 60 * 60 * 1000;
}

function nowIsoForSettlementVaultExportRetention(query) {
  return query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function isSettlementVaultExportCheckpointExpired({ checkpointRecord, nowMs }) {
  if (!checkpointRecord || typeof checkpointRecord !== 'object') return true;
  const exportedAtMs = parseIsoMs(checkpointRecord.exported_at);
  if (exportedAtMs === null) return true;
  return nowMs > (exportedAtMs + settlementVaultExportCheckpointRetentionWindowMs());
}

function pruneExpiredSettlementVaultExportCheckpoints({ checkpointState, nowMs }) {
  if (!checkpointState || typeof checkpointState !== 'object') return;
  for (const [checkpointHash, checkpointRecord] of Object.entries(checkpointState)) {
    if (isSettlementVaultExportCheckpointExpired({ checkpointRecord, nowMs })) {
      delete checkpointState[checkpointHash];
    }
  }
}

function checkpointContextFromExportQuery({ cycleId, includeTransitions, query }) {
  return {
    cycle_id: cycleId,
    include_transitions: includeTransitions,
    limit: normalizeLimit(query?.limit)
  };
}

function checkpointContextKey(context) {
  return JSON.stringify(context);
}

function paginateVaultReconciliationEntries({ entries, query, correlationId }) {
  let orderedEntries = entries;

  const cursorAfter = normalizeOptionalString(query?.cursor_after);
  if (cursorAfter) {
    const idx = orderedEntries.findIndex(e => e?.intent_id === cursorAfter);
    if (idx < 0) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'cursor_after not found in reconciliation entry set', {
          cursor_after: cursorAfter
        })
      };
    }
    orderedEntries = orderedEntries.slice(idx + 1);
  }

  const totalFiltered = orderedEntries.length;
  const limit = normalizeLimit(query?.limit);
  let nextCursor = null;

  if (limit && orderedEntries.length > limit) {
    const page = orderedEntries.slice(0, limit);
    nextCursor = page[page.length - 1]?.intent_id ?? null;
    orderedEntries = page;
  }

  return {
    ok: true,
    entries: orderedEntries,
    totalFiltered,
    nextCursor,
    cursorAfter,
    limit
  };
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function exportQueryForSigning({ cycleId, query, includeTransitions }) {
  const out = {
    cycle_id: cycleId,
    include_transitions: includeTransitions
  };

  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  const limit = normalizeLimit(query?.limit);
  if (limit) out.limit = limit;

  const cursorAfter = normalizeOptionalString(query?.cursor_after);
  if (cursorAfter) out.cursor_after = cursorAfter;

  const attestationAfter = normalizeOptionalString(query?.attestation_after);
  if (attestationAfter) out.attestation_after = attestationAfter;

  const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
  if (checkpointAfter) out.checkpoint_after = checkpointAfter;

  return out;
}

export class SettlementReadService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensurePartnerProgramState(this.store);
    ensureVaultExportCheckpointState(this.store);
  }

  status({ actor, auth, cycleId }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const timeline = this.store.state.timelines[cycleId];
    if (!timeline) {
      return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'settlement timeline not found', { cycle_id: cycleId }) };
    }

    const authzOp = authorizeApiOperation({ operationId: 'settlement.status', actor, auth, store: this.store });
    if (!authzOp.ok) {
      return { ok: false, body: errorResponse(correlationId, authzOp.error.code, authzOp.error.message, authzOp.error.details) };
    }

    let viewActor = actor;
    if (actor?.type === 'agent') {
      if (!authzEnforced()) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation', { actor }) };
      }
      const eff = effectiveActorForDelegation({ actor, auth });
      if (!eff) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor }) };
      }
      viewActor = eff;
    }

    const authz = authorizeRead({ actor: viewActor, timeline, store: this.store, cycleId });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, authz.code, authz.message, { ...authz.details, cycle_id: cycleId })
      };
    }

    const policyCheck = enforceAgentPolicyForCycle({
      actor,
      auth,
      store: this.store,
      correlationId,
      cycleId,
      includeQuietHours: false
    });
    if (!policyCheck.ok) return policyCheck;

    const partnerView = isPartner(viewActor);
    const viewTimeline = partnerView ? timeline : redactTimeline({ timeline, viewer: viewActor });

    const body = {
      correlation_id: correlationId,
      timeline: viewTimeline
    };

    if (partnerView) {
      const vaultReconciliation = buildVaultReconciliation({ timeline, store: this.store });
      if (vaultReconciliation) {
        body.vault_reconciliation = vaultReconciliation;
        body.state_transitions = buildStateTransitions({ store: this.store, cycleId });
      }
    }

    return { ok: true, body };
  }

  instructions({ actor, auth, cycleId }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const timeline = this.store.state.timelines[cycleId];
    if (!timeline) {
      return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'settlement timeline not found', { cycle_id: cycleId }) };
    }

    const authzOp = authorizeApiOperation({ operationId: 'settlement.instructions', actor, auth, store: this.store });
    if (!authzOp.ok) {
      return { ok: false, body: errorResponse(correlationId, authzOp.error.code, authzOp.error.message, authzOp.error.details) };
    }

    let viewActor = actor;
    if (actor?.type === 'agent') {
      if (!authzEnforced()) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation', { actor }) };
      }
      const eff = effectiveActorForDelegation({ actor, auth });
      if (!eff) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor }) };
      }
      viewActor = eff;
    }

    const authz = authorizeRead({ actor: viewActor, timeline, store: this.store, cycleId });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, authz.code, authz.message, { ...authz.details, cycle_id: cycleId })
      };
    }

    const policyCheck = enforceAgentPolicyForCycle({
      actor,
      auth,
      store: this.store,
      correlationId,
      cycleId,
      includeQuietHours: true
    });
    if (!policyCheck.ok) return policyCheck;

    const partnerView = isPartner(viewActor);
    const mode = partnerView ? 'partner' : 'participant';
    const instructions = buildDepositInstructions({ timeline, mode, viewer: viewActor });
    const viewTimeline = partnerView ? timeline : redactTimeline({ timeline, viewer: viewActor });

    const body = {
      correlation_id: correlationId,
      timeline: viewTimeline,
      instructions
    };

    if (partnerView) {
      const vaultReconciliation = buildVaultReconciliation({ timeline, store: this.store });
      if (vaultReconciliation) {
        body.vault_reconciliation = vaultReconciliation;
        body.state_transitions = buildStateTransitions({ store: this.store, cycleId });
      }
    }

    return { ok: true, body };
  }

  vaultReconciliationExport({ actor, auth, cycleId, query }) {
    const correlationId = correlationIdForVaultReconciliationExport(cycleId);

    const timeline = this.store.state.timelines[cycleId];
    if (!timeline) {
      return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'settlement timeline not found', { cycle_id: cycleId }) };
    }

    const authzOp = authorizeApiOperation({ operationId: 'settlement.vault_reconciliation.export', actor, auth, store: this.store });
    if (!authzOp.ok) {
      return { ok: false, body: errorResponse(correlationId, authzOp.error.code, authzOp.error.message, authzOp.error.details) };
    }

    let viewActor = actor;
    if (actor?.type === 'agent') {
      if (!authzEnforced()) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation', { actor }) };
      }
      const eff = effectiveActorForDelegation({ actor, auth });
      if (!eff) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor }) };
      }
      viewActor = eff;
    }

    if (!isPartner(viewActor)) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'FORBIDDEN', 'only partner can export vault reconciliation', {
          actor,
          cycle_id: cycleId
        })
      };
    }

    const authz = authorizeRead({ actor: viewActor, timeline, store: this.store, cycleId });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, authz.code, authz.message, { ...authz.details, cycle_id: cycleId })
      };
    }

    const policyCheck = enforceAgentPolicyForCycle({
      actor,
      auth,
      store: this.store,
      correlationId,
      cycleId,
      includeQuietHours: false
    });
    if (!policyCheck.ok) return policyCheck;

    const partnerProgramActive = partnerProgramEnforced();
    let partnerProgramContext = null;

    const includeTransitionsRaw = query?.include_transitions;
    const includeTransitionsParsed = parseOptionalBoolean(includeTransitionsRaw);
    if (includeTransitionsRaw !== undefined && includeTransitionsParsed === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid include_transitions flag', {
          include_transitions: includeTransitionsRaw
        })
      };
    }
    const includeTransitions = includeTransitionsParsed ?? true;

    const vaultReconciliation = buildVaultReconciliation({ timeline, store: this.store });
    if (!vaultReconciliation) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'vault reconciliation is not available for this cycle', {
          cycle_id: cycleId,
          reason_code: 'vault_reconciliation_not_available'
        })
      };
    }

    const paged = paginateVaultReconciliationEntries({
      entries: vaultReconciliation.entries ?? [],
      query,
      correlationId
    });
    if (!paged.ok) return paged;

    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    if (paged.cursorAfter && !attestationAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'attestation_after is required when cursor_after is provided', {
          cursor_after: paged.cursorAfter,
          attestation_after: query?.attestation_after ?? null
        })
      };
    }

    if (!paged.cursorAfter && attestationAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'attestation_after is only allowed with cursor_after', {
          cursor_after: query?.cursor_after ?? null,
          attestation_after: attestationAfter
        })
      };
    }

    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
    const checkpointRequired = exportCheckpointEnforced();
    const checkpointState = ensureVaultExportCheckpointState(this.store);
    const checkpointContext = checkpointContextFromExportQuery({ cycleId, includeTransitions, query });
    const checkpointContextFingerprint = checkpointContextKey(checkpointContext);
    const checkpointNowIso = nowIsoForSettlementVaultExportRetention(query);
    const checkpointNowMs = parseIsoMs(checkpointNowIso);

    if (checkpointRequired && checkpointNowMs === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid now_iso for checkpoint retention', {
          now_iso: checkpointNowIso
        })
      };
    }

    if (checkpointRequired && paged.cursorAfter && !checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is required when cursor_after is provided', {
          cursor_after: paged.cursorAfter,
          checkpoint_after: query?.checkpoint_after ?? null
        })
      };
    }

    if (checkpointRequired && !paged.cursorAfter && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is only allowed with cursor_after', {
          cursor_after: query?.cursor_after ?? null,
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (!checkpointRequired && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is not enabled for this export contract', {
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (checkpointRequired && paged.cursorAfter) {
      const priorCheckpoint = checkpointState[checkpointAfter] ?? null;
      if (!priorCheckpoint) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after not found for vault reconciliation export continuation', {
            reason_code: 'checkpoint_after_not_found',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (isSettlementVaultExportCheckpointExpired({ checkpointRecord: priorCheckpoint, nowMs: checkpointNowMs })) {
        delete checkpointState[checkpointAfter];
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after expired for vault reconciliation export continuation', {
            reason_code: 'checkpoint_expired',
            checkpoint_after: checkpointAfter,
            exported_at: priorCheckpoint.exported_at ?? null,
            now_iso: checkpointNowIso,
            retention_days: settlementVaultExportCheckpointRetentionDays()
          })
        };
      }

      if (priorCheckpoint.next_cursor !== paged.cursorAfter) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'cursor_after does not match checkpoint continuation cursor', {
            reason_code: 'checkpoint_cursor_mismatch',
            checkpoint_after: checkpointAfter,
            expected_cursor_after: priorCheckpoint.next_cursor ?? null,
            cursor_after: paged.cursorAfter
          })
        };
      }

      if (priorCheckpoint.attestation_chain_hash !== attestationAfter) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'attestation_after does not match checkpoint continuation chain', {
            reason_code: 'checkpoint_attestation_mismatch',
            checkpoint_after: checkpointAfter,
            expected_attestation_after: priorCheckpoint.attestation_chain_hash ?? null,
            attestation_after: attestationAfter
          })
        };
      }

      if (priorCheckpoint.query_context_fingerprint !== checkpointContextFingerprint) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'vault reconciliation export continuation query does not match checkpoint context', {
            reason_code: 'checkpoint_query_mismatch',
            checkpoint_after: checkpointAfter,
            expected_context: priorCheckpoint.query_context ?? null,
            provided_context: checkpointContext
          })
        };
      }
    }

    const exportVaultReconciliation = {
      summary: vaultReconciliation.summary,
      entries: paged.entries
    };

    const stateTransitions = includeTransitions ? buildStateTransitions({ store: this.store, cycleId }) : undefined;

    const exportedAt = query?.exported_at_iso ?? query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    if (parseIsoMs(exportedAt) === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid exported_at timestamp for vault reconciliation export', {
          exported_at_iso: query?.exported_at_iso ?? null,
          now_iso: query?.now_iso ?? null
        })
      };
    }

    if (partnerProgramActive) {
      const partnerProgramState = ensurePartnerProgramState(this.store);
      const program = partnerProgramState.programs?.[viewActor.id] ?? null;
      if (!program) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'FORBIDDEN', 'partner program enrollment required for vault reconciliation export', {
            reason_code: 'partner_program_missing',
            partner_id: viewActor.id
          })
        };
      }

      if (program?.features?.vault_reconciliation_export !== true) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'FORBIDDEN', 'partner plan does not include vault reconciliation export', {
            reason_code: 'partner_feature_not_enabled',
            partner_id: viewActor.id,
            plan_id: program?.plan_id ?? null,
            feature: 'vault_reconciliation_export'
          })
        };
      }

      const quotaNowIso = query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
      const quotaDay = quotaDayFromIso(quotaNowIso);
      if (!quotaDay) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid now_iso for partner program quota', {
            now_iso: quotaNowIso
          })
        };
      }

      const dailyLimit = parsePartnerProgramDailyLimit(program?.quotas?.vault_reconciliation_export_daily);
      const usageKey = `${viewActor.id}:${quotaDay}:vault_reconciliation_export`;
      const used = Number.parseInt(String(partnerProgramState.usage?.[usageKey] ?? 0), 10);
      const usedSafe = Number.isFinite(used) && used >= 0 ? used : 0;

      if (dailyLimit !== null && usedSafe >= dailyLimit) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'partner daily vault export quota exceeded', {
            reason_code: 'partner_quota_exceeded',
            partner_id: viewActor.id,
            plan_id: program?.plan_id ?? null,
            feature: 'vault_reconciliation_export',
            quota_day: quotaDay,
            quota_used: usedSafe,
            quota_limit: dailyLimit
          })
        };
      }

      partnerProgramContext = {
        state: partnerProgramState,
        program,
        quotaDay,
        dailyLimit,
        usageKey,
        used: usedSafe
      };
    }

    const signingQuery = exportQueryForSigning({
      cycleId,
      query,
      includeTransitions
    });

    const withAttestation = Boolean(paged.limit || paged.cursorAfter || attestationAfter);
    const withCheckpoint = checkpointRequired && withAttestation;

    const signedPayload = buildSignedSettlementVaultReconciliationExportPayload({
      exportedAt,
      cycleId,
      timelineState: timeline.state,
      vaultReconciliation: exportVaultReconciliation,
      stateTransitions,
      totalFiltered: withAttestation ? paged.totalFiltered : undefined,
      nextCursor: withAttestation ? paged.nextCursor : undefined,
      withAttestation,
      withCheckpoint,
      query: signingQuery
    });

    if (checkpointRequired && signedPayload?.checkpoint?.checkpoint_hash) {
      checkpointState[signedPayload.checkpoint.checkpoint_hash] = {
        checkpoint_hash: signedPayload.checkpoint.checkpoint_hash,
        checkpoint_after: signedPayload.checkpoint.checkpoint_after ?? null,
        cycle_id: cycleId,
        next_cursor: signedPayload.checkpoint.next_cursor ?? null,
        attestation_chain_hash: signedPayload.attestation?.chain_hash ?? null,
        query_context_fingerprint: checkpointContextFingerprint,
        query_context: checkpointContext,
        exported_at: signedPayload.exported_at
      };
    }

    if (checkpointRequired) {
      pruneExpiredSettlementVaultExportCheckpoints({ checkpointState, nowMs: checkpointNowMs });
    }

    let partnerProgramView;
    if (partnerProgramContext) {
      const nextUsed = partnerProgramContext.used + 1;
      partnerProgramContext.state.usage[partnerProgramContext.usageKey] = nextUsed;
      partnerProgramView = {
        partner_id: viewActor.id,
        plan_id: partnerProgramContext.program?.plan_id ?? null,
        feature: 'vault_reconciliation_export',
        quota_day: partnerProgramContext.quotaDay,
        daily_limit: partnerProgramContext.dailyLimit,
        daily_used: nextUsed
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        ...signedPayload,
        ...(partnerProgramView ? { partner_program: partnerProgramView } : {})
      }
    };
  }

  receipt({ actor, auth, cycleId }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const receipt = this.store.state.receipts[cycleId];
    if (!receipt) {
      return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'receipt not found', { cycle_id: cycleId }) };
    }

    const authzOp = authorizeApiOperation({ operationId: 'receipts.get', actor, auth, store: this.store });
    if (!authzOp.ok) {
      return { ok: false, body: errorResponse(correlationId, authzOp.error.code, authzOp.error.message, authzOp.error.details) };
    }

    let viewActor = actor;
    if (actor?.type === 'agent') {
      if (!authzEnforced()) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation', { actor }) };
      }
      const eff = effectiveActorForDelegation({ actor, auth });
      if (!eff) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor }) };
      }
      viewActor = eff;
    }

    // Use timeline for participant check when available.
    const timeline = this.store.state.timelines[cycleId] ?? { legs: [] };
    const authz = authorizeRead({ actor: viewActor, timeline, store: this.store, cycleId });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, authz.code, authz.message, { ...authz.details, cycle_id: cycleId })
      };
    }

    const policyCheck = enforceAgentPolicyForCycle({
      actor,
      auth,
      store: this.store,
      correlationId,
      cycleId,
      includeQuietHours: false
    });
    if (!policyCheck.ok) return policyCheck;

    return { ok: true, body: { correlation_id: correlationId, receipt } };
  }
}
