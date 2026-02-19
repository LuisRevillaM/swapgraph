import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { authorizeApiOperation } from '../core/authz.mjs';
import { buildSignedPartnerProgramRolloutPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';
import {
  ensureVaultExportRolloutPolicyState,
  ensureVaultExportRolloutPolicyAuditState,
  isPartnerProgramAdminActor,
  normalizeRolloutPolicyAllowlistInput,
  normalizeRolloutMinPlanInput,
  parsePartnerProgramAdminAllowlist,
  resolveVaultExportRolloutPolicy,
  vaultExportRolloutPolicyView
} from '../partnerProgram/vaultExportRolloutPolicy.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForRolloutPolicy() {
  return 'corr_partner_program_vault_export_rollout_policy';
}

function correlationIdForRolloutPolicyAuditExport() {
  return 'corr_partner_program_vault_export_rollout_policy_audit_export';
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeLimit(limit) {
  const n = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 200);
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeActorRef(actor) {
  if (!isObject(actor)) return null;
  if (typeof actor.type !== 'string' || !actor.type.trim()) return null;
  if (typeof actor.id !== 'string' || !actor.id.trim()) return null;
  return { type: actor.type, id: actor.id };
}

function normalizeStoredPolicyForAudit(policy) {
  if (!isObject(policy)) {
    return {
      allowlist: [],
      min_plan_id: null,
      version: 0,
      updated_at: null,
      updated_by: null
    };
  }

  const allowlist = Array.isArray(policy.allowlist)
    ? Array.from(new Set(policy.allowlist.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))).sort()
    : [];

  return {
    allowlist,
    min_plan_id: typeof policy.min_plan_id === 'string' && policy.min_plan_id.trim() ? policy.min_plan_id.trim().toLowerCase() : null,
    version: Number.isFinite(policy.version) ? Number(policy.version) : 0,
    updated_at: normalizeOptionalString(policy.updated_at),
    updated_by: normalizeActorRef(policy.updated_by)
  };
}

function makeAuditId(version) {
  return `rollout_policy_${String(version).padStart(6, '0')}`;
}

function rolloutPolicyAuditExportCheckpointEnforced() {
  return process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_EXPORT_CHECKPOINT_ENFORCE === '1';
}

function partnerProgramRolloutPolicyExportCheckpointRetentionDays() {
  const raw = Number.parseInt(String(process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_EXPORT_CHECKPOINT_RETENTION_DAYS ?? ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(raw, 3650);
}

function partnerProgramRolloutPolicyExportCheckpointRetentionWindowMs() {
  return partnerProgramRolloutPolicyExportCheckpointRetentionDays() * 24 * 60 * 60 * 1000;
}

function nowIsoForPartnerProgramRolloutPolicyExportCheckpointRetention(query) {
  return query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function ensurePartnerProgramRolloutPolicyExportCheckpointState(store) {
  store.state.partner_program_rollout_policy_export_checkpoints ||= {};
  return store.state.partner_program_rollout_policy_export_checkpoints;
}

function isPartnerProgramRolloutPolicyExportCheckpointExpired({ checkpointRecord, nowMs }) {
  if (!checkpointRecord || typeof checkpointRecord !== 'object') return true;
  const exportedAtMs = parseIsoMs(checkpointRecord.exported_at);
  if (exportedAtMs === null) return true;
  return nowMs > (exportedAtMs + partnerProgramRolloutPolicyExportCheckpointRetentionWindowMs());
}

function pruneExpiredPartnerProgramRolloutPolicyExportCheckpoints({ checkpointState, nowMs }) {
  if (!checkpointState || typeof checkpointState !== 'object') return;
  for (const [checkpointHash, checkpointRecord] of Object.entries(checkpointState)) {
    if (isPartnerProgramRolloutPolicyExportCheckpointExpired({ checkpointRecord, nowMs })) {
      delete checkpointState[checkpointHash];
    }
  }
}

function checkpointContextFromPartnerProgramRolloutPolicyExportQuery({ query }) {
  return {
    from_iso: normalizeOptionalString(query?.from_iso),
    to_iso: normalizeOptionalString(query?.to_iso),
    limit: normalizeLimit(query?.limit)
  };
}

function checkpointContextKey(context) {
  return JSON.stringify(context);
}

export class PartnerProgramGovernanceService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    this.store.state.idempotency ||= {};
    ensureVaultExportRolloutPolicyState(this.store);
    ensureVaultExportRolloutPolicyAuditState(this.store);
    ensurePartnerProgramRolloutPolicyExportCheckpointState(this.store);
  }

  /**
   * @param {{ actor: any, operationId: string, idempotencyKey: string, requestBody: any, correlationId: string, handler: () => any }} params
   */
  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const h = payloadHash(requestBody);

    const existing = this.store.state.idempotency[scopeKey];
    if (existing) {
      if (existing.payload_hash === h) {
        return { replayed: true, result: existing.result };
      }
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(
            correlationId,
            'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
            'Idempotency key reused with a different payload',
            { scope_key: scopeKey, original_hash: existing.payload_hash, new_hash: h }
          )
        }
      };
    }

    const result = handler();
    const snapshot = clone(result);
    this.store.state.idempotency[scopeKey] = { payload_hash: h, result: snapshot };
    return { replayed: false, result: snapshot };
  }

  upsertVaultExportRolloutPolicy({ actor, auth, idempotencyKey, requestBody, occurredAt }) {
    const correlationId = correlationIdForRolloutPolicy();

    const authz = authorizeApiOperation({ operationId: 'partnerProgram.vault_export.rollout_policy.upsert', actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: 'partnerProgram.vault_export.rollout_policy.upsert',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        if (!isPartnerProgramAdminActor(actor)) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'partner admin role required for rollout policy mutation', {
              reason_code: 'partner_admin_required',
              actor,
              admin_allowlist: [...parsePartnerProgramAdminAllowlist()].sort()
            })
          };
        }

        const policyBody = requestBody?.policy;
        if (!isObject(policyBody)) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'policy object is required', {})
          };
        }

        const allowlistParsed = normalizeRolloutPolicyAllowlistInput(policyBody.allowlist);
        if (!allowlistParsed.ok) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid rollout allowlist', allowlistParsed.error)
          };
        }

        const minPlanParsed = normalizeRolloutMinPlanInput(policyBody.min_plan_id);
        if (!minPlanParsed.ok) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid rollout minimum plan', minPlanParsed.error)
          };
        }

        const occurredAtIso = occurredAt ?? requestBody?.occurred_at ?? new Date().toISOString();
        if (parseIsoMs(occurredAtIso) === null) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid occurred_at timestamp', {
              occurred_at: occurredAtIso
            })
          };
        }

        const rolloutState = ensureVaultExportRolloutPolicyState(this.store);
        const auditState = ensureVaultExportRolloutPolicyAuditState(this.store);

        const previousPolicy = normalizeStoredPolicyForAudit(rolloutState.vault_reconciliation_export);
        const nextVersion = previousPolicy.version + 1;

        const nextPolicy = {
          allowlist: allowlistParsed.allowlist,
          min_plan_id: minPlanParsed.min_plan_id,
          updated_at: occurredAtIso,
          updated_by: normalizeActorRef(actor),
          version: nextVersion
        };

        rolloutState.vault_reconciliation_export = nextPolicy;

        const auditEntry = {
          audit_id: makeAuditId(nextVersion),
          operation_id: 'partnerProgram.vault_export.rollout_policy.upsert',
          occurred_at: occurredAtIso,
          actor: normalizeActorRef(actor),
          policy_before: {
            allowlist: previousPolicy.allowlist,
            min_plan_id: previousPolicy.min_plan_id,
            version: previousPolicy.version
          },
          policy_after: {
            allowlist: nextPolicy.allowlist,
            min_plan_id: nextPolicy.min_plan_id,
            version: nextPolicy.version
          },
          change_summary: {
            allowlist_changed: JSON.stringify(previousPolicy.allowlist) !== JSON.stringify(nextPolicy.allowlist),
            min_plan_changed: previousPolicy.min_plan_id !== nextPolicy.min_plan_id
          }
        };

        auditState.push(auditEntry);

        const resolved = resolveVaultExportRolloutPolicy({ store: this.store });
        if (!resolved.ok) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'rollout policy configuration became invalid', {
              reason_code: resolved.error?.reason_code ?? 'partner_rollout_config_invalid'
            })
          };
        }

        return {
          ok: true,
          body: {
            correlation_id: correlationId,
            policy: vaultExportRolloutPolicyView({ policy: resolved.policy }),
            audit_entry: auditEntry
          }
        };
      }
    });
  }

  getVaultExportRolloutPolicy({ actor, auth }) {
    const correlationId = correlationIdForRolloutPolicy();

    const authz = authorizeApiOperation({ operationId: 'partnerProgram.vault_export.rollout_policy.get', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const resolved = resolveVaultExportRolloutPolicy({ store: this.store });
    if (!resolved.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'rollout policy configuration is invalid', {
          reason_code: resolved.error?.reason_code ?? 'partner_rollout_config_invalid',
          ...resolved.error
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        policy: vaultExportRolloutPolicyView({ policy: resolved.policy })
      }
    };
  }

  exportVaultExportRolloutPolicyAudit({ actor, auth, query }) {
    const correlationId = correlationIdForRolloutPolicyAuditExport();

    const authz = authorizeApiOperation({ operationId: 'partnerProgram.vault_export.rollout_policy_audit.export', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    if (!isPartnerProgramAdminActor(actor)) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'FORBIDDEN', 'partner admin role required for rollout policy audit export', {
          reason_code: 'partner_admin_required',
          actor,
          admin_allowlist: [...parsePartnerProgramAdminAllowlist()].sort()
        })
      };
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    if (fromIso && fromMs === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid from_iso filter', { from_iso: fromIso })
      };
    }

    const toMs = toIso ? parseIsoMs(toIso) : null;
    if (toIso && toMs === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid to_iso filter', { to_iso: toIso })
      };
    }

    if (fromMs !== null && toMs !== null && fromMs > toMs) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'from_iso cannot be later than to_iso', {
          from_iso: fromIso,
          to_iso: toIso
        })
      };
    }

    const auditState = ensureVaultExportRolloutPolicyAuditState(this.store);
    let entries = auditState
      .map(entry => ({
        entry,
        ts: parseIsoMs(entry?.occurred_at)
      }))
      .filter(x => x.ts !== null);

    if (fromMs !== null) entries = entries.filter(x => x.ts >= fromMs);
    if (toMs !== null) entries = entries.filter(x => x.ts <= toMs);

    entries.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return String(a.entry?.audit_id ?? '').localeCompare(String(b.entry?.audit_id ?? ''));
    });

    let orderedEntries = entries.map(x => x.entry);

    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    if (cursorAfter) {
      const idx = orderedEntries.findIndex(entry => entry?.audit_id === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'cursor_after not found in audit result set', {
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

    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    if (cursorAfter && !attestationAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'attestation_after is required when cursor_after is provided', {
          cursor_after: cursorAfter,
          attestation_after: query?.attestation_after ?? null
        })
      };
    }

    if (!cursorAfter && attestationAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'attestation_after is only allowed with cursor_after', {
          cursor_after: query?.cursor_after ?? null,
          attestation_after: attestationAfter
        })
      };
    }

    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
    const checkpointRequired = rolloutPolicyAuditExportCheckpointEnforced();
    const checkpointState = ensurePartnerProgramRolloutPolicyExportCheckpointState(this.store);
    const checkpointContext = checkpointContextFromPartnerProgramRolloutPolicyExportQuery({ query });
    const checkpointContextFingerprint = checkpointContextKey(checkpointContext);
    const checkpointNowIso = nowIsoForPartnerProgramRolloutPolicyExportCheckpointRetention(query);
    const checkpointNowMs = parseIsoMs(checkpointNowIso);

    if (checkpointRequired && checkpointNowMs === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid now_iso for rollout policy export checkpoint retention', {
          now_iso: checkpointNowIso
        })
      };
    }

    if (checkpointRequired && cursorAfter && !checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is required when cursor_after is provided', {
          cursor_after: cursorAfter,
          checkpoint_after: query?.checkpoint_after ?? null
        })
      };
    }

    if (checkpointRequired && !cursorAfter && checkpointAfter) {
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

    if (checkpointRequired && cursorAfter) {
      const priorCheckpoint = checkpointState[checkpointAfter] ?? null;
      if (!priorCheckpoint) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after not found for rollout policy export continuation', {
            reason_code: 'checkpoint_after_not_found',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (isPartnerProgramRolloutPolicyExportCheckpointExpired({ checkpointRecord: priorCheckpoint, nowMs: checkpointNowMs })) {
        delete checkpointState[checkpointAfter];
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after expired for rollout policy export continuation', {
            reason_code: 'checkpoint_expired',
            checkpoint_after: checkpointAfter,
            exported_at: priorCheckpoint.exported_at ?? null,
            now_iso: checkpointNowIso,
            retention_days: partnerProgramRolloutPolicyExportCheckpointRetentionDays()
          })
        };
      }

      if (priorCheckpoint.next_cursor !== cursorAfter) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'cursor_after does not match checkpoint continuation cursor', {
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
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'rollout policy audit export continuation query does not match checkpoint context', {
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
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid exported_at timestamp for rollout policy audit export', {
          exported_at_iso: query?.exported_at_iso ?? null,
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const resolved = resolveVaultExportRolloutPolicy({ store: this.store });
    if (!resolved.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'rollout policy configuration is invalid', {
          reason_code: resolved.error?.reason_code ?? 'partner_rollout_config_invalid',
          ...resolved.error
        })
      };
    }

    const withAttestation = Boolean(limit || cursorAfter || attestationAfter);
    const withCheckpoint = checkpointRequired && withAttestation;

    const signedPayload = buildSignedPartnerProgramRolloutPolicyAuditExportPayload({
      exportedAt,
      query,
      policy: vaultExportRolloutPolicyView({ policy: resolved.policy }),
      entries: orderedEntries,
      totalFiltered,
      nextCursor,
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
    }

    if (checkpointRequired) {
      pruneExpiredPartnerProgramRolloutPolicyExportCheckpoints({ checkpointState, nowMs: checkpointNowMs });
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
