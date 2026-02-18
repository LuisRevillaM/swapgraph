import { authorizeApiOperation, authzEnforced } from '../core/authz.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForCycleId(cycleId) {
  return `corr_${cycleId}`;
}

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

function effectiveActor({ actor, auth }) {
  if (actor?.type === 'agent') {
    return auth?.delegation?.subject_actor ?? null;
  }
  return actor;
}

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

    const authzOp = authorizeApiOperation({ operationId: 'settlement.status', actor, auth });
    if (!authzOp.ok) {
      return { ok: false, body: errorResponse(correlationId, authzOp.error.code, authzOp.error.message, authzOp.error.details) };
    }

    let viewActor = actor;
    if (actor?.type === 'agent') {
      if (!authzEnforced()) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation', { actor }) };
      }
      const eff = effectiveActor({ actor, auth });
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

    const viewTimeline = isPartner(viewActor) ? timeline : redactTimeline({ timeline, viewer: viewActor });
    return { ok: true, body: { correlation_id: correlationId, timeline: viewTimeline } };
  }

  instructions({ actor, auth, cycleId }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const timeline = this.store.state.timelines[cycleId];
    if (!timeline) {
      return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'settlement timeline not found', { cycle_id: cycleId }) };
    }

    const authzOp = authorizeApiOperation({ operationId: 'settlement.instructions', actor, auth });
    if (!authzOp.ok) {
      return { ok: false, body: errorResponse(correlationId, authzOp.error.code, authzOp.error.message, authzOp.error.details) };
    }

    let viewActor = actor;
    if (actor?.type === 'agent') {
      if (!authzEnforced()) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation', { actor }) };
      }
      const eff = effectiveActor({ actor, auth });
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

    const mode = isPartner(viewActor) ? 'partner' : 'participant';
    const instructions = buildDepositInstructions({ timeline, mode, viewer: viewActor });
    const viewTimeline = isPartner(viewActor) ? timeline : redactTimeline({ timeline, viewer: viewActor });

    return { ok: true, body: { correlation_id: correlationId, timeline: viewTimeline, instructions } };
  }

  receipt({ actor, auth, cycleId }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const receipt = this.store.state.receipts[cycleId];
    if (!receipt) {
      return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'receipt not found', { cycle_id: cycleId }) };
    }

    const authzOp = authorizeApiOperation({ operationId: 'receipts.get', actor, auth });
    if (!authzOp.ok) {
      return { ok: false, body: errorResponse(correlationId, authzOp.error.code, authzOp.error.message, authzOp.error.details) };
    }

    let viewActor = actor;
    if (actor?.type === 'agent') {
      if (!authzEnforced()) {
        return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation', { actor }) };
      }
      const eff = effectiveActor({ actor, auth });
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

    return { ok: true, body: { correlation_id: correlationId, receipt } };
  }
}
