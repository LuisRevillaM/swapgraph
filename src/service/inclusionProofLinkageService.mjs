import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { verifyReceiptSignature } from '../crypto/receiptSigning.mjs';
import { buildCustodyInclusionProof, verifyCustodyInclusionProof } from '../custody/proofOfCustody.mjs';
import { buildSignedInclusionProofLinkageExportPayload } from '../crypto/policyIntegritySigning.mjs';

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

function normalizeLimit(value) {
  return parsePositiveInt(value, { min: 1, max: 200 });
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function normalizeStringSet(values) {
  if (!Array.isArray(values)) return [];
  const out = values
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim());
  return Array.from(new Set(out)).sort();
}

function ensureInclusionProofState(store) {
  store.state.inclusion_proof_linkages ||= [];
  store.state.inclusion_proof_export_checkpoints ||= {};
  store.state.inclusion_proof_linkage_counter ||= 0;

  store.state.receipts ||= {};
  store.state.vault_custody_snapshots ||= {};
  store.state.transparency_log_publications ||= [];
  store.state.idempotency ||= {};

  return {
    linkages: store.state.inclusion_proof_linkages,
    exportCheckpoints: store.state.inclusion_proof_export_checkpoints,
    idempotency: store.state.idempotency
  };
}

function nextLinkageCounter(store) {
  const current = Number.parseInt(String(store.state.inclusion_proof_linkage_counter ?? 0), 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  store.state.inclusion_proof_linkage_counter = next;
  return next;
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

  const idemState = ensureInclusionProofState(store).idempotency;
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

function normalizeRecordRequest(request) {
  const linkage = request?.linkage;
  if (!linkage || typeof linkage !== 'object' || Array.isArray(linkage)) return null;

  const cycleId = normalizeOptionalString(linkage.cycle_id);
  const custodySnapshotId = normalizeOptionalString(linkage.custody_snapshot_id);
  const custodyHoldingId = normalizeOptionalString(linkage.custody_holding_id);
  const transparencyPublicationId = normalizeOptionalString(linkage.transparency_publication_id);
  const notes = normalizeOptionalString(linkage.notes);

  if (!cycleId || !custodySnapshotId || !custodyHoldingId || !transparencyPublicationId) return null;

  return {
    cycle_id: cycleId,
    custody_snapshot_id: custodySnapshotId,
    custody_holding_id: custodyHoldingId,
    transparency_publication_id: transparencyPublicationId,
    ...(notes ? { notes } : {})
  };
}

function normalizeLinkageRecord(record) {
  return {
    linkage_id: record.linkage_id,
    linkage_index: Number(record.linkage_index ?? 0),
    partner_id: record.partner_id,
    cycle_id: record.cycle_id,
    receipt_id: record.receipt_id,
    receipt_hash: record.receipt_hash,
    receipt_signature_key_id: record.receipt_signature_key_id,
    custody_snapshot_id: record.custody_snapshot_id,
    custody_holding_id: record.custody_holding_id,
    custody_root_hash: record.custody_root_hash,
    custody_leaf_hash: record.custody_leaf_hash,
    inclusion_proof_hash: record.inclusion_proof_hash,
    transparency_publication_id: record.transparency_publication_id,
    transparency_root_hash: record.transparency_root_hash,
    transparency_chain_hash: record.transparency_chain_hash,
    previous_linkage_hash: record.previous_linkage_hash ?? null,
    linkage_hash: record.linkage_hash,
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {}),
    integration_mode: 'fixture_only',
    recorded_at: record.recorded_at
  };
}

function checkpointRetentionDays() {
  const raw = Number.parseInt(String(process.env.INCLUSION_PROOF_EXPORT_CHECKPOINT_RETENTION_DAYS ?? ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(raw, 3650);
}

function checkpointRetentionWindowMs() {
  return checkpointRetentionDays() * 24 * 60 * 60 * 1000;
}

function exportCheckpointEnforced() {
  return process.env.INCLUSION_PROOF_EXPORT_CHECKPOINT_ENFORCE === '1';
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

function checkpointContextFromQuery(query) {
  return {
    cycle_id: normalizeOptionalString(query?.cycle_id),
    from_iso: normalizeOptionalString(query?.from_iso),
    to_iso: normalizeOptionalString(query?.to_iso),
    limit: normalizeLimit(query?.limit)
  };
}

function checkpointContextKey(context) {
  return JSON.stringify(context);
}

function exportQueryForSigning({ query, limit, cursorAfter, attestationAfter, checkpointAfter }) {
  const out = {};
  if (typeof query?.cycle_id === 'string' && query.cycle_id.trim()) out.cycle_id = query.cycle_id.trim();
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

function findCustodyHolding(snapshot, holdingId) {
  const entries = Array.isArray(snapshot?.holdings) ? snapshot.holdings : [];
  const target = normalizeOptionalString(holdingId);
  if (!target) return null;

  const entry = entries.find(item => {
    const innerHolding = item?.holding ?? null;
    const directId = normalizeOptionalString(item?.holding_id);
    const nestedId = normalizeOptionalString(innerHolding?.holding_id);
    return directId === target || nestedId === target;
  }) ?? null;

  if (!entry) return null;
  return entry?.holding ?? entry;
}

function findTransparencyPublication({ store, partnerId, publicationId }) {
  const publications = Array.isArray(store.state.transparency_log_publications)
    ? store.state.transparency_log_publications
    : [];

  return publications.find(pub => pub?.publication_id === publicationId && pub?.partner_id === partnerId) ?? null;
}

function linkagesForPartner(store, partnerId) {
  return (store.state.inclusion_proof_linkages ?? [])
    .filter(x => x?.partner_id === partnerId)
    .sort((a, b) => Number(a.linkage_index ?? 0) - Number(b.linkage_index ?? 0));
}

export class InclusionProofLinkageService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureInclusionProofState(this.store);
  }

  recordLinkage({ actor, auth, idempotencyKey, request }) {
    const op = 'inclusionProof.linkage.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record inclusion-proof linkage', { actor })
      };
    }

    const normalized = normalizeRecordRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid inclusion-proof linkage payload', {
          reason_code: 'inclusion_linkage_invalid'
        })
      };
    }

    const occurredAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const occurredAtMs = parseIsoMs(occurredAtRaw);
    if (occurredAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid inclusion-proof linkage timestamp', {
          reason_code: 'inclusion_linkage_invalid_timestamp'
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
        const receipt = this.store.state.receipts?.[normalized.cycle_id] ?? null;
        if (!receipt) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'receipt is required for inclusion-proof linkage', {
              reason_code: 'inclusion_linkage_receipt_not_found',
              cycle_id: normalized.cycle_id
            })
          };
        }

        const receiptSignature = verifyReceiptSignature(receipt);
        if (!receiptSignature.ok) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'receipt signature is invalid for inclusion-proof linkage', {
              reason_code: 'inclusion_linkage_receipt_signature_invalid',
              cycle_id: normalized.cycle_id,
              verify_error: receiptSignature.error ?? null
            })
          };
        }

        const snapshot = this.store.state.vault_custody_snapshots?.[normalized.custody_snapshot_id] ?? null;
        if (!snapshot) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'custody snapshot is required for inclusion-proof linkage', {
              reason_code: 'inclusion_linkage_custody_snapshot_not_found',
              custody_snapshot_id: normalized.custody_snapshot_id
            })
          };
        }

        const holding = findCustodyHolding(snapshot, normalized.custody_holding_id);
        if (!holding) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'custody holding not found in snapshot', {
              reason_code: 'inclusion_linkage_custody_holding_not_found',
              custody_snapshot_id: normalized.custody_snapshot_id,
              custody_holding_id: normalized.custody_holding_id
            })
          };
        }

        const inclusionProof = buildCustodyInclusionProof({ snapshot, holding });
        if (!inclusionProof.ok) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'failed to derive custody inclusion proof for linkage', {
              reason_code: 'inclusion_linkage_custody_proof_invalid',
              proof_error: inclusionProof.error ?? null
            })
          };
        }

        const proofVerification = verifyCustodyInclusionProof({
          snapshot,
          holding,
          proof: inclusionProof.proof
        });
        if (!proofVerification.ok) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'custody inclusion proof verification failed', {
              reason_code: 'inclusion_linkage_custody_proof_invalid',
              verify_error: proofVerification.error ?? null
            })
          };
        }

        const publication = findTransparencyPublication({
          store: this.store,
          partnerId: actor.id,
          publicationId: normalized.transparency_publication_id
        });
        if (!publication) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'transparency publication not found for linkage', {
              reason_code: 'inclusion_linkage_transparency_publication_not_found',
              transparency_publication_id: normalized.transparency_publication_id
            })
          };
        }

        const artifactRefs = normalizeStringSet(publication.artifact_refs);
        const expectedRefs = [
          `receipt:${receipt.id}`,
          `custody_snapshot:${normalized.custody_snapshot_id}`
        ];
        const missingRefs = expectedRefs.filter(x => !artifactRefs.includes(x));
        if (missingRefs.length > 0) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'transparency publication is missing required linkage artifacts', {
              reason_code: 'inclusion_linkage_transparency_artifact_missing',
              transparency_publication_id: normalized.transparency_publication_id,
              missing_artifact_refs: missingRefs
            })
          };
        }

        const prior = linkagesForPartner(this.store, actor.id);
        const previous = prior[prior.length - 1] ?? null;
        const previousLinkageHash = previous?.linkage_hash ?? null;

        const linkageIndex = nextLinkageCounter(this.store);
        const linkageId = `inclusion_linkage_${String(linkageIndex).padStart(6, '0')}`;

        const receiptHash = sha256HexCanonical(receipt);
        const inclusionProofHash = sha256HexCanonical(inclusionProof.proof);

        const linkageHash = sha256HexCanonical({
          linkage_id: linkageId,
          linkage_index: linkageIndex,
          partner_id: actor.id,
          cycle_id: normalized.cycle_id,
          receipt_id: receipt.id,
          receipt_hash: receiptHash,
          custody_snapshot_id: normalized.custody_snapshot_id,
          custody_holding_id: normalized.custody_holding_id,
          custody_root_hash: snapshot.root_hash,
          custody_leaf_hash: inclusionProof.proof.leaf_hash,
          inclusion_proof_hash: inclusionProofHash,
          transparency_publication_id: publication.publication_id,
          transparency_root_hash: publication.root_hash,
          transparency_chain_hash: publication.chain_hash,
          previous_linkage_hash: previousLinkageHash,
          recorded_at: new Date(occurredAtMs).toISOString()
        });

        const record = {
          linkage_id: linkageId,
          linkage_index: linkageIndex,
          partner_id: actor.id,
          cycle_id: normalized.cycle_id,
          receipt_id: receipt.id,
          receipt_hash: receiptHash,
          receipt_signature_key_id: receipt.signature?.key_id ?? null,
          custody_snapshot_id: normalized.custody_snapshot_id,
          custody_holding_id: normalized.custody_holding_id,
          custody_root_hash: snapshot.root_hash,
          custody_leaf_hash: inclusionProof.proof.leaf_hash,
          inclusion_proof_hash: inclusionProofHash,
          transparency_publication_id: publication.publication_id,
          transparency_root_hash: publication.root_hash,
          transparency_chain_hash: publication.chain_hash,
          previous_linkage_hash: previousLinkageHash,
          linkage_hash: linkageHash,
          ...(normalized.notes ? { notes: normalized.notes } : {}),
          integration_mode: 'fixture_only',
          recorded_at: new Date(occurredAtMs).toISOString()
        };

        this.store.state.inclusion_proof_linkages.push(record);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            linkage: normalizeLinkageRecord(record)
          }
        };
      }
    });
  }

  exportLinkages({ actor, auth, query }) {
    const op = 'inclusionProof.linkage.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export inclusion-proof linkages', { actor })
      };
    }

    const cycleIdFilter = normalizeOptionalString(query?.cycle_id);
    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;

    if ((fromIso && fromMs === null) || (toIso && toMs === null) || (fromMs !== null && toMs !== null && fromMs > toMs)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid inclusion-proof linkage export query', {
          reason_code: 'inclusion_linkage_export_query_invalid',
          from_iso: fromIso,
          to_iso: toIso
        })
      };
    }

    const state = ensureInclusionProofState(this.store);
    let allFiltered = state.linkages
      .filter(x => x?.partner_id === actor.id)
      .filter(x => !cycleIdFilter || x?.cycle_id === cycleIdFilter)
      .map(x => ({ entry: x, ts: parseIsoMs(x?.recorded_at) }))
      .filter(x => x.ts !== null)
      .filter(x => fromMs === null || x.ts >= fromMs)
      .filter(x => toMs === null || x.ts <= toMs)
      .map(x => x.entry);

    allFiltered.sort((a, b) => {
      const aTs = parseIsoMs(a?.recorded_at) ?? 0;
      const bTs = parseIsoMs(b?.recorded_at) ?? 0;
      if (aTs !== bTs) return aTs - bTs;
      return String(a?.linkage_id ?? '').localeCompare(String(b?.linkage_id ?? ''));
    });

    const summaryTotalLinkages = allFiltered.length;
    const summaryReceiptCount = new Set(allFiltered.map(x => x?.receipt_id).filter(Boolean)).size;
    const summaryChainHead = summaryTotalLinkages > 0 ? (allFiltered[summaryTotalLinkages - 1]?.linkage_hash ?? null) : null;
    const summaryChainTail = summaryTotalLinkages > 0 ? (allFiltered[0]?.linkage_hash ?? null) : null;

    let filtered = allFiltered;

    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    if (cursorAfter) {
      const idx = filtered.findIndex(x => x?.linkage_id === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found in inclusion-proof linkage export set', {
            reason_code: 'inclusion_linkage_export_cursor_not_found',
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
      nextCursor = page[page.length - 1]?.linkage_id ?? null;
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
    const checkpointContext = checkpointContextFromQuery(query);
    const checkpointContextFingerprint = checkpointContextKey(checkpointContext);
    const checkpointNowIso = query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    const checkpointNowMs = parseIsoMs(checkpointNowIso);

    if (checkpointRequired && checkpointNowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid now_iso for inclusion-proof checkpoint retention', {
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
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after not found for inclusion-proof linkage export continuation', {
            reason_code: 'checkpoint_after_not_found',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (isCheckpointExpired({ checkpointRecord: priorCheckpoint, nowMs: checkpointNowMs })) {
        delete checkpointState[checkpointAfter];
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after expired for inclusion-proof linkage export continuation', {
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
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'inclusion-proof export continuation query does not match checkpoint context', {
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid exported_at timestamp for inclusion-proof export', {
          reason_code: 'inclusion_linkage_export_invalid_timestamp',
          exported_at_iso: query?.exported_at_iso ?? null,
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const normalizedPage = filtered.map(normalizeLinkageRecord);

    const summary = {
      total_linkages: summaryTotalLinkages,
      returned_count: normalizedPage.length,
      linked_receipt_count: summaryReceiptCount,
      chain_head: summaryChainHead,
      chain_tail: summaryChainTail
    };

    const signingQuery = exportQueryForSigning({
      query,
      limit,
      cursorAfter,
      attestationAfter,
      checkpointAfter
    });

    const withAttestation = Boolean(limit || cursorAfter || attestationAfter);
    const withCheckpoint = checkpointRequired && withAttestation;

    const signedPayload = buildSignedInclusionProofLinkageExportPayload({
      exportedAt,
      query: signingQuery,
      summary,
      linkages: normalizedPage,
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
