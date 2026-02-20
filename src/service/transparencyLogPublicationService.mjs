import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import {
  signPolicyIntegrityPayload,
  verifyPolicyIntegrityPayloadSignature,
  verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem
} from '../crypto/policyIntegritySigning.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';

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

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeLimit(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function ensureTransparencyState(store) {
  store.state.transparency_log_publications ||= [];
  store.state.transparency_log_export_checkpoints ||= {};
  store.state.transparency_log_publication_counter ||= 0;
  store.state.transparency_log_entry_counter ||= 0;
  store.state.idempotency ||= {};

  return {
    publications: store.state.transparency_log_publications,
    checkpoints: store.state.transparency_log_export_checkpoints,
    idempotency: store.state.idempotency
  };
}

function payloadHash(payload) {
  return sha256HexCanonical(payload);
}

function normalizeEntryType(value) {
  const v = normalizeOptionalString(value);
  if (!v) return null;
  return ['receipt', 'governance_artifact'].includes(v) ? v : null;
}

function normalizeEntityHash(value) {
  const v = normalizeOptionalString(value);
  if (!v) return null;
  const lower = v.toLowerCase();
  return /^[a-f0-9]{64}$/.test(lower) ? lower : null;
}

function normalizePublicationEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const entryType = normalizeEntryType(value.entry_type);
  const entityId = normalizeOptionalString(value.entity_id);
  const entityHash = normalizeEntityHash(value.entity_hash);
  const cycleId = normalizeOptionalString(value.cycle_id);

  if (!entryType || !entityId || !entityHash) return null;

  return {
    entry_type: entryType,
    entity_id: entityId,
    entity_hash: entityHash,
    ...(cycleId ? { cycle_id: cycleId } : {})
  };
}

function normalizeExportQuery(query, { partnerId }) {
  const out = {
    partner_id: partnerId
  };

  const nowIso = normalizeOptionalString(query?.now_iso);
  if (nowIso) out.now_iso = nowIso;

  const exportedAtIso = normalizeOptionalString(query?.exported_at_iso);
  if (exportedAtIso) out.exported_at_iso = exportedAtIso;

  const limit = normalizeLimit(query?.limit);
  if (limit) out.limit = limit;

  const cursorAfter = normalizeOptionalString(query?.cursor_after);
  if (cursorAfter) out.cursor_after = cursorAfter;

  const attestationAfter = normalizeOptionalString(query?.attestation_after);
  if (attestationAfter) out.attestation_after = attestationAfter;

  const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
  if (checkpointAfter) out.checkpoint_after = checkpointAfter;

  return out;
}

function normalizeExportAttestation(attestation) {
  if (!attestation || typeof attestation !== 'object') return null;

  const pageHash = normalizeEntityHash(attestation.page_hash);
  const chainHash = normalizeEntityHash(attestation.chain_hash);

  if (!pageHash || !chainHash) return null;

  return {
    cursor_after: normalizeOptionalString(attestation.cursor_after),
    next_cursor: normalizeOptionalString(attestation.next_cursor),
    attestation_after: normalizeOptionalString(attestation.attestation_after),
    page_hash: pageHash,
    chain_hash: chainHash
  };
}

function normalizeExportCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;

  const checkpointHash = normalizeEntityHash(checkpoint.checkpoint_hash);
  if (!checkpointHash) return null;

  return {
    checkpoint_after: normalizeEntityHash(checkpoint.checkpoint_after),
    attestation_chain_hash: normalizeEntityHash(checkpoint.attestation_chain_hash),
    next_cursor: normalizeOptionalString(checkpoint.next_cursor),
    entries_count: Number.isFinite(checkpoint.entries_count) ? Number(checkpoint.entries_count) : 0,
    total_filtered: Number.isFinite(checkpoint.total_filtered) ? Number(checkpoint.total_filtered) : 0,
    checkpoint_hash: checkpointHash
  };
}

function buildExportHash({ summary, entries, totalFiltered, query, nextCursor }) {
  const input = {
    summary: summary ?? {},
    entries: entries ?? [],
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    query: query ?? {}
  };

  if (typeof nextCursor === 'string' && nextCursor.trim()) input.next_cursor = nextCursor.trim();

  return sha256HexCanonical(input);
}

function buildExportAttestation({ query, nextCursor, exportHash }) {
  const attestationInput = {
    cursor_after: normalizeOptionalString(query?.cursor_after),
    next_cursor: normalizeOptionalString(nextCursor),
    attestation_after: normalizeOptionalString(query?.attestation_after),
    page_hash: exportHash
  };

  return {
    ...attestationInput,
    chain_hash: sha256HexCanonical(attestationInput)
  };
}

function buildExportCheckpoint({ query, attestation, nextCursor, entriesCount, totalFiltered }) {
  const checkpointInput = {
    checkpoint_after: normalizeEntityHash(query?.checkpoint_after),
    attestation_chain_hash: normalizeEntityHash(attestation?.chain_hash),
    next_cursor: normalizeOptionalString(nextCursor),
    entries_count: Number.isFinite(entriesCount) ? Number(entriesCount) : 0,
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0
  };

  return {
    ...checkpointInput,
    checkpoint_hash: sha256HexCanonical(checkpointInput)
  };
}

function checkpointRetentionDays() {
  const raw = Number.parseInt(String(process.env.TRANSPARENCY_LOG_EXPORT_CHECKPOINT_RETENTION_DAYS ?? ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(raw, 3650);
}

function checkpointRetentionWindowMs() {
  return checkpointRetentionDays() * 24 * 60 * 60 * 1000;
}

function nowIsoForCheckpointRetention(query) {
  return query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
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

function exportCheckpointEnforced() {
  return process.env.TRANSPARENCY_LOG_EXPORT_CHECKPOINT_ENFORCE === '1';
}

function checkpointContextFromQuery({ query, partnerId }) {
  return {
    partner_id: partnerId,
    limit: normalizeLimit(query?.limit)
  };
}

function checkpointContextKey(context) {
  return JSON.stringify(context);
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

function exportedAtIso(query) {
  return query?.exported_at_iso ?? query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function paginateEntries({ entries, query, correlationId }) {
  let ordered = entries;
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  if (cursorAfter) {
    const idx = ordered.findIndex(e => e?.entry_id === cursorAfter);
    if (idx < 0) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'cursor_after not found in transparency log entries', {
          reason_code: 'transparency_log_cursor_not_found',
          cursor_after: cursorAfter
        })
      };
    }
    ordered = ordered.slice(idx + 1);
  }

  const totalFiltered = ordered.length;
  const limit = normalizeLimit(query?.limit);
  let nextCursor = null;

  if (limit && ordered.length > limit) {
    const page = ordered.slice(0, limit);
    nextCursor = page[page.length - 1]?.entry_id ?? null;
    ordered = page;
  }

  return {
    ok: true,
    entries: ordered,
    totalFiltered,
    nextCursor,
    cursorAfter,
    limit
  };
}

function buildSummary(entries, pageEntries) {
  const ordered = Array.isArray(entries) ? entries : [];
  const first = ordered[0] ?? null;
  const last = ordered[ordered.length - 1] ?? null;

  return {
    total_entries: ordered.length,
    page_entries: Array.isArray(pageEntries) ? pageEntries.length : 0,
    first_entry_id: first?.entry_id ?? null,
    last_entry_id: last?.entry_id ?? null,
    latest_chain_hash: last?.chain_hash ?? null
  };
}

function normalizeExportPayload(payload) {
  const summary = payload?.summary ?? {};
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const totalFiltered = Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0;
  const query = payload?.query ?? {};
  const nextCursor = normalizeOptionalString(payload?.next_cursor);

  const out = {
    exported_at: payload?.exported_at,
    query,
    summary,
    entries,
    total_filtered: totalFiltered,
    export_hash: normalizeEntityHash(payload?.export_hash),
    signature: payload?.signature
  };

  if (nextCursor) out.next_cursor = nextCursor;

  const attestation = normalizeExportAttestation(payload?.attestation);
  if (attestation) out.attestation = attestation;

  const checkpoint = normalizeExportCheckpoint(payload?.checkpoint);
  if (checkpoint) out.checkpoint = checkpoint;

  return out;
}

export class TransparencyLogPublicationService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureTransparencyState(this.store);
  }

  appendPublicationEntries({ actor, auth, idempotencyKey, request }) {
    const op = 'transparencyLog.publication.append';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can append transparency log publications', { actor })
      };
    }

    const rawEntries = Array.isArray(request?.entries) ? request.entries : [];
    if (rawEntries.length < 1 || rawEntries.length > 100) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid transparency log publication payload', {
          reason_code: 'transparency_log_publication_invalid'
        })
      };
    }

    const normalizedEntries = [];
    for (const row of rawEntries) {
      const normalized = normalizePublicationEntry(row);
      if (!normalized) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid transparency log publication payload', {
            reason_code: 'transparency_log_publication_invalid'
          })
        };
      }
      normalizedEntries.push(normalized);
    }

    const occurredAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const occurredAtMs = parseIsoMs(occurredAtRaw);
    if (occurredAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for transparency log publication append', {
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
        const publishedAt = new Date(occurredAtMs).toISOString();

        state.publicationCounter = Number.parseInt(String(this.store.state.transparency_log_publication_counter ?? 0), 10);
        if (!Number.isFinite(state.publicationCounter) || state.publicationCounter < 0) state.publicationCounter = 0;
        state.publicationCounter += 1;
        this.store.state.transparency_log_publication_counter = state.publicationCounter;

        const publicationId = `tl_pub_${String(state.publicationCounter).padStart(6, '0')}`;

        let previousChainHash = state.publications.length > 0
          ? (state.publications[state.publications.length - 1]?.chain_hash ?? null)
          : null;

        const appended = [];
        for (const row of normalizedEntries) {
          let entryCounter = Number.parseInt(String(this.store.state.transparency_log_entry_counter ?? 0), 10);
          if (!Number.isFinite(entryCounter) || entryCounter < 0) entryCounter = 0;
          entryCounter += 1;
          this.store.state.transparency_log_entry_counter = entryCounter;

          const entryId = `tl_entry_${String(entryCounter).padStart(6, '0')}`;

          const chainInput = {
            previous_chain_hash: previousChainHash,
            entry_id: entryId,
            publication_id: publicationId,
            partner_id: actor.id,
            entry_type: row.entry_type,
            entity_id: row.entity_id,
            entity_hash: row.entity_hash,
            cycle_id: row.cycle_id ?? null,
            published_at: publishedAt
          };

          const chainHash = sha256HexCanonical(chainInput);

          const record = {
            log_index: entryCounter,
            ...chainInput,
            chain_hash: chainHash
          };

          state.publications.push(record);
          appended.push(record);
          previousChainHash = chainHash;
        }

        const publicationHash = sha256HexCanonical({
          publication_id: publicationId,
          partner_id: actor.id,
          published_at: publishedAt,
          entry_ids: appended.map(e => e.entry_id),
          chain_hashes: appended.map(e => e.chain_hash)
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            publication: {
              publication_id: publicationId,
              partner_id: actor.id,
              entries_appended: appended.length,
              first_entry_id: appended[0]?.entry_id ?? null,
              last_entry_id: appended[appended.length - 1]?.entry_id ?? null,
              first_chain_hash: appended[0]?.chain_hash ?? null,
              last_chain_hash: appended[appended.length - 1]?.chain_hash ?? null,
              publication_hash: publicationHash,
              published_at: publishedAt
            }
          }
        };
      }
    });
  }

  exportPublicationLog({ actor, auth, query }) {
    const op = 'transparencyLog.publication.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export transparency log publications', { actor })
      };
    }

    const state = ensureTransparencyState(this.store);
    const entriesForPartner = state.publications.filter(row => row.partner_id === actor.id);

    const paged = paginateEntries({ entries: entriesForPartner, query, correlationId: corr });
    if (!paged.ok) return paged;

    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    if (paged.cursorAfter && !attestationAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'attestation_after is required when cursor_after is provided', {
          reason_code: 'transparency_log_export_query_invalid',
          cursor_after: paged.cursorAfter,
          attestation_after: query?.attestation_after ?? null
        })
      };
    }

    if (!paged.cursorAfter && attestationAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'attestation_after is only allowed with cursor_after', {
          reason_code: 'transparency_log_export_query_invalid',
          cursor_after: query?.cursor_after ?? null,
          attestation_after: attestationAfter
        })
      };
    }

    const checkpointAfter = normalizeEntityHash(query?.checkpoint_after);
    const checkpointRequired = exportCheckpointEnforced();
    const checkpointState = state.checkpoints;
    const checkpointContext = checkpointContextFromQuery({ query, partnerId: actor.id });
    const checkpointContextFingerprint = checkpointContextKey(checkpointContext);
    const checkpointNowIso = nowIsoForCheckpointRetention(query);
    const checkpointNowMs = parseIsoMs(checkpointNowIso);

    if (checkpointRequired && checkpointNowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid now_iso for checkpoint retention', {
          reason_code: 'transparency_log_export_query_invalid',
          now_iso: checkpointNowIso
        })
      };
    }

    if (checkpointRequired && paged.cursorAfter && !checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after is required when cursor_after is provided', {
          reason_code: 'transparency_log_export_query_invalid',
          cursor_after: paged.cursorAfter,
          checkpoint_after: query?.checkpoint_after ?? null
        })
      };
    }

    if (checkpointRequired && !paged.cursorAfter && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after is only allowed with cursor_after', {
          reason_code: 'transparency_log_export_query_invalid',
          cursor_after: query?.cursor_after ?? null,
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (!checkpointRequired && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after is not enabled for transparency export contract', {
          reason_code: 'transparency_log_export_query_invalid',
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (checkpointRequired && paged.cursorAfter) {
      const priorCheckpoint = checkpointState[checkpointAfter] ?? null;
      if (!priorCheckpoint) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after not found for transparency export continuation', {
            reason_code: 'transparency_log_checkpoint_after_not_found',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (isCheckpointExpired({ checkpointRecord: priorCheckpoint, nowMs: checkpointNowMs })) {
        delete checkpointState[checkpointAfter];
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after expired for transparency export continuation', {
            reason_code: 'transparency_log_checkpoint_expired',
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
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after does not match checkpoint continuation cursor', {
            reason_code: 'transparency_log_checkpoint_cursor_mismatch',
            checkpoint_after: checkpointAfter,
            expected_cursor_after: priorCheckpoint.next_cursor ?? null,
            cursor_after: paged.cursorAfter
          })
        };
      }

      if (priorCheckpoint.attestation_chain_hash !== attestationAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'attestation_after does not match checkpoint continuation chain', {
            reason_code: 'transparency_log_checkpoint_attestation_mismatch',
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
            reason_code: 'transparency_log_checkpoint_query_mismatch',
            checkpoint_after: checkpointAfter,
            expected_context: priorCheckpoint.query_context ?? null,
            provided_context: checkpointContext
          })
        };
      }
    }

    const exportedAt = exportedAtIso(query);
    if (parseIsoMs(exportedAt) === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid exported_at timestamp for transparency export', {
          reason_code: 'transparency_log_export_query_invalid',
          exported_at_iso: query?.exported_at_iso ?? null,
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const summary = buildSummary(entriesForPartner, paged.entries);
    const signingQuery = normalizeExportQuery(query, { partnerId: actor.id });

    const withAttestation = Boolean(paged.limit || paged.cursorAfter || attestationAfter);
    const withCheckpoint = checkpointRequired && withAttestation;

    const payload = {
      exported_at: exportedAt,
      query: signingQuery,
      summary,
      entries: paged.entries,
      total_filtered: withAttestation ? paged.totalFiltered : paged.entries.length,
      ...(withAttestation && paged.nextCursor ? { next_cursor: paged.nextCursor } : {})
    };

    const exportHash = buildExportHash({
      summary: payload.summary,
      entries: payload.entries,
      totalFiltered: payload.total_filtered,
      query: payload.query,
      nextCursor: payload.next_cursor
    });
    payload.export_hash = exportHash;

    if (withAttestation) {
      payload.attestation = buildExportAttestation({
        query: payload.query,
        nextCursor: payload.next_cursor,
        exportHash
      });
    }

    if (withCheckpoint) {
      payload.checkpoint = buildExportCheckpoint({
        query: payload.query,
        attestation: payload.attestation ?? null,
        nextCursor: payload.next_cursor,
        entriesCount: payload.entries.length,
        totalFiltered: payload.total_filtered
      });
    }

    payload.signature = signPolicyIntegrityPayload(payload);

    if (withCheckpoint && payload.checkpoint?.checkpoint_hash) {
      checkpointState[payload.checkpoint.checkpoint_hash] = {
        checkpoint_hash: payload.checkpoint.checkpoint_hash,
        checkpoint_after: payload.checkpoint.checkpoint_after ?? null,
        partner_id: actor.id,
        next_cursor: payload.checkpoint.next_cursor ?? null,
        attestation_chain_hash: payload.attestation?.chain_hash ?? null,
        query_context_fingerprint: checkpointContextFingerprint,
        query_context: checkpointContext,
        exported_at: payload.exported_at
      };
    }

    if (checkpointRequired) {
      pruneExpiredCheckpoints({ checkpointState, nowMs: checkpointNowMs });
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        ...payload
      }
    };
  }

  verifyPublicationExportPayload({ payload }) {
    const normalizedPayload = normalizeExportPayload(payload ?? {});

    if (!normalizedPayload.export_hash) {
      return { ok: false, error: 'export_hash_missing' };
    }

    const expectedHash = buildExportHash({
      summary: normalizedPayload.summary,
      entries: normalizedPayload.entries,
      totalFiltered: normalizedPayload.total_filtered,
      query: normalizedPayload.query,
      nextCursor: normalizedPayload.next_cursor
    });

    if (normalizedPayload.export_hash !== expectedHash) {
      return {
        ok: false,
        error: 'export_hash_mismatch',
        details: {
          expected_hash: expectedHash,
          provided_hash: normalizedPayload.export_hash
        }
      };
    }

    if (normalizedPayload.attestation) {
      const expectedAttestation = buildExportAttestation({
        query: normalizedPayload.query,
        nextCursor: normalizedPayload.next_cursor,
        exportHash: normalizedPayload.export_hash
      });

      if (canonicalStringify(normalizedPayload.attestation) !== canonicalStringify(expectedAttestation)) {
        return {
          ok: false,
          error: 'attestation_mismatch',
          details: {
            expected_attestation: expectedAttestation,
            provided_attestation: normalizedPayload.attestation
          }
        };
      }
    }

    if (normalizedPayload.checkpoint) {
      const expectedCheckpoint = buildExportCheckpoint({
        query: normalizedPayload.query,
        attestation: normalizedPayload.attestation ?? null,
        nextCursor: normalizedPayload.next_cursor,
        entriesCount: Array.isArray(normalizedPayload.entries) ? normalizedPayload.entries.length : 0,
        totalFiltered: normalizedPayload.total_filtered
      });

      if (canonicalStringify(normalizedPayload.checkpoint) !== canonicalStringify(expectedCheckpoint)) {
        return {
          ok: false,
          error: 'checkpoint_mismatch',
          details: {
            expected_checkpoint: expectedCheckpoint,
            provided_checkpoint: normalizedPayload.checkpoint
          }
        };
      }
    }

    const sig = verifyPolicyIntegrityPayloadSignature(normalizedPayload);
    if (!sig.ok) return sig;

    return { ok: true };
  }

  verifyPublicationExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
    const normalizedPayload = normalizeExportPayload(payload ?? {});

    const verifiedPayload = this.verifyPublicationExportPayload({ payload: normalizedPayload });
    if (!verifiedPayload.ok) return verifiedPayload;

    return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({
      payload: normalizedPayload,
      publicKeyPem,
      keyId,
      alg
    });
  }
}
