import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { buildSignedStagingEvidenceBundleExportPayload } from '../crypto/policyIntegritySigning.mjs';

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

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
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

function isHex64(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function ensureStagingEvidenceState(store) {
  store.state.staging_evidence_bundles ||= [];
  store.state.staging_evidence_bundle_counter ||= 0;
  store.state.idempotency ||= {};

  return {
    bundles: store.state.staging_evidence_bundles,
    idempotency: store.state.idempotency
  };
}

function nextBundleCounter(store) {
  const current = Number.parseInt(String(store.state.staging_evidence_bundle_counter ?? 0), 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  store.state.staging_evidence_bundle_counter = next;
  return next;
}

function applyIdempotentMutation({ store, actor, operationId, idempotencyKey, requestPayload, mutate, correlationId: corr }) {
  const key = normalizeOptionalString(idempotencyKey);
  if (!key) {
    return {
      ok: false,
      body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'idempotency key is required', {
        operation_id: operationId
      })
    };
  }

  const idemState = ensureStagingEvidenceState(store).idempotency;
  const scopeKey = `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}|${operationId}|${key}`;
  const incomingHash = payloadHash(requestPayload);
  const prior = idemState[scopeKey] ?? null;

  if (prior) {
    if (prior.payload_hash !== incomingHash) {
      return {
        ok: false,
        body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reuse with different payload', {
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

const allowedEvidenceKinds = new Set([
  'verify_log',
  'runner_report',
  'fixture_output',
  'runbook_note',
  'integration_proof',
  'conformance_report'
]);

function normalizeEvidenceItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const artifactRef = normalizeOptionalString(item.artifact_ref);
  const artifactKind = normalizeOptionalString(item.artifact_kind);
  const sha256 = normalizeOptionalString(item.sha256)?.toLowerCase();
  const capturedAtRaw = normalizeOptionalString(item.captured_at);
  const capturedAtMs = capturedAtRaw ? parseIsoMs(capturedAtRaw) : null;

  if (!artifactRef || !artifactKind || !allowedEvidenceKinds.has(artifactKind) || !isHex64(sha256) || (capturedAtRaw && capturedAtMs === null)) {
    return null;
  }

  return {
    artifact_ref: artifactRef,
    artifact_kind: artifactKind,
    sha256,
    ...(capturedAtMs !== null ? { captured_at: new Date(capturedAtMs).toISOString() } : {})
  };
}

function normalizeEvidenceItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const normalized = [];
  const dedupe = new Set();

  for (const item of items) {
    const row = normalizeEvidenceItem(item);
    if (!row) return null;
    const dedupeKey = `${row.artifact_ref}|${row.artifact_kind}|${row.sha256}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);
    normalized.push(row);
  }

  if (normalized.length === 0) return null;

  return normalized.sort((a, b) => `${a.artifact_ref}|${a.artifact_kind}|${a.sha256}`.localeCompare(`${b.artifact_ref}|${b.artifact_kind}|${b.sha256}`));
}

function normalizeRecordRequest(request) {
  const payload = request?.bundle;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const milestoneId = normalizeOptionalString(payload.milestone_id);
  const runbookRef = normalizeOptionalString(payload.runbook_ref);
  const environment = normalizeOptionalString(payload.environment) ?? 'staging';
  const collectedAtRaw = normalizeOptionalString(payload.collected_at);
  const collectedAtMs = parseIsoMs(collectedAtRaw);
  const evidenceItems = normalizeEvidenceItems(payload.evidence_items);

  if (!milestoneId || !runbookRef || environment !== 'staging' || collectedAtMs === null || !evidenceItems) {
    return null;
  }

  return {
    milestone_id: milestoneId,
    environment,
    runbook_ref: runbookRef,
    collected_at: new Date(collectedAtMs).toISOString(),
    evidence_items: evidenceItems,
    ...(normalizeOptionalString(payload.conformance_ref) ? { conformance_ref: normalizeOptionalString(payload.conformance_ref) } : {}),
    ...(normalizeOptionalString(payload.release_ref) ? { release_ref: normalizeOptionalString(payload.release_ref) } : {}),
    ...(normalizeOptionalString(payload.notes) ? { notes: normalizeOptionalString(payload.notes) } : {})
  };
}

function bundleManifestInput(bundle) {
  return {
    milestone_id: bundle.milestone_id,
    environment: bundle.environment,
    runbook_ref: bundle.runbook_ref,
    collected_at: bundle.collected_at,
    evidence_items: (bundle.evidence_items ?? []).map(item => ({
      artifact_ref: item.artifact_ref,
      artifact_kind: item.artifact_kind,
      sha256: item.sha256,
      ...(item.captured_at ? { captured_at: item.captured_at } : {})
    })),
    ...(bundle.conformance_ref ? { conformance_ref: bundle.conformance_ref } : {}),
    ...(bundle.release_ref ? { release_ref: bundle.release_ref } : {}),
    ...(bundle.notes ? { notes: bundle.notes } : {})
  };
}

function buildManifestHash(bundle) {
  return sha256HexCanonical(bundleManifestInput(bundle));
}

function buildCheckpointHash({ checkpointAfter, bundleId, manifestHash, collectedAt, recordedAt }) {
  return sha256HexCanonical({
    checkpoint_after: checkpointAfter,
    bundle_id: bundleId,
    manifest_hash: manifestHash,
    collected_at: collectedAt,
    recorded_at: recordedAt
  });
}

function normalizeBundle(record) {
  return {
    bundle_id: record.bundle_id,
    partner_id: record.partner_id,
    milestone_id: record.milestone_id,
    environment: record.environment,
    runbook_ref: record.runbook_ref,
    conformance_ref: record.conformance_ref ?? null,
    release_ref: record.release_ref ?? null,
    collected_at: record.collected_at,
    evidence_items: (record.evidence_items ?? []).map(item => ({
      artifact_ref: item.artifact_ref,
      artifact_kind: item.artifact_kind,
      sha256: item.sha256,
      captured_at: item.captured_at ?? null
    })),
    evidence_count: Number(record.evidence_count ?? 0),
    manifest_hash: record.manifest_hash,
    checkpoint_after: record.checkpoint_after ?? null,
    checkpoint_hash: record.checkpoint_hash,
    integration_mode: 'fixture_only',
    recorded_at: record.recorded_at,
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {})
  };
}

function bundleCursorKey(row) {
  const recordedAt = normalizeOptionalString(row?.recorded_at) ?? '';
  const bundleId = normalizeOptionalString(row?.bundle_id) ?? '';
  return `${recordedAt}|${bundleId}`;
}

function summarizeBundles(all, page) {
  const rows = Array.isArray(all) ? all : [];
  const returned = Array.isArray(page) ? page : [];

  const byMilestone = new Map();
  for (const row of rows) {
    const milestone = row.milestone_id;
    byMilestone.set(milestone, (byMilestone.get(milestone) ?? 0) + 1);
  }

  return {
    total_bundles: rows.length,
    returned_bundles: returned.length,
    total_evidence_items: rows.reduce((acc, row) => acc + Number(row.evidence_count ?? 0), 0),
    returned_evidence_items: returned.reduce((acc, row) => acc + Number(row.evidence_count ?? 0), 0),
    latest_checkpoint_hash: rows.length > 0 ? rows[rows.length - 1].checkpoint_hash : null,
    by_milestone: Array.from(byMilestone.entries())
      .map(([milestone_id, count]) => ({ milestone_id, count }))
      .sort((a, b) => String(a.milestone_id).localeCompare(String(b.milestone_id)))
  };
}

export class StagingEvidenceConformanceService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureStagingEvidenceState(this.store);
  }

  recordBundle({ actor, auth, idempotencyKey, request }) {
    const op = 'staging.evidence_bundle.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record staging evidence bundles', { actor })
      };
    }

    const normalized = normalizeRecordRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid staging evidence bundle payload', {
          reason_code: 'staging_evidence_bundle_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid staging evidence timestamp', {
          reason_code: 'staging_evidence_bundle_invalid_timestamp'
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
        const state = ensureStagingEvidenceState(this.store);

        const tempForHash = {
          ...normalized
        };
        const manifestHash = buildManifestHash(tempForHash);

        const existing = state.bundles.find(row => row?.partner_id === actor.id && row?.milestone_id === normalized.milestone_id && row?.manifest_hash === manifestHash) ?? null;
        if (existing) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'staging evidence bundle already recorded', {
              reason_code: 'staging_evidence_bundle_exists',
              bundle_id: existing.bundle_id
            })
          };
        }

        const counter = nextBundleCounter(this.store);
        const bundleId = `staging_evidence_bundle_${String(counter).padStart(6, '0')}`;
        const recordedAt = new Date(occurredAtMs).toISOString();

        const previousBundle = [...state.bundles]
          .filter(row => row?.partner_id === actor.id)
          .map(normalizeBundle)
          .sort((a, b) => bundleCursorKey(a).localeCompare(bundleCursorKey(b)))
          .pop() ?? null;
        const checkpointAfter = previousBundle?.checkpoint_hash ?? null;

        const checkpointHash = buildCheckpointHash({
          checkpointAfter,
          bundleId,
          manifestHash,
          collectedAt: normalized.collected_at,
          recordedAt
        });

        const bundle = {
          bundle_id: bundleId,
          partner_id: actor.id,
          ...normalized,
          evidence_count: normalized.evidence_items.length,
          manifest_hash: manifestHash,
          checkpoint_after: checkpointAfter,
          checkpoint_hash: checkpointHash,
          integration_mode: 'fixture_only',
          recorded_at: recordedAt
        };

        state.bundles.push(bundle);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            bundle: normalizeBundle(bundle)
          }
        };
      }
    });
  }

  exportBundles({ actor, auth, query }) {
    const op = 'staging.evidence_bundle.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export staging evidence bundles', { actor })
      };
    }

    const milestoneId = normalizeOptionalString(query?.milestone_id);
    const environment = normalizeOptionalString(query?.environment);
    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const limit = normalizeLimit(query?.limit ?? 50);
    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    const exportedAtRaw = normalizeOptionalString(query?.exported_at_iso)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const exportedAtMs = parseIsoMs(exportedAtRaw);

    if ((environment && environment !== 'staging')
      || (fromIso && fromMs === null)
      || (toIso && toMs === null)
      || (fromMs !== null && toMs !== null && toMs < fromMs)
      || limit === null
      || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid staging evidence export query', {
          reason_code: 'staging_evidence_export_query_invalid'
        })
      };
    }

    const state = ensureStagingEvidenceState(this.store);
    const all = (state.bundles ?? [])
      .filter(row => row?.partner_id === actor.id)
      .map(normalizeBundle)
      .filter(row => !milestoneId || row.milestone_id === milestoneId)
      .filter(row => !environment || row.environment === environment)
      .filter(row => {
        const rowMs = parseIsoMs(row.recorded_at);
        if (rowMs === null) return false;
        if (fromMs !== null && rowMs < fromMs) return false;
        if (toMs !== null && rowMs > toMs) return false;
        return true;
      })
      .sort((a, b) => bundleCursorKey(a).localeCompare(bundleCursorKey(b)));

    let startIndex = 0;
    if (cursorAfter) {
      const idx = all.findIndex(row => bundleCursorKey(row) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found in staging evidence export window', {
            reason_code: 'staging_evidence_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }

      const cursorRow = all[idx];
      const expectedCheckpointAfter = cursorRow?.checkpoint_hash ?? null;

      if (!checkpointAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after required for paginated staging evidence continuation', {
            reason_code: 'staging_evidence_checkpoint_required',
            cursor_after: cursorAfter,
            expected_checkpoint_after: expectedCheckpointAfter
          })
        };
      }

      if (checkpointAfter !== expectedCheckpointAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after does not match continuation anchor', {
            reason_code: 'staging_evidence_checkpoint_mismatch',
            cursor_after: cursorAfter,
            expected_checkpoint_after: expectedCheckpointAfter,
            provided_checkpoint_after: checkpointAfter
          })
        };
      }

      startIndex = idx + 1;
    }

    const bundles = all.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < all.length
      ? bundleCursorKey(bundles[bundles.length - 1])
      : null;

    const summary = summarizeBundles(all, bundles);
    const normalizedExportedAtIso = new Date(exportedAtMs).toISOString();

    const signedPayload = buildSignedStagingEvidenceBundleExportPayload({
      exportedAt: normalizedExportedAtIso,
      query: {
        ...(milestoneId ? { milestone_id: milestoneId } : {}),
        ...(environment ? { environment } : {}),
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(attestationAfter ? { attestation_after: attestationAfter } : {}),
        ...(checkpointAfter ? { checkpoint_after: checkpointAfter } : {}),
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: normalizedExportedAtIso
      },
      summary,
      bundles,
      totalFiltered: all.length,
      nextCursor,
      withAttestation: true,
      withCheckpoint: true
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        integration_mode: 'fixture_only',
        ...signedPayload
      }
    };
  }
}
