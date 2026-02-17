import { SettlementStartService } from './settlementStartService.mjs';
import { SettlementActionsService } from './settlementActionsService.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForCycleId(cycleId) {
  return `corr_${cycleId}`;
}

export class SettlementWriteApiService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;

    this.startSvc = new SettlementStartService({ store });
    this.actionsSvc = new SettlementActionsService({ store });
  }

  start({ actor, cycleId, requestBody, occurredAt }) {
    const depositDeadlineAt = requestBody?.deposit_deadline_at;
    const r = this.startSvc.start({ actor, cycleId, occurredAt, depositDeadlineAt });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationIdForCycleId(cycleId), r.error.code, r.error.message, r.error.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationIdForCycleId(cycleId),
        timeline: r.timeline
      }
    };
  }

  depositConfirmed({ actor, cycleId, requestBody, occurredAt }) {
    const depositRef = requestBody?.deposit_ref;
    const r = this.actionsSvc.confirmDeposit({ actor, cycleId, depositRef, occurredAt });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationIdForCycleId(cycleId), r.error.code, r.error.message, r.error.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationIdForCycleId(cycleId),
        timeline: r.timeline
      }
    };
  }

  beginExecution({ actor, cycleId, requestBody, occurredAt }) {
    // requestBody is intentionally empty in v1.
    void requestBody;

    const r = this.actionsSvc.beginExecution({ actor, cycleId, occurredAt });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationIdForCycleId(cycleId), r.error.code, r.error.message, r.error.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationIdForCycleId(cycleId),
        timeline: r.timeline
      }
    };
  }

  complete({ actor, cycleId, requestBody, occurredAt }) {
    // requestBody is intentionally empty in v1.
    void requestBody;

    const r = this.actionsSvc.complete({ actor, cycleId, occurredAt });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationIdForCycleId(cycleId), r.error.code, r.error.message, r.error.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationIdForCycleId(cycleId),
        timeline: r.timeline,
        receipt: r.receipt
      }
    };
  }

  expireDepositWindow({ actor, cycleId, requestBody }) {
    const nowIso = requestBody?.now_iso;
    const r = this.actionsSvc.expireDepositWindow({ actor, cycleId, nowIso });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationIdForCycleId(cycleId), r.error.code, r.error.message, r.error.details)
      };
    }

    if (r.no_op) {
      return {
        ok: true,
        body: {
          correlation_id: correlationIdForCycleId(cycleId),
          no_op: true,
          details: r.details ?? { cycle_id: cycleId }
        }
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationIdForCycleId(cycleId),
        timeline: r.timeline,
        receipt: r.receipt
      }
    };
  }
}
