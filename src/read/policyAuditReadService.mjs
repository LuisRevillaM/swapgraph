import { authorizeApiOperation } from '../core/authz.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';

function actorKey(actor) {
  return `${actor?.type}:${actor?.id}`;
}

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForPolicyAuditList() {
  return 'corr_policy_audit_delegated_writes';
}

function correlationIdForPolicyAuditExport() {
  return 'corr_policy_audit_delegated_writes_export';
}

function normalizeLimit(limit) {
  const n = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 200);
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function retentionDays() {
  const raw = Number.parseInt(String(process.env.POLICY_AUDIT_RETENTION_DAYS ?? '30'), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(raw, 3650);
}

function nowIsoForRetention(query) {
  return query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function exportNowIso(query) {
  return query?.exported_at_iso ?? query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function requireUserScope({ actor, query, correlationId }) {
  if (actor?.type !== 'user') {
    return {
      ok: false,
      body: errorResponse(correlationId, 'FORBIDDEN', 'only user can read delegated policy audit', { actor })
    };
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

  return { ok: true, subjectActorId };
}

function selectFilteredEntries({ store, subjectActorId, query, correlationId }) {
  const retentionNowIso = nowIsoForRetention(query);
  const retentionNowMs = parseIsoMs(retentionNowIso);
  if (retentionNowMs === null) {
    return {
      ok: false,
      body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid now_iso for policy audit retention', {
        now_iso: retentionNowIso
      })
    };
  }

  const cutoffMs = retentionNowMs - (retentionDays() * 24 * 60 * 60 * 1000);

  const fromMs = query?.from_iso ? parseIsoMs(query.from_iso) : null;
  if (query?.from_iso && fromMs === null) {
    return {
      ok: false,
      body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid from_iso filter', { from_iso: query.from_iso })
    };
  }

  const toMs = query?.to_iso ? parseIsoMs(query.to_iso) : null;
  if (query?.to_iso && toMs === null) {
    return {
      ok: false,
      body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid to_iso filter', { to_iso: query.to_iso })
    };
  }

  const subjectKey = actorKey({ type: 'user', id: subjectActorId });
  let entries = (store.state.policy_audit ?? [])
    .filter(e => actorKey(e?.subject_actor) === subjectKey)
    .map(e => ({ entry: e, ts: parseIsoMs(e?.occurred_at) }))
    .filter(x => x.ts !== null)
    .filter(x => x.ts >= cutoffMs);

  if (typeof query?.decision === 'string' && query.decision.trim()) {
    entries = entries.filter(x => x.entry?.decision === query.decision.trim());
  }

  if (typeof query?.operation_id === 'string' && query.operation_id.trim()) {
    entries = entries.filter(x => x.entry?.operation_id === query.operation_id.trim());
  }

  if (typeof query?.delegation_id === 'string' && query.delegation_id.trim()) {
    entries = entries.filter(x => x.entry?.delegation_id === query.delegation_id.trim());
  }

  if (fromMs !== null) entries = entries.filter(x => x.ts >= fromMs);
  if (toMs !== null) entries = entries.filter(x => x.ts <= toMs);

  entries.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return String(a.entry?.audit_id ?? '').localeCompare(String(b.entry?.audit_id ?? ''));
  });

  return {
    ok: true,
    entries: entries.map(x => x.entry)
  };
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

    const scoped = requireUserScope({ actor, query, correlationId });
    if (!scoped.ok) return scoped;

    const selected = selectFilteredEntries({ store: this.store, subjectActorId: scoped.subjectActorId, query, correlationId });
    if (!selected.ok) return selected;

    let orderedEntries = selected.entries;

    if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) {
      const cursor = query.cursor_after.trim();
      const idx = orderedEntries.findIndex(e => e?.audit_id === cursor);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'cursor_after not found in filtered result set', {
            cursor_after: cursor
          })
        };
      }
      orderedEntries = orderedEntries.slice(idx + 1);
    }

    const totalFiltered = orderedEntries.length;

    let nextCursor = null;
    const limit = normalizeLimit(query?.limit);
    if (limit && orderedEntries.length > limit) {
      const page = orderedEntries.slice(0, limit);
      nextCursor = page[page.length - 1]?.audit_id ?? null;
      orderedEntries = page;
    }

    const body = {
      correlation_id: correlationId,
      entries: orderedEntries,
      total_filtered: totalFiltered
    };

    if (nextCursor) body.next_cursor = nextCursor;

    return { ok: true, body };
  }

  exportDelegatedWrites({ actor, auth, query }) {
    const correlationId = correlationIdForPolicyAuditExport();

    const authz = authorizeApiOperation({ operationId: 'policyAudit.delegated_writes.export', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const scoped = requireUserScope({ actor, query, correlationId });
    if (!scoped.ok) return scoped;

    if (Object.prototype.hasOwnProperty.call(query ?? {}, 'limit') || Object.prototype.hasOwnProperty.call(query ?? {}, 'cursor_after')) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'export does not support pagination parameters', {
          limit: query?.limit ?? null,
          cursor_after: query?.cursor_after ?? null
        })
      };
    }

    const selected = selectFilteredEntries({ store: this.store, subjectActorId: scoped.subjectActorId, query, correlationId });
    if (!selected.ok) return selected;

    const exportedAt = exportNowIso(query);
    if (parseIsoMs(exportedAt) === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid exported_at_iso for policy audit export', {
          exported_at_iso: query?.exported_at_iso ?? null,
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const signedPayload = buildSignedPolicyAuditExportPayload({
      exportedAt,
      query,
      entries: selected.entries,
      totalFiltered: selected.entries.length
    });

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        ...signedPayload
      }
    };
  }
}
