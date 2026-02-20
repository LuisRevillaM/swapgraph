import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { buildSignedTransparencyLogPublicationExportPayload } from '../crypto/policyIntegritySigning.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return {
    correlation_id: correlationId,
    error: {
      code,
      message,
      details
    }
  };
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePositiveInt(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function normalizeStringSet(values) {
  if (!Array.isArray(values)) return [];
  const out = values
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim());
  return Array.from(new Set(out)).sort();
}

function normalizeHexHash(value) {
  const str = normalizeOptionalString(value);
  if (!str) return null;
  return /^[a-f0-9]{64}$/.test(str) ? str : null;
}

function normalizeLimit(value) {
  const parsed = parsePositiveInt(value, { min: 1, max: 200 });
  return parsed ?? null;
}

const allowedSourceTypes = new Set([
  'settlement_receipts',
  'governance_rollout',
  'partner_disputes',
  'combined'
]);

function normalizeSourceType(value) {
  const out = normalizeOptionalString(value);
  if (!out || !allowedSourceTypes.has(out)) return null;
  return out;
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function ensureTransparencyState(store) {
  store.state.transparency_log_publications ||= [];
  store.state.transparency_log_export_checkpoints ||= {};
  store.state.transparency_log_publication_counter ||= 0;
  store.state.idempotency ||= {};

  return {
    publications: store.state.transparency_log_publications,
    exportCheckpoints: store.state.transparency_log_export_checkpoints,
    publicationCounter: store.state.transparency_log_publication_counter,
    idempotency: store.state.idempotency
  };
}

function nextPublicationCounter(state) {
  const next = Number.parseInt(String(state.publicationCounter ?? 0), 10) + 1;
  state.publicationCounter = next;
  return next;
}

function checkpointRetentionDays() {
  const raw = Number.parseInt(String(process.env.TRANSPARENCY_LOG_EXPORT_CHECKPOINT_RETENTION_DAYS ?? ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(raw, 3650);
}

function checkpointRetentionWindowMs() {
  return checkpointRetentionDays() * 24 * 60 * 60 * 1000;
}

function exportCheckpointEnforced() {
  return process.env.TRANSPARENCY_LOG_EXPORT_CHECKPOINT_ENFORCE === '1';
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

function checkpointContextFromQuery({ query, sourceType }) {
  return {
    source_type: sourceType,
    from_iso: normalizeOptionalString(query?.from_iso),
    to_iso: normalizeOptionalString(query?.to_iso),
    limit: normalizeLimit(query?.limit)
  };
}

function checkpointContextKey(context) {
  return JSON.stringify(context);
}

function normalizePublicationRecord(record) {
  return {
    publication_id: record.publication_id,
    publication_index: Number(record.publication_index ?? 0),
    partner_id: record.partner_id,
    source_type: record.source_type,
    source_ref: record.source_ref,
    root_hash: record.root_hash,
    previous_root_hash: record.previous_root_hash ?? null,
    previous_chain_hash: record.previous_chain_hash ?? null,
    chain_hash: record.chain_hash,
    entry_count: Number(record.entry_count ?? 0),
    artifact_refs: normalizeStringSet(record.artifact_refs),
    linked_receipt_ids: normalizeStringSet(record.linked_receipt_ids),
    linked_governance_artifact_ids: normalizeStringSet(record.linked_governance_artifact_ids),
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {}),
    integration_mode: 'fixture_only',
    published_at: record.published_at
  };
}

function normalizePublicationRequest(request) {
  const publication = request?.publication;
  if (!publication || typeof publication !== 'object' || Array.isArray(publication)) return null;

  const sourceType = normalizeSourceType(publication.source_type);
  const sourceRef = normalizeOptionalString(publication.source_ref);
  const rootHash = normalizeHexHash(publication.root_hash);
  const previousRootHashRaw = publication.previous_root_hash;
  const previousRootHash = typeof previousRootHashRaw === 'undefined'
    ? null
    : normalizeHexHash(previousRootHashRaw);
  const entryCount = parsePositiveInt(publication.entry_count, { min: 1, max: 1000000 });
  const artifactRefs = normalizeStringSet(publication.artifact_refs);
  const linkedReceiptIds = normalizeStringSet(publication.linked_receipt_ids);
  const linkedGovernanceArtifactIds = normalizeStringSet(publication.linked_governance_artifact_ids);
  const notes = normalizeOptionalString(publication.notes);

  if (!sourceType
    || !sourceRef
    || !rootHash
    || entryCount === null
    || artifactRefs.length === 0
    || (linkedReceiptIds.length === 0 && linkedGovernanceArtifactIds.length === 0)
    || (typeof previousRootHashRaw !== 'undefined' && !previousRootHash)) {
    return null;
  }

  return {
    source_type: sourceType,
    source_ref: sourceRef,
    root_hash: rootHash,
    previous_root_hash: previousRootHash,
    entry_count: entryCount,
    artifact_refs: artifactRefs,
    linked_receipt_ids: linkedReceiptIds,
    linked_governance_artifact_ids: linkedGovernanceArtifactIds,
    ...(notes ? { notes } : {})
  };
}

function applyIdempotentMutation({ store, actor, operationId, idempotencyKey, requestPayload, mutate, correlationId }) {
  const key = normalizeOptionalString(idempotencyKey);
  if (!key) {
    return {
      ok: false,
      body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'idempotency key is required', {
        operation_id: operationId
      })
    };
  }

  const idemState = ensureTransparencyState(store).idempotency;
  const scopeKey = `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}|${operationId}|${key}`;
  const incomingHash = payloadHash(requestPayload);
  const prior = idemState[scopeKey] ?? null;

  if (prior) {
    if (prior.payload_hash !== incomingHash) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reuse with different payload', {
          operation_id: operationId,
          idempotency_key: key
        })
      };
    }

    return {
      ok: true,
      body: {
        ...prior.result,
        replayed: true
      }
    };
  }

  const mutated = mutate();
  if (!mutated.ok) return mutated;

  idemState[scopeKey] = {
    payload_hash: incomingHash,
    result: mutated.body
  };

  return {
    ok: true,
    body: {
      ...mutated.body,
      replayed: false
    }
  };
}

function publicationChainHash(input) {
  return createHash('sha256').update(canonicalStringify(input), 'utf8').digest('hex');
}

function exportQueryForSigning({ query, sourceType, limit, cursorAfter, attestationAfter, checkpointAfter }) {
  const out = {};
  if (sourceType) out.source_type = sourceType;
  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();
  if (limit) out.limit = limit;
  if (cursorAfter) out.cursor_after = cursorAfter;
  if (attestationAfter) out.attestation_after = attestationAfter;
  if (checkpointAfter) out.checkpoint_after = checkpointAfter;
  return out;
}

function normalizeSourceTypeFilter(raw) {
  const sourceType = normalizeOptionalString(raw);
  if (!sourceType) return { ok: true, sourceType: null };
  if (!allowedSourceTypes.has(sourceType)) return { ok: false, sourceType: null };
  return { ok: true, sourceType };
}

export class TransparencyLogService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureTransparencyState(this.store);
  }

  recordPublication({ actor, auth, idempotencyKey, request }) {
    const op = 'transparencyLog.publication.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record transparency publication', { actor })
      };
    }

    const normalized = normalizePublicationRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid transparency publication payload', {
          reason_code: 'transparency_log_publication_invalid'
        })
      };
    }

    const publishedAtRaw = normalizeOptionalString(request?.published_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const publishedAtMs = parseIsoMs(publishedAtRaw);
    if (publishedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid transparency publication timestamp', {
          reason_code: 'transparency_log_publication_invalid_timestamp'
        })
      };
    }

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      mutate: () => {
        const state = ensureTransparencyState(this.store);
        const partnerPublications = state.publications
          .filter(x => x?.partner_id === actor.id)
          .sort((a, b) => Number(a.publication_index ?? 0) - Number(b.publication_index ?? 0));

        const previous = partnerPublications[partnerPublications.length - 1] ?? null;
        const expectedPreviousRoot = previous?.root_hash ?? null;
        const providedPreviousRoot = normalized.previous_root_hash ?? null;

        if (expectedPreviousRoot !== providedPreviousRoot) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'transparency publication root chain mismatch', {
              reason_code: 'transparency_log_previous_root_mismatch',
              expected_previous_root_hash: expectedPreviousRoot,
              provided_previous_root_hash: providedPreviousRoot
            })
          };
        }

        const publicationIndex = nextPublicationCounter(state);
        this.store.state.transparency_log_publication_counter = publicationIndex;

        const publicationId = `transparency_pub_${String(publicationIndex).padStart(6, '0')}`;
        const previousChainHash = previous?.chain_hash ?? null;

        const chainHash = publicationChainHash({
          publication_id: publicationId,
          publication_index: publicationIndex,
          partner_id: actor.id,
          source_type: normalized.source_type,
          source_ref: normalized.source_ref,
          root_hash: normalized.root_hash,
          previous_root_hash: expectedPreviousRoot,
          previous_chain_hash: previousChainHash,
          entry_count: normalized.entry_count,
          artifact_refs: normalized.artifact_refs,
          linked_receipt_ids: normalized.linked_receipt_ids,
          linked_governance_artifact_ids: normalized.linked_governance_artifact_ids,
          published_at: new Date(publishedAtMs).toISOString()
        });

        const record = {
          publication_id: publicationId,
          publication_index: publicationIndex,
          partner_id: actor.id,
          source_type: normalized.source_type,
          source_ref: normalized.source_ref,
          root_hash: normalized.root_hash,
          previous_root_hash: expectedPreviousRoot,
          previous_chain_hash: previousChainHash,
          chain_hash: chainHash,
          entry_count: normalized.entry_count,
          artifact_refs: normalized.artifact_refs,
          linked_receipt_ids: normalized.linked_receipt_ids,
          linked_governance_artifact_ids: normalized.linked_governance_artifact_ids,
          ...(normalized.notes ? { notes: normalized.notes } : {}),
          integration_mode: 'fixture_only',
          published_at: new Date(publishedAtMs).toISOString()
        };

        state.publications.push(record);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            publication: normalizePublicationRecord(record)
          }
        };
      }
    });
  }

  exportPublications({ actor, auth, query }) {
    const op = 'transparencyLog.publication.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export transparency publications', { actor })
      };
    }

    const sourceTypeFilter = normalizeSourceTypeFilter(query?.source_type);
    if (!sourceTypeFilter.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid transparency export query', {
          reason_code: 'transparency_log_export_query_invalid',
          source_type: query?.source_type ?? null
        })
      };
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;

    if ((fromIso && fromMs === null) || (toIso && toMs === null) || (fromMs !== null && toMs !== null && fromMs > toMs)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid transparency export query', {
          reason_code: 'transparency_log_export_query_invalid',
          from_iso: fromIso,
          to_iso: toIso
        })
      };
    }

    const state = ensureTransparencyState(this.store);
    let allFiltered = state.publications
      .filter(x => x?.partner_id === actor.id)
      .filter(x => !sourceTypeFilter.sourceType || x?.source_type === sourceTypeFilter.sourceType)
      .map(x => ({ entry: x, ts: parseIsoMs(x?.published_at) }))
      .filter(x => x.ts !== null)
      .filter(x => fromMs === null || x.ts >= fromMs)
      .filter(x => toMs === null || x.ts <= toMs)
      .map(x => x.entry);

    allFiltered.sort((a, b) => {
      const aTs = parseIsoMs(a?.published_at) ?? 0;
      const bTs = parseIsoMs(b?.published_at) ?? 0;
      if (aTs !== bTs) return aTs - bTs;
      return String(a?.publication_id ?? '').localeCompare(String(b?.publication_id ?? ''));
    });

    const summaryTotalPublications = allFiltered.length;
    const summaryTotalEntries = allFiltered.reduce((sum, x) => sum + (Number.isFinite(x?.entry_count) ? Number(x.entry_count) : 0), 0);
    const summaryChainHead = summaryTotalPublications > 0 ? (allFiltered[summaryTotalPublications - 1]?.chain_hash ?? null) : null;
    const summaryChainTail = summaryTotalPublications > 0 ? (allFiltered[0]?.chain_hash ?? null) : null;

    let filtered = allFiltered;

    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    if (cursorAfter) {
      const idx = filtered.findIndex(x => x?.publication_id === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found in transparency export set', {
            reason_code: 'transparency_log_export_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      filtered = filtered.slice(idx + 1);
    }

    const totalFiltered = filtered.length;

    const limit = normalizeLimit(query?.limit);
    let nextCursor = null;

    if (limit && filtered.length > limit) {
      const page = filtered.slice(0, limit);
      nextCursor = page[page.length - 1]?.publication_id ?? null;
      filtered = page;
    }

    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    if (cursorAfter && !attestationAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'attestation_after is required when cursor_after is provided', {
          cursor_after: cursorAfter,
          attestation_after: query?.attestation_after ?? null
        })
      };
    }

    if (!cursorAfter && attestationAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'attestation_after is only allowed with cursor_after', {
          cursor_after: query?.cursor_after ?? null,
          attestation_after: attestationAfter
        })
      };
    }

    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
    const checkpointRequired = exportCheckpointEnforced();
    const checkpointState = state.exportCheckpoints;
    const checkpointContext = checkpointContextFromQuery({ query, sourceType: sourceTypeFilter.sourceType });
    const checkpointContextFingerprint = checkpointContextKey(checkpointContext);
    const checkpointNowIso = query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    const checkpointNowMs = parseIsoMs(checkpointNowIso);

    if (checkpointRequired && checkpointNowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid now_iso for transparency checkpoint retention', {
          now_iso: checkpointNowIso
        })
      };
    }

    if (checkpointRequired && cursorAfter && !checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after is required when cursor_after is provided', {
          cursor_after: cursorAfter,
          checkpoint_after: query?.checkpoint_after ?? null
        })
      };
    }

    if (checkpointRequired && !cursorAfter && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after is only allowed with cursor_after', {
          cursor_after: query?.cursor_after ?? null,
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (!checkpointRequired && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after is not enabled for this export contract', {
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (checkpointRequired && cursorAfter) {
      const priorCheckpoint = checkpointState[checkpointAfter] ?? null;
      if (!priorCheckpoint) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after not found for transparency export continuation', {
            reason_code: 'checkpoint_after_not_found',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (isCheckpointExpired({ checkpointRecord: priorCheckpoint, nowMs: checkpointNowMs })) {
        delete checkpointState[checkpointAfter];
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after expired for transparency export continuation', {
            reason_code: 'checkpoint_expired',
            checkpoint_after: checkpointAfter,
            exported_at: priorCheckpoint.exported_at ?? null,
            now_iso: checkpointNowIso,
            retention_days: checkpointRetentionDays()
          })
        };
      }

      if (priorCheckpoint.next_cursor !== cursorAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after does not match checkpoint continuation cursor', {
            reason_code: 'checkpoint_cursor_mismatch',
            checkpoint_after: checkpointAfter,
            expected_cursor_after: priorCheckpoint.next_cursor ?? null,
            cursor_after: cursorAfter
          })
        };
      }

      if (priorCheckpoint.attestation_chain_hash !== attestationAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'attestation_after does not match checkpoint continuation chain', {
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
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'transparency export continuation query does not match checkpoint context', {
            reason_code: 'checkpoint_query_mismatch',
            checkpoint_after: checkpointAfter,
            expected_context: priorCheckpoint.query_context ?? null,
            provided_context: checkpointContext
          })
        };
      }
    }

    const exportedAt = query?.exported_at_iso ?? query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    if (parseIsoMs(exportedAt) === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid exported_at timestamp for transparency export', {
          reason_code: 'transparency_log_export_invalid_timestamp',
          exported_at_iso: query?.exported_at_iso ?? null,
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const normalizedPage = filtered.map(normalizePublicationRecord);

    const summary = {
      total_publications: summaryTotalPublications,
      returned_count: normalizedPage.length,
      total_entries: summaryTotalEntries,
      chain_head: summaryChainHead,
      chain_tail: summaryChainTail
    };

    const signingQuery = exportQueryForSigning({
      query,
      sourceType: sourceTypeFilter.sourceType,
      limit,
      cursorAfter,
      attestationAfter,
      checkpointAfter
    });

    const withAttestation = Boolean(limit || cursorAfter || attestationAfter);
    const withCheckpoint = checkpointRequired && withAttestation;

    const signedPayload = buildSignedTransparencyLogPublicationExportPayload({
      exportedAt,
      query: signingQuery,
      summary,
      publications: normalizedPage,
      totalFiltered,
      nextCursor: withAttestation ? nextCursor : undefined,
      withAttestation,
      withCheckpoint
    });

    if (checkpointRequired && signedPayload?.checkpoint?.checkpoint_hash) {
      checkpointState[signedPayload.checkpoint.checkpoint_hash] = {
        checkpoint_hash: signedPayload.checkpoint.checkpoint_hash,
        checkpoint_after: signedPayload.checkpoint.checkpoint_after ?? null,
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
        correlation_id: corr,
        ...signedPayload
      }
    };
  }
}
