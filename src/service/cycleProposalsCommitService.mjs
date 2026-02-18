import { CommitService } from '../commit/commitService.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForCycleId(cycleId) {
  return `corr_${cycleId}`;
}

export class CycleProposalsCommitService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    this.commitSvc = new CommitService({ store });
  }

  accept({ actor, auth, idempotencyKey, proposalId, requestBody, occurredAt }) {
    const proposal = this.store.state.proposals?.[proposalId];
    if (!proposal) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationIdForCycleId(proposalId), 'NOT_FOUND', 'cycle proposal not found', { proposal_id: proposalId })
        }
      };
    }

    return this.commitSvc.accept({ actor, auth, idempotencyKey, proposal, requestBody, occurredAt });
  }

  decline({ actor, auth, idempotencyKey, proposalId, requestBody, occurredAt }) {
    const proposal = this.store.state.proposals?.[proposalId];
    if (!proposal) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationIdForCycleId(proposalId), 'NOT_FOUND', 'cycle proposal not found', { proposal_id: proposalId })
        }
      };
    }

    return this.commitSvc.decline({ actor, auth, idempotencyKey, proposal, requestBody, occurredAt });
  }
}
