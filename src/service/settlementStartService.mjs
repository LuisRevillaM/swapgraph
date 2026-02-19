import { commitIdForProposalId } from '../commit/commitIds.mjs';
import { SettlementService } from '../settlement/settlementService.mjs';

function error(code, message, details = {}) {
  return { code, message, details };
}

function isPartner(actor) {
  return actor?.type === 'partner';
}

function proposalPartnerId({ store, cycleId }) {
  return store?.state?.tenancy?.proposals?.[cycleId]?.partner_id ?? null;
}

export class SettlementStartService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    this.settlementSvc = new SettlementService({ store });
  }

  /**
   * Start settlement for a cycle.
   *
   * @param {{ actor:any, cycleId:string, occurredAt:string, depositDeadlineAt:string, vaultBindings?:Array<object> }} params
   */
  start({ actor, cycleId, occurredAt, depositDeadlineAt, vaultBindings }) {
    if (!cycleId) throw new Error('cycleId is required');

    if (!isPartner(actor)) {
      return { ok: false, error: error('FORBIDDEN', 'only partner can start settlement', { actor, cycle_id: cycleId }) };
    }

    const proposal = this.store.state.proposals?.[cycleId];
    if (!proposal) {
      return { ok: false, error: error('NOT_FOUND', 'cycle proposal not found', { cycle_id: cycleId }) };
    }

    const pid = proposalPartnerId({ store: this.store, cycleId });
    if (!pid) {
      return {
        ok: false,
        error: error('FORBIDDEN', 'proposal is not scoped to a partner', { actor, cycle_id: cycleId, proposal_partner_id: null })
      };
    }
    if (pid !== actor.id) {
      return {
        ok: false,
        error: error('FORBIDDEN', 'partner cannot access this proposal', { actor, cycle_id: cycleId, proposal_partner_id: pid })
      };
    }

    // Optional: provide clearer error details before delegating.
    const commitId = commitIdForProposalId(cycleId);
    const commit = this.store.state.commits?.[commitId];
    if (!commit) {
      return { ok: false, error: error('NOT_FOUND', 'commit not found', { cycle_id: cycleId, commit_id: commitId }) };
    }

    // Delegate the actual timeline creation + cycle tenancy enforcement.
    const r = this.settlementSvc.start({ actor, proposal, occurredAt, depositDeadlineAt, vaultBindings });
    if (!r.ok) {
      // Normalize to {ok:false,error:{code,message,details}}.
      return { ok: false, error: r.error };
    }

    return r;
  }
}
