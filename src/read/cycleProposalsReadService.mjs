function errorResponse(code, message, details = {}) {
  return { error: { code, message, details } };
}

function correlationIdForProposalId(proposalId) {
  return `corr_${proposalId}`;
}

function correlationIdForCycleProposalsList(actor) {
  const t = actor?.type ?? 'unknown';
  const id = actor?.id ?? 'unknown';
  return `corr_cycle_proposals_list_${t}_${id}`;
}

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

function isPartner(actor) {
  return actor?.type === 'partner';
}

function proposalPartnerId({ store, proposalId }) {
  return store?.state?.tenancy?.proposals?.[proposalId]?.partner_id ?? null;
}

function isUserParticipant({ actor, proposal }) {
  if (actor?.type !== 'user') return false;
  const participants = new Set((proposal.participants ?? []).map(p => actorKey(p.actor)));
  return participants.has(actorKey(actor));
}

function authorizeRead({ actor, proposal, store }) {
  if (isPartner(actor)) {
    const pid = proposalPartnerId({ store, proposalId: proposal.id });
    if (!pid) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'proposal is not scoped to a partner',
        details: { actor, proposal_partner_id: null }
      };
    }
    if (pid !== actor.id) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'partner cannot access this proposal',
        details: { actor, proposal_partner_id: pid }
      };
    }
    return { ok: true };
  }
  if (actor?.type === 'agent') return { ok: false, code: 'FORBIDDEN', message: 'agent access requires delegation (not implemented)', details: { actor } };
  if (isUserParticipant({ actor, proposal })) return { ok: true };
  return { ok: false, code: 'FORBIDDEN', message: 'actor cannot access this proposal', details: { actor } };
}

export class CycleProposalsReadService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
  }

  list({ actor }) {
    if (actor?.type === 'agent') {
      return { ok: false, body: errorResponse('FORBIDDEN', 'agent access requires delegation (not implemented)', { actor }) };
    }

    const all = Object.values(this.store.state.proposals ?? {});

    let proposals;
    if (isPartner(actor)) {
      proposals = all.filter(p => proposalPartnerId({ store: this.store, proposalId: p.id }) === actor.id);
    } else if (actor?.type === 'user') {
      proposals = all.filter(p => isUserParticipant({ actor, proposal: p }));
    } else {
      return { ok: false, body: errorResponse('FORBIDDEN', 'actor type is not allowed', { actor }) };
    }

    proposals.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, body: { correlation_id: correlationIdForCycleProposalsList(actor), proposals } };
  }

  get({ actor, proposalId }) {
    const proposal = this.store.state.proposals?.[proposalId];
    if (!proposal) return { ok: false, body: errorResponse('NOT_FOUND', 'cycle proposal not found', { proposal_id: proposalId }) };

    const authz = authorizeRead({ actor, proposal, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(authz.code, authz.message, { ...authz.details, proposal_id: proposalId }) };

    return { ok: true, body: { correlation_id: correlationIdForProposalId(proposalId), proposal } };
  }
}
