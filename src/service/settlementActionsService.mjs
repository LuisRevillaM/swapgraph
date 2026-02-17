import { SettlementService } from '../settlement/settlementService.mjs';

function error(code, message, details = {}) {
  return { code, message, details };
}

function isPartner(actor) {
  return actor?.type === 'partner';
}

function cyclePartnerId({ store, cycleId }) {
  return store?.state?.tenancy?.cycles?.[cycleId]?.partner_id ?? null;
}

export class SettlementActionsService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    this.settlementSvc = new SettlementService({ store });
  }

  confirmDeposit({ actor, cycleId, depositRef, occurredAt }) {
    if (actor?.type !== 'user') {
      return { ok: false, error: error('FORBIDDEN', 'only user can confirm deposit', { actor, cycle_id: cycleId }) };
    }

    return this.settlementSvc.confirmDeposit({ actor, cycleId, depositRef, occurredAt });
  }

  beginExecution({ actor, cycleId, occurredAt }) {
    if (!isPartner(actor)) {
      return { ok: false, error: error('FORBIDDEN', 'only partner can begin execution', { actor, cycle_id: cycleId }) };
    }

    const pid = cyclePartnerId({ store: this.store, cycleId });
    if (!pid) {
      return { ok: false, error: error('FORBIDDEN', 'cycle is not scoped to a partner', { actor, cycle_id: cycleId, cycle_partner_id: null }) };
    }
    if (pid !== actor.id) {
      return { ok: false, error: error('FORBIDDEN', 'partner cannot access this cycle', { actor, cycle_id: cycleId, cycle_partner_id: pid }) };
    }

    return this.settlementSvc.beginExecution({ actor, cycleId, occurredAt });
  }

  complete({ actor, cycleId, occurredAt }) {
    if (!isPartner(actor)) {
      return { ok: false, error: error('FORBIDDEN', 'only partner can complete settlement', { actor, cycle_id: cycleId }) };
    }

    const pid = cyclePartnerId({ store: this.store, cycleId });
    if (!pid) {
      return { ok: false, error: error('FORBIDDEN', 'cycle is not scoped to a partner', { actor, cycle_id: cycleId, cycle_partner_id: null }) };
    }
    if (pid !== actor.id) {
      return { ok: false, error: error('FORBIDDEN', 'partner cannot access this cycle', { actor, cycle_id: cycleId, cycle_partner_id: pid }) };
    }

    return this.settlementSvc.complete({ actor, cycleId, occurredAt });
  }
}
