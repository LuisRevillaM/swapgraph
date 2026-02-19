import { SettlementStartService } from './settlementStartService.mjs';
import { SettlementActionsService } from './settlementActionsService.mjs';
import { authorizeApiOperation } from '../core/authz.mjs';

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

  start({ actor, auth, cycleId, requestBody, occurredAt }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const authz = authorizeApiOperation({ operationId: 'settlement.start', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const depositDeadlineAt = requestBody?.deposit_deadline_at;
    const vaultBindings = requestBody?.vault_bindings;
    const r = this.startSvc.start({ actor, cycleId, occurredAt, depositDeadlineAt, vaultBindings });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, r.error.code, r.error.message, r.error.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        timeline: r.timeline
      }
    };
  }

  depositConfirmed({ actor, auth, cycleId, requestBody, occurredAt }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const authz = authorizeApiOperation({ operationId: 'settlement.deposit_confirmed', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const depositRef = requestBody?.deposit_ref;
    const r = this.actionsSvc.confirmDeposit({ actor, cycleId, depositRef, occurredAt });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, r.error.code, r.error.message, r.error.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        timeline: r.timeline
      }
    };
  }

  beginExecution({ actor, auth, cycleId, requestBody, occurredAt }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const authz = authorizeApiOperation({ operationId: 'settlement.begin_execution', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    // requestBody is intentionally empty in v1.
    void requestBody;

    const r = this.actionsSvc.beginExecution({ actor, cycleId, occurredAt });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, r.error.code, r.error.message, r.error.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        timeline: r.timeline
      }
    };
  }

  complete({ actor, auth, cycleId, requestBody, occurredAt }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const authz = authorizeApiOperation({ operationId: 'settlement.complete', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    // requestBody is intentionally empty in v1.
    void requestBody;

    const r = this.actionsSvc.complete({ actor, cycleId, occurredAt });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, r.error.code, r.error.message, r.error.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        timeline: r.timeline,
        receipt: r.receipt
      }
    };
  }

  expireDepositWindow({ actor, auth, cycleId, requestBody }) {
    const correlationId = correlationIdForCycleId(cycleId);

    const authz = authorizeApiOperation({ operationId: 'settlement.expire_deposit_window', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const nowIso = requestBody?.now_iso;
    const r = this.actionsSvc.expireDepositWindow({ actor, cycleId, nowIso });

    if (!r.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, r.error.code, r.error.message, r.error.details)
      };
    }

    if (r.no_op) {
      return {
        ok: true,
        body: {
          correlation_id: correlationId,
          no_op: true,
          details: r.details ?? { cycle_id: cycleId }
        }
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        timeline: r.timeline,
        receipt: r.receipt
      }
    };
  }
}
