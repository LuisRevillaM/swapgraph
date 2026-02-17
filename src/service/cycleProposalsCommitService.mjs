import { CommitService } from '../commit/commitService.mjs';

function errorResponse(code, message, details = {}) {
  return { error: { code, message, details } };
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

  accept({ actor, idempotencyKey, proposalId, requestBody, occurredAt }) {
    const proposal = this.store.state.proposals?.[proposalId];
    if (!proposal) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse('NOT_FOUND', 'cycle proposal not found', { proposal_id: proposalId })
        }
      };
    }

    return this.commitSvc.accept({ actor, idempotencyKey, proposal, requestBody, occurredAt });
  }

  decline({ actor, idempotencyKey, proposalId, requestBody, occurredAt }) {
    const proposal = this.store.state.proposals?.[proposalId];
    if (!proposal) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse('NOT_FOUND', 'cycle proposal not found', { proposal_id: proposalId })
        }
      };
    }

    return this.commitSvc.decline({ actor, idempotencyKey, proposal, requestBody, occurredAt });
  }
}
