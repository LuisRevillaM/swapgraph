import { authorizeApiOperation, authzEnforced } from '../core/authz.mjs';
import {
  actorKey,
  effectiveActorForDelegation,
  policyForDelegatedActor,
  evaluateProposalAgainstTradingPolicy,
  evaluateQuietHoursPolicy
} from '../core/tradingPolicyBoundaries.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForCycleId(cycleId) {
  return `corr_${cycleId}`;
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

export class SettlementReadService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
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
