import { authorizeApiOperation } from '../core/authz.mjs';

function actorKey(actor) {
  return `${actor?.type}:${actor?.id}`;
}

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForPolicyAuditList() {
  return 'corr_policy_audit_delegated_writes';
}

function normalizeLimit(limit) {
  const n = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 500);
}

export class PolicyAuditReadService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
  }

  list({ actor, auth, query }) {
    const correlationId = correlationIdForPolicyAuditList();

    const authz = authorizeApiOperation({ operationId: 'policyAudit.delegated_writes.list', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    if (actor?.type !== 'user') {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'only user can read delegated policy audit', { actor }) };
    }

    const subjectActorId = query?.subject_actor_id ?? actor.id;
    if (subjectActorId !== actor.id) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'FORBIDDEN', 'cannot read delegated policy audit for a different user', {
          actor,
          requested_subject_actor_id: subjectActorId
        })
      };
    }

    const subjectKey = actorKey({ type: 'user', id: subjectActorId });
    let entries = (this.store.state.policy_audit ?? []).filter(e => actorKey(e?.subject_actor) === subjectKey);

    if (typeof query?.decision === 'string' && query.decision.trim()) {
      entries = entries.filter(e => e?.decision === query.decision.trim());
    }

    if (typeof query?.operation_id === 'string' && query.operation_id.trim()) {
      entries = entries.filter(e => e?.operation_id === query.operation_id.trim());
    }

    if (typeof query?.delegation_id === 'string' && query.delegation_id.trim()) {
      entries = entries.filter(e => e?.delegation_id === query.delegation_id.trim());
    }

    entries = entries
      .slice()
      .sort((a, b) => {
        const ta = Date.parse(a?.occurred_at ?? '');
        const tb = Date.parse(b?.occurred_at ?? '');
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
        return String(a?.audit_id ?? '').localeCompare(String(b?.audit_id ?? ''));
      });

    const limit = normalizeLimit(query?.limit);
    if (limit) entries = entries.slice(0, limit);

    return { ok: true, body: { correlation_id: correlationId, entries } };
  }
}
