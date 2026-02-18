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

function exportCheckpointEnforced() {
  return process.env.POLICY_AUDIT_EXPORT_CHECKPOINT_ENFORCE === '1';
}

function ensureCheckpointState(store) {
  store.state.policy_audit_export_checkpoints ||= {};
  return store.state.policy_audit_export_checkpoints;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function checkpointContextFromQuery({ query, subjectActorId }) {
  return {
    subject_actor_id: subjectActorId,
    decision: normalizeOptionalString(query?.decision),
    operation_id: normalizeOptionalString(query?.operation_id),
    delegation_id: normalizeOptionalString(query?.delegation_id),
    from_iso: normalizeOptionalString(query?.from_iso),
    to_iso: normalizeOptionalString(query?.to_iso),
    limit: normalizeLimit(query?.limit)
  };
}

function checkpointContextKey(context) {
  return JSON.stringify(context);
}

function checkpointRetentionDays() {
  const raw = Number.parseInt(String(process.env.POLICY_AUDIT_EXPORT_CHECKPOINT_RETENTION_DAYS ?? ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return retentionDays();
  return Math.min(raw, 3650);
}

function checkpointRetentionWindowMs() {
  return checkpointRetentionDays() * 24 * 60 * 60 * 1000;
}

function isCheckpointExpired({ checkpointRecord, nowMs }) {
  if (!checkpointRecord || typeof checkpointRecord !== 'object') return true;
  const exportedAtMs = parseIsoMs(checkpointRecord.exported_at);
  if (exportedAtMs === null) return true;
  return nowMs > (exportedAtMs + checkpointRetentionWindowMs());
}

function pruneExpiredCheckpoints({ checkpointState, nowMs }) {
  if (!checkpointState || typeof checkpointState !== 'object') return;
  for (const [checkpointHash, checkpointRecord] of Object.entries(checkpointState)) {
    if (isCheckpointExpired({ checkpointRecord, nowMs })) {
      delete checkpointState[checkpointHash];
    }
  }
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

function paginateEntries({ entries, query, correlationId }) {
  let orderedEntries = entries;

  const cursorAfter = typeof query?.cursor_after === 'string' && query.cursor_after.trim()
    ? query.cursor_after.trim()
    : null;

  if (cursorAfter) {
    const idx = orderedEntries.findIndex(e => e?.audit_id === cursorAfter);
    if (idx < 0) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'cursor_after not found in filtered result set', {
          cursor_after: cursorAfter
        })
      };
    }
    orderedEntries = orderedEntries.slice(idx + 1);
  }

  const totalFiltered = orderedEntries.length;

  const limit = normalizeLimit(query?.limit);
  let nextCursor = null;

  if (limit && orderedEntries.length > limit) {
    const page = orderedEntries.slice(0, limit);
    nextCursor = page[page.length - 1]?.audit_id ?? null;
    orderedEntries = page;
  }

  return {
    ok: true,
    entries: orderedEntries,
    totalFiltered,
    nextCursor,
    cursorAfter,
    limit
  };
}

export class PolicyAuditReadService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureCheckpointState(this.store);
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

    const paged = paginateEntries({ entries: selected.entries, query, correlationId });
    if (!paged.ok) return paged;

    const body = {
      correlation_id: correlationId,
      entries: paged.entries,
      total_filtered: paged.totalFiltered
    };

    if (paged.nextCursor) body.next_cursor = paged.nextCursor;

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

    const selected = selectFilteredEntries({ store: this.store, subjectActorId: scoped.subjectActorId, query, correlationId });
    if (!selected.ok) return selected;

    const paged = paginateEntries({ entries: selected.entries, query, correlationId });
    if (!paged.ok) return paged;

    const attestationAfter = typeof query?.attestation_after === 'string' && query.attestation_after.trim()
      ? query.attestation_after.trim()
      : null;

    if (paged.cursorAfter && !attestationAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'attestation_after is required when cursor_after is provided', {
          cursor_after: paged.cursorAfter,
          attestation_after: query?.attestation_after ?? null
        })
      };
    }

    if (!paged.cursorAfter && attestationAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'attestation_after is only allowed with cursor_after', {
          cursor_after: query?.cursor_after ?? null,
          attestation_after: attestationAfter
        })
      };
    }

    const checkpointAfter = typeof query?.checkpoint_after === 'string' && query.checkpoint_after.trim()
      ? query.checkpoint_after.trim()
      : null;

    const checkpointRequired = exportCheckpointEnforced();
    const checkpointState = ensureCheckpointState(this.store);
    const checkpointContext = checkpointContextFromQuery({ query, subjectActorId: scoped.subjectActorId });
    const checkpointContextFingerprint = checkpointContextKey(checkpointContext);
    const checkpointNowIso = nowIsoForRetention(query);
    const checkpointNowMs = parseIsoMs(checkpointNowIso);

    if (checkpointRequired && checkpointNowMs === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid now_iso for checkpoint retention', {
          now_iso: checkpointNowIso
        })
      };
    }

    if (checkpointRequired && paged.cursorAfter && !checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is required when cursor_after is provided', {
          cursor_after: paged.cursorAfter,
          checkpoint_after: query?.checkpoint_after ?? null
        })
      };
    }

    if (checkpointRequired && !paged.cursorAfter && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is only allowed with cursor_after', {
          cursor_after: query?.cursor_after ?? null,
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (!checkpointRequired && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is not enabled for this export contract', {
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (checkpointRequired && paged.cursorAfter) {
      const priorCheckpoint = checkpointState[checkpointAfter] ?? null;

      if (!priorCheckpoint) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after not found for export continuation', {
            reason_code: 'checkpoint_after_not_found',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (isCheckpointExpired({ checkpointRecord: priorCheckpoint, nowMs: checkpointNowMs })) {
        delete checkpointState[checkpointAfter];
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after expired for export continuation', {
            reason_code: 'checkpoint_expired',
            checkpoint_after: checkpointAfter,
            exported_at: priorCheckpoint.exported_at ?? null,
            now_iso: checkpointNowIso,
            retention_days: checkpointRetentionDays()
          })
        };
      }

      if (priorCheckpoint.next_cursor !== paged.cursorAfter) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'cursor_after does not match checkpoint continuation cursor', {
            reason_code: 'checkpoint_cursor_mismatch',
            checkpoint_after: checkpointAfter,
            expected_cursor_after: priorCheckpoint.next_cursor ?? null,
            cursor_after: paged.cursorAfter
          })
        };
      }

      if (priorCheckpoint.attestation_chain_hash !== attestationAfter) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'attestation_after does not match checkpoint continuation chain', {
            reason_code: 'checkpoint_attestation_mismatch',
            checkpoint_after: checkpointAfter,
            expected_attestation_after: priorCheckpoint.attestation_chain_hash ?? null,
            attestation_after: attestationAfter
          })
        };
      }

      if (priorCheckpoint.query_context_fingerprint !== checkpointContextFingerprint) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'export continuation query does not match checkpoint context', {
            reason_code: 'checkpoint_query_mismatch',
            checkpoint_after: checkpointAfter,
            expected_context: priorCheckpoint.query_context ?? null,
            provided_context: checkpointContext
          })
        };
      }
    }

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

    const withAttestation = Boolean(paged.limit || paged.cursorAfter || attestationAfter);
    const withCheckpoint = checkpointRequired && withAttestation;

    const signedPayload = buildSignedPolicyAuditExportPayload({
      exportedAt,
      query,
      entries: paged.entries,
      totalFiltered: paged.totalFiltered,
      nextCursor: paged.nextCursor,
      withAttestation,
      withCheckpoint
    });

    if (checkpointRequired && signedPayload?.checkpoint?.checkpoint_hash) {
      checkpointState[signedPayload.checkpoint.checkpoint_hash] = {
        checkpoint_hash: signedPayload.checkpoint.checkpoint_hash,
        checkpoint_after: signedPayload.checkpoint.checkpoint_after ?? null,
        subject_actor_id: scoped.subjectActorId,
        next_cursor: signedPayload.checkpoint.next_cursor ?? null,
        attestation_chain_hash: signedPayload.attestation?.chain_hash ?? null,
        query_context_fingerprint: checkpointContextFingerprint,
        query_context: checkpointContext,
        exported_at: signedPayload.exported_at
      };

      pruneExpiredCheckpoints({ checkpointState, nowMs: checkpointNowMs });
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        ...signedPayload
      }
    };
  }
}
