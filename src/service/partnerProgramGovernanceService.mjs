import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { authorizeApiOperation } from '../core/authz.mjs';
import {
  buildSignedPartnerProgramRolloutPolicyAuditExportPayload,
  buildSignedPartnerProgramRolloutPolicyDiagnosticsExportPayload
} from '../crypto/policyIntegritySigning.mjs';
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

function correlationIdForRolloutPolicyDiagnosticsExport() {
  return 'corr_partner_program_vault_export_rollout_policy_diagnostics_export';
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

function parseOptionalBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  }
  return null;
}

function parseOptionalInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return null;
  return n;
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
      updated_by: null,
      controls: {
        maintenance_mode_enabled: false,
        maintenance_reason_code: null,
        freeze_until: null,
        freeze_reason_code: null,
        last_admin_action_at: null,
        last_admin_action_by: null
      }
    };
  }

  const allowlist = Array.isArray(policy.allowlist)
    ? Array.from(new Set(policy.allowlist.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))).sort()
    : [];

  const controls = isObject(policy.controls)
    ? {
        maintenance_mode_enabled: policy.controls.maintenance_mode_enabled === true,
        maintenance_reason_code: normalizeOptionalString(policy.controls.maintenance_reason_code),
        freeze_until: normalizeOptionalString(policy.controls.freeze_until),
        freeze_reason_code: normalizeOptionalString(policy.controls.freeze_reason_code),
        last_admin_action_at: normalizeOptionalString(policy.controls.last_admin_action_at),
        last_admin_action_by: normalizeActorRef(policy.controls.last_admin_action_by)
      }
    : {
        maintenance_mode_enabled: false,
        maintenance_reason_code: null,
        freeze_until: null,
        freeze_reason_code: null,
        last_admin_action_at: null,
        last_admin_action_by: null
      };

  return {
    allowlist,
    min_plan_id: typeof policy.min_plan_id === 'string' && policy.min_plan_id.trim() ? policy.min_plan_id.trim().toLowerCase() : null,
    version: Number.isFinite(policy.version) ? Number(policy.version) : 0,
    updated_at: normalizeOptionalString(policy.updated_at),
    updated_by: normalizeActorRef(policy.updated_by),
    controls
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

function rolloutPolicyDiagnosticsExportCheckpointEnforced() {
  return process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_DIAGNOSTICS_EXPORT_CHECKPOINT_ENFORCE === '1';
}

function partnerProgramRolloutPolicyDiagnosticsExportCheckpointRetentionDays() {
  const raw = Number.parseInt(String(process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_DIAGNOSTICS_EXPORT_CHECKPOINT_RETENTION_DAYS ?? ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(raw, 3650);
}

function partnerProgramRolloutPolicyDiagnosticsExportCheckpointRetentionWindowMs() {
  return partnerProgramRolloutPolicyDiagnosticsExportCheckpointRetentionDays() * 24 * 60 * 60 * 1000;
}

function settlementVaultExportCheckpointEnforced() {
  return process.env.SETTLEMENT_VAULT_EXPORT_CHECKPOINT_ENFORCE === '1';
}

function settlementVaultExportCheckpointRetentionDays() {
  const raw = Number.parseInt(String(process.env.SETTLEMENT_VAULT_EXPORT_CHECKPOINT_RETENTION_DAYS ?? ''), 10);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(raw, 3650);
}

function partnerProgramEnforced() {
  return process.env.SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE === '1';
}

function freezeExportEnforced() {
  return process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_FREEZE_EXPORT_ENFORCE === '1';
}

function nowIsoForPartnerProgramRolloutPolicyExportCheckpointRetention(query) {
  return query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function nowIsoForPartnerProgramRolloutPolicyDiagnosticsExportCheckpointRetention(query) {
  return query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function ensurePartnerProgramRolloutPolicyExportCheckpointState(store) {
  store.state.partner_program_rollout_policy_export_checkpoints ||= {};
  return store.state.partner_program_rollout_policy_export_checkpoints;
}

function ensurePartnerProgramRolloutPolicyDiagnosticsExportCheckpointState(store) {
  store.state.partner_program_rollout_policy_diagnostics_export_checkpoints ||= {};
  return store.state.partner_program_rollout_policy_diagnostics_export_checkpoints;
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

function isPartnerProgramRolloutPolicyDiagnosticsExportCheckpointExpired({ checkpointRecord, nowMs }) {
  if (!checkpointRecord || typeof checkpointRecord !== 'object') return true;
  const exportedAtMs = parseIsoMs(checkpointRecord.exported_at);
  if (exportedAtMs === null) return true;
  return nowMs > (exportedAtMs + partnerProgramRolloutPolicyDiagnosticsExportCheckpointRetentionWindowMs());
}

function pruneExpiredPartnerProgramRolloutPolicyDiagnosticsExportCheckpoints({ checkpointState, nowMs }) {
  if (!checkpointState || typeof checkpointState !== 'object') return;
  for (const [checkpointHash, checkpointRecord] of Object.entries(checkpointState)) {
    if (isPartnerProgramRolloutPolicyDiagnosticsExportCheckpointExpired({ checkpointRecord, nowMs })) {
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

function checkpointContextFromPartnerProgramRolloutPolicyDiagnosticsExportQuery({ query }) {
  return {
    include_recommended_actions: parseOptionalBoolean(query?.include_recommended_actions) !== false,
    include_runbook_hooks: parseOptionalBoolean(query?.include_runbook_hooks) !== false,
    include_automation_hints: parseOptionalBoolean(query?.include_automation_hints) === true,
    maintenance_stale_after_minutes: parseOptionalInteger(query?.maintenance_stale_after_minutes),
    freeze_expiring_soon_minutes: parseOptionalInteger(query?.freeze_expiring_soon_minutes),
    automation_max_actions: parseOptionalInteger(query?.automation_max_actions)
  };
}

function normalizeDiagnosticsAlertThresholdMinutes({
  value,
  defaultValue,
  min = 1,
  max = 10080,
  fieldName
}) {
  if (value === null || value === undefined || value === '') return { ok: true, value: defaultValue };
  const parsed = parseOptionalInteger(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_diagnostics_threshold_invalid',
        field: fieldName,
        value,
        min,
        max
      }
    };
  }
  return { ok: true, value: parsed };
}

function normalizeDiagnosticsAutomationMaxActions({ value, defaultValue = 2, min = 1, max = 10 }) {
  if (value === null || value === undefined || value === '') return { ok: true, value: defaultValue };
  const parsed = parseOptionalInteger(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_diagnostics_automation_invalid',
        field: 'automation_max_actions',
        value,
        min,
        max
      }
    };
  }
  return { ok: true, value: parsed };
}

function diagnosticsLifecycleSignals({ policy, nowIso }) {
  const nowMs = parseIsoMs(nowIso);

  let maintenanceModeAgeMinutes = null;
  if (policy?.controls?.maintenance_mode_enabled && nowMs !== null) {
    const lastAdminActionAtMs = parseIsoMs(policy?.controls?.last_admin_action_at);
    if (lastAdminActionAtMs !== null) {
      maintenanceModeAgeMinutes = Math.max(0, Math.floor((nowMs - lastAdminActionAtMs) / 60000));
    }
  }

  const freezeUntil = normalizeOptionalString(policy?.controls?.freeze_until);
  let freezeWindowRemainingMinutes = null;
  if (freezeUntil && nowMs !== null) {
    const freezeUntilMs = parseIsoMs(freezeUntil);
    if (freezeUntilMs !== null) {
      freezeWindowRemainingMinutes = Math.ceil((freezeUntilMs - nowMs) / 60000);
    }
  }

  let freezeWindowRemainingBucket = 'none';
  if (freezeWindowRemainingMinutes !== null) {
    if (freezeWindowRemainingMinutes < 0) freezeWindowRemainingBucket = 'expired';
    else if (freezeWindowRemainingMinutes <= 15) freezeWindowRemainingBucket = 'critical';
    else if (freezeWindowRemainingMinutes <= 60) freezeWindowRemainingBucket = 'warning';
    else freezeWindowRemainingBucket = 'stable';
  }

  return {
    maintenance_mode_age_minutes: maintenanceModeAgeMinutes,
    freeze_window_remaining_minutes: freezeWindowRemainingMinutes,
    freeze_window_remaining_bucket: freezeWindowRemainingBucket
  };
}

function buildRolloutPolicyDiagnosticsAlerts({
  policy,
  lifecycleSignals,
  maintenanceStaleAfterMinutes,
  freezeExpiringSoonMinutes
}) {
  const out = [];

  if (
    policy?.controls?.maintenance_mode_enabled &&
    Number.isFinite(lifecycleSignals?.maintenance_mode_age_minutes) &&
    lifecycleSignals.maintenance_mode_age_minutes >= maintenanceStaleAfterMinutes
  ) {
    out.push({
      code: 'maintenance_mode_stale',
      severity: 'warning',
      reason_code: 'maintenance_mode_active',
      details: {
        maintenance_mode_age_minutes: lifecycleSignals.maintenance_mode_age_minutes,
        threshold_minutes: maintenanceStaleAfterMinutes
      }
    });
  }

  if (
    policy?.controls?.freeze_active === true &&
    Number.isFinite(lifecycleSignals?.freeze_window_remaining_minutes) &&
    lifecycleSignals.freeze_window_remaining_minutes >= 0 &&
    lifecycleSignals.freeze_window_remaining_minutes <= freezeExpiringSoonMinutes
  ) {
    out.push({
      code: 'freeze_window_expiring_soon',
      severity: 'info',
      reason_code: 'freeze_window_active',
      details: {
        freeze_window_remaining_minutes: lifecycleSignals.freeze_window_remaining_minutes,
        threshold_minutes: freezeExpiringSoonMinutes,
        freeze_until: policy?.controls?.freeze_until ?? null
      }
    });
  }

  return out;
}

function buildRolloutPolicyDiagnosticsAutomationHints({ recommendedActions, alerts, runbookHooks, maxActions, policyVersion }) {
  const queue = [];
  const actionRequests = [];
  const seen = new Set();
  const runbookHookIndex = new Map((runbookHooks ?? []).map(hook => [hook?.hook_id, hook]));

  for (const action of recommendedActions ?? []) {
    const hookId = normalizeOptionalString(action?.runbook_hook_id);
    if (!hookId || hookId === 'observe_only' || seen.has(hookId)) continue;
    seen.add(hookId);

    const reasonCode = normalizeOptionalString(action?.reason_code) ?? 'no_action_required';
    const priority = reasonCode === 'maintenance_mode_active' || reasonCode === 'freeze_window_active'
      ? 'high'
      : 'normal';

    queue.push({
      hook_id: hookId,
      reason_code: reasonCode,
      priority
    });

    const hookTemplate = runbookHookIndex.get(hookId);
    const step = queue.length;
    const version = Number.isFinite(policyVersion) ? Number(policyVersion) : 0;
    const operationId = normalizeOptionalString(hookTemplate?.operation_id) ?? 'partnerProgram.vault_export.rollout_policy.admin_action';
    const actionTemplate = clone(hookTemplate?.action ?? { action_type: 'observe' });

    actionRequests.push({
      step,
      hook_id: hookId,
      operation_id: operationId,
      idempotency_key_template: `diag_auto_v${version}_${String(step).padStart(2, '0')}_${hookId}`,
      request_hash: payloadHash({ operation_id: operationId, action: actionTemplate }),
      request: {
        action: actionTemplate
      }
    });

    if (queue.length >= maxActions) break;
  }

  const sourceAlertCodes = (alerts ?? []).map(alert => alert?.code).filter(x => typeof x === 'string' && x);
  const safety = {
    idempotency_required: true,
    idempotency_scope: 'partnerProgram.vault_export.rollout_policy.admin_action',
    max_actions_per_run: maxActions
  };

  const planHash = payloadHash({
    source_alert_codes: sourceAlertCodes,
    action_queue: queue,
    action_requests: actionRequests.map(request => ({
      step: request.step,
      hook_id: request.hook_id,
      operation_id: request.operation_id,
      idempotency_key_template: request.idempotency_key_template,
      request_hash: request.request_hash
    })),
    safety
  });

  return {
    requires_operator_confirmation: queue.length > 0,
    source_alert_codes: sourceAlertCodes,
    action_queue: queue,
    action_requests: actionRequests,
    plan_hash: planHash,
    safety
  };
}

function checkpointContextKey(context) {
  return JSON.stringify(context);
}

function freezeActiveFromControls({ controls, nowIso }) {
  const freezeUntil = normalizeOptionalString(controls?.freeze_until);
  if (!freezeUntil) return false;
  const freezeMs = parseIsoMs(freezeUntil);
  if (freezeMs === null) return false;
  const nowMs = parseIsoMs(nowIso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString());
  if (nowMs === null) return false;
  return nowMs <= freezeMs;
}

function controlsForAudit(controls) {
  return {
    maintenance_mode_enabled: controls?.maintenance_mode_enabled === true,
    maintenance_reason_code: controls?.maintenance_reason_code ?? null,
    freeze_until: controls?.freeze_until ?? null,
    freeze_reason_code: controls?.freeze_reason_code ?? null
  };
}

function buildRolloutPolicyDiagnosticsOverlays() {
  return {
    partner_program_enforced: partnerProgramEnforced(),
    settlement_export_checkpoint_enforced: settlementVaultExportCheckpointEnforced(),
    settlement_export_checkpoint_retention_days: settlementVaultExportCheckpointRetentionDays(),
    rollout_policy_audit_checkpoint_enforced: rolloutPolicyAuditExportCheckpointEnforced(),
    rollout_policy_audit_checkpoint_retention_days: partnerProgramRolloutPolicyExportCheckpointRetentionDays(),
    rollout_policy_diagnostics_checkpoint_enforced: rolloutPolicyDiagnosticsExportCheckpointEnforced(),
    rollout_policy_diagnostics_checkpoint_retention_days: partnerProgramRolloutPolicyDiagnosticsExportCheckpointRetentionDays(),
    freeze_export_enforced: freezeExportEnforced(),
    admin_allowlist: [...parsePartnerProgramAdminAllowlist()].sort()
  };
}

function buildRolloutPolicyDiagnosticsRecommendedActions({ policy }) {
  const out = [];

  if (policy?.controls?.maintenance_mode_enabled) {
    out.push({
      code: 'clear_maintenance_mode',
      reason_code: 'maintenance_mode_active',
      runbook_hook_id: 'disable_maintenance_mode',
      details: {
        maintenance_reason_code: policy?.controls?.maintenance_reason_code ?? null
      }
    });
  }

  if (policy?.controls?.freeze_active) {
    out.push({
      code: 'clear_freeze_window',
      reason_code: 'freeze_window_active',
      runbook_hook_id: 'clear_freeze_window',
      details: {
        freeze_until: policy?.controls?.freeze_until ?? null,
        freeze_reason_code: policy?.controls?.freeze_reason_code ?? null
      }
    });
  }

  if (out.length === 0) {
    out.push({
      code: 'none',
      reason_code: 'no_action_required',
      runbook_hook_id: 'observe_only',
      details: {}
    });
  }

  return out;
}

function buildRolloutPolicyDiagnosticsRunbookHooks() {
  return [
    {
      hook_id: 'disable_maintenance_mode',
      operation_id: 'partnerProgram.vault_export.rollout_policy.admin_action',
      action: {
        action_type: 'set_maintenance_mode',
        maintenance_mode_enabled: false
      }
    },
    {
      hook_id: 'clear_freeze_window',
      operation_id: 'partnerProgram.vault_export.rollout_policy.admin_action',
      action: {
        action_type: 'set_freeze_window',
        freeze_until: null
      }
    },
    {
      hook_id: 'clear_controls',
      operation_id: 'partnerProgram.vault_export.rollout_policy.admin_action',
      action: {
        action_type: 'clear_controls'
      }
    },
    {
      hook_id: 'observe_only',
      operation_id: 'partnerProgram.vault_export.rollout_policy.diagnostics.export',
      action: {
        action_type: 'observe'
      }
    }
  ];
}

function applyAdminActionToControls({ controls, action, actor, occurredAtIso }) {
  const next = {
    maintenance_mode_enabled: controls?.maintenance_mode_enabled === true,
    maintenance_reason_code: controls?.maintenance_reason_code ?? null,
    freeze_until: controls?.freeze_until ?? null,
    freeze_reason_code: controls?.freeze_reason_code ?? null,
    last_admin_action_at: occurredAtIso,
    last_admin_action_by: normalizeActorRef(actor)
  };

  if (!isObject(action)) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_admin_action_invalid',
        message: 'action object is required'
      }
    };
  }

  const actionType = normalizeOptionalString(action.action_type);
  if (!actionType) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_admin_action_invalid',
        message: 'action.action_type is required'
      }
    };
  }

  if (actionType === 'set_maintenance_mode') {
    if (typeof action.maintenance_mode_enabled !== 'boolean') {
      return {
        ok: false,
        error: {
          reason_code: 'partner_rollout_admin_action_invalid',
          message: 'maintenance_mode_enabled boolean is required for set_maintenance_mode'
        }
      };
    }

    next.maintenance_mode_enabled = action.maintenance_mode_enabled;
    next.maintenance_reason_code = action.maintenance_mode_enabled
      ? (normalizeOptionalString(action.maintenance_reason_code) ?? 'maintenance_mode_enabled')
      : null;

    return {
      ok: true,
      action_type: actionType,
      next,
      audit_action: {
        action_type: actionType,
        maintenance_mode_enabled: next.maintenance_mode_enabled,
        maintenance_reason_code: next.maintenance_reason_code
      }
    };
  }

  if (actionType === 'set_freeze_window') {
    const freezeUntil = normalizeOptionalString(action.freeze_until);
    const freezeReason = normalizeOptionalString(action.freeze_reason_code);

    if (freezeUntil && parseIsoMs(freezeUntil) === null) {
      return {
        ok: false,
        error: {
          reason_code: 'partner_rollout_admin_action_invalid',
          message: 'freeze_until must be a valid date-time or null',
          freeze_until: freezeUntil
        }
      };
    }

    next.freeze_until = freezeUntil;
    next.freeze_reason_code = freezeUntil ? (freezeReason ?? 'manual_freeze') : null;

    return {
      ok: true,
      action_type: actionType,
      next,
      audit_action: {
        action_type: actionType,
        freeze_until: next.freeze_until,
        freeze_reason_code: next.freeze_reason_code
      }
    };
  }

  if (actionType === 'clear_controls') {
    next.maintenance_mode_enabled = false;
    next.maintenance_reason_code = null;
    next.freeze_until = null;
    next.freeze_reason_code = null;

    return {
      ok: true,
      action_type: actionType,
      next,
      audit_action: {
        action_type: actionType
      }
    };
  }

  return {
    ok: false,
    error: {
      reason_code: 'partner_rollout_admin_action_invalid',
      message: 'unsupported action_type',
      action_type: actionType
    }
  };
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
    ensurePartnerProgramRolloutPolicyDiagnosticsExportCheckpointState(this.store);
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
        const freezeActive = freezeActiveFromControls({ controls: previousPolicy.controls, nowIso: occurredAtIso });
        if (freezeActive) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'rollout policy is frozen for updates', {
              reason_code: 'partner_rollout_frozen',
              freeze_until: previousPolicy.controls.freeze_until,
              freeze_reason_code: previousPolicy.controls.freeze_reason_code
            })
          };
        }

        const nextVersion = previousPolicy.version + 1;

        const nextPolicy = {
          allowlist: allowlistParsed.allowlist,
          min_plan_id: minPlanParsed.min_plan_id,
          updated_at: occurredAtIso,
          updated_by: normalizeActorRef(actor),
          version: nextVersion,
          controls: {
            ...previousPolicy.controls
          }
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
            version: previousPolicy.version,
            controls: controlsForAudit(previousPolicy.controls)
          },
          policy_after: {
            allowlist: nextPolicy.allowlist,
            min_plan_id: nextPolicy.min_plan_id,
            version: nextPolicy.version,
            controls: controlsForAudit(nextPolicy.controls)
          },
          change_summary: {
            allowlist_changed: JSON.stringify(previousPolicy.allowlist) !== JSON.stringify(nextPolicy.allowlist),
            min_plan_changed: previousPolicy.min_plan_id !== nextPolicy.min_plan_id,
            maintenance_mode_changed: previousPolicy.controls.maintenance_mode_enabled !== nextPolicy.controls.maintenance_mode_enabled,
            freeze_window_changed:
              previousPolicy.controls.freeze_until !== nextPolicy.controls.freeze_until ||
              previousPolicy.controls.freeze_reason_code !== nextPolicy.controls.freeze_reason_code
          }
        };

        auditState.push(auditEntry);

        const resolved = resolveVaultExportRolloutPolicy({ store: this.store, nowIso: occurredAtIso });
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

  adminActionVaultExportRolloutPolicy({ actor, auth, idempotencyKey, requestBody, occurredAt }) {
    const correlationId = correlationIdForRolloutPolicy();

    const authz = authorizeApiOperation({ operationId: 'partnerProgram.vault_export.rollout_policy.admin_action', actor, auth, store: this.store });
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
      operationId: 'partnerProgram.vault_export.rollout_policy.admin_action',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        if (!isPartnerProgramAdminActor(actor)) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'partner admin role required for rollout policy admin actions', {
              reason_code: 'partner_admin_required',
              actor,
              admin_allowlist: [...parsePartnerProgramAdminAllowlist()].sort()
            })
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
        const actionApplied = applyAdminActionToControls({
          controls: previousPolicy.controls,
          action: requestBody?.action,
          actor,
          occurredAtIso
        });
        if (!actionApplied.ok) {
          return {
            ok: false,
            body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid rollout policy admin action', actionApplied.error)
          };
        }

        const nextVersion = previousPolicy.version + 1;
        const nextPolicy = {
          allowlist: previousPolicy.allowlist,
          min_plan_id: previousPolicy.min_plan_id,
          updated_at: occurredAtIso,
          updated_by: normalizeActorRef(actor),
          version: nextVersion,
          controls: {
            ...actionApplied.next
          }
        };

        rolloutState.vault_reconciliation_export = nextPolicy;

        const auditEntry = {
          audit_id: makeAuditId(nextVersion),
          operation_id: 'partnerProgram.vault_export.rollout_policy.admin_action',
          occurred_at: occurredAtIso,
          actor: normalizeActorRef(actor),
          policy_before: {
            allowlist: previousPolicy.allowlist,
            min_plan_id: previousPolicy.min_plan_id,
            version: previousPolicy.version,
            controls: controlsForAudit(previousPolicy.controls)
          },
          policy_after: {
            allowlist: nextPolicy.allowlist,
            min_plan_id: nextPolicy.min_plan_id,
            version: nextPolicy.version,
            controls: controlsForAudit(nextPolicy.controls)
          },
          change_summary: {
            allowlist_changed: false,
            min_plan_changed: false,
            maintenance_mode_changed: previousPolicy.controls.maintenance_mode_enabled !== nextPolicy.controls.maintenance_mode_enabled ||
              previousPolicy.controls.maintenance_reason_code !== nextPolicy.controls.maintenance_reason_code,
            freeze_window_changed:
              previousPolicy.controls.freeze_until !== nextPolicy.controls.freeze_until ||
              previousPolicy.controls.freeze_reason_code !== nextPolicy.controls.freeze_reason_code
          },
          admin_action: actionApplied.audit_action
        };

        auditState.push(auditEntry);

        const resolved = resolveVaultExportRolloutPolicy({ store: this.store, nowIso: occurredAtIso });
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

    const resolved = resolveVaultExportRolloutPolicy({
      store: this.store,
      nowIso: auth?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString()
    });
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

  exportVaultExportRolloutPolicyDiagnostics({ actor, auth, query }) {
    const correlationId = correlationIdForRolloutPolicyDiagnosticsExport();

    const authz = authorizeApiOperation({ operationId: 'partnerProgram.vault_export.rollout_policy.diagnostics.export', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    if (!isPartnerProgramAdminActor(actor)) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'FORBIDDEN', 'partner admin role required for rollout policy diagnostics export', {
          reason_code: 'partner_admin_required',
          actor,
          admin_allowlist: [...parsePartnerProgramAdminAllowlist()].sort()
        })
      };
    }

    const nowIso = query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    if (parseIsoMs(nowIso) === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid now_iso for rollout policy diagnostics export', {
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const exportedAt = query?.exported_at_iso ?? nowIso;
    if (parseIsoMs(exportedAt) === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid exported_at timestamp for rollout policy diagnostics export', {
          exported_at_iso: query?.exported_at_iso ?? null,
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const includeRecommendedActions = parseOptionalBoolean(query?.include_recommended_actions) !== false;
    const includeRunbookHooks = parseOptionalBoolean(query?.include_runbook_hooks) !== false;
    const includeAutomationHints = parseOptionalBoolean(query?.include_automation_hints) === true;

    if (includeAutomationHints && !includeRunbookHooks) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'automation hints require runbook hooks in diagnostics export', {
          reason_code: 'partner_rollout_diagnostics_automation_requires_runbook_hooks',
          field: 'include_runbook_hooks',
          include_automation_hints: true,
          include_runbook_hooks: false
        })
      };
    }

    const automationMaxActionsParsed = normalizeDiagnosticsAutomationMaxActions({
      value: query?.automation_max_actions,
      defaultValue: 2
    });
    if (includeAutomationHints && !automationMaxActionsParsed.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid diagnostics automation parameter', automationMaxActionsParsed.error)
      };
    }
    const automationMaxActions = automationMaxActionsParsed.value;

    const maintenanceStaleThresholdParsed = normalizeDiagnosticsAlertThresholdMinutes({
      value: query?.maintenance_stale_after_minutes,
      defaultValue: 60,
      fieldName: 'maintenance_stale_after_minutes'
    });
    if (!maintenanceStaleThresholdParsed.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid diagnostics threshold', maintenanceStaleThresholdParsed.error)
      };
    }

    const freezeExpiringThresholdParsed = normalizeDiagnosticsAlertThresholdMinutes({
      value: query?.freeze_expiring_soon_minutes,
      defaultValue: 15,
      fieldName: 'freeze_expiring_soon_minutes'
    });
    if (!freezeExpiringThresholdParsed.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid diagnostics threshold', freezeExpiringThresholdParsed.error)
      };
    }

    const maintenanceStaleAfterMinutes = maintenanceStaleThresholdParsed.value;
    const freezeExpiringSoonMinutes = freezeExpiringThresholdParsed.value;

    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
    const checkpointRequired = rolloutPolicyDiagnosticsExportCheckpointEnforced();
    const checkpointState = ensurePartnerProgramRolloutPolicyDiagnosticsExportCheckpointState(this.store);
    const checkpointContext = checkpointContextFromPartnerProgramRolloutPolicyDiagnosticsExportQuery({ query });
    const checkpointContextFingerprint = checkpointContextKey(checkpointContext);
    const checkpointNowIso = nowIsoForPartnerProgramRolloutPolicyDiagnosticsExportCheckpointRetention(query);
    const checkpointNowMs = parseIsoMs(checkpointNowIso);

    if (checkpointRequired && checkpointNowMs === null) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'invalid now_iso for rollout diagnostics export checkpoint retention', {
          now_iso: checkpointNowIso
        })
      };
    }

    if (checkpointRequired && attestationAfter && !checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is required when attestation_after is provided', {
          attestation_after: attestationAfter,
          checkpoint_after: query?.checkpoint_after ?? null
        })
      };
    }

    if (checkpointRequired && !attestationAfter && checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after is only allowed with attestation_after', {
          attestation_after: query?.attestation_after ?? null,
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

    if (checkpointRequired && attestationAfter) {
      const priorCheckpoint = checkpointState[checkpointAfter] ?? null;
      if (!priorCheckpoint) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after not found for rollout diagnostics export continuation', {
            reason_code: 'checkpoint_after_not_found',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (isPartnerProgramRolloutPolicyDiagnosticsExportCheckpointExpired({ checkpointRecord: priorCheckpoint, nowMs: checkpointNowMs })) {
        delete checkpointState[checkpointAfter];
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'checkpoint_after expired for rollout diagnostics export continuation', {
            reason_code: 'checkpoint_expired',
            checkpoint_after: checkpointAfter,
            exported_at: priorCheckpoint.exported_at ?? null,
            now_iso: checkpointNowIso,
            retention_days: partnerProgramRolloutPolicyDiagnosticsExportCheckpointRetentionDays()
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
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'rollout diagnostics export continuation query does not match checkpoint context', {
            reason_code: 'checkpoint_query_mismatch',
            checkpoint_after: checkpointAfter,
            expected_context: priorCheckpoint.query_context ?? null,
            provided_context: checkpointContext
          })
        };
      }
    }

    const resolved = resolveVaultExportRolloutPolicy({ store: this.store, nowIso });
    if (!resolved.ok) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'rollout policy configuration is invalid', {
          reason_code: resolved.error?.reason_code ?? 'partner_rollout_config_invalid',
          ...resolved.error
        })
      };
    }

    const policyView = vaultExportRolloutPolicyView({ policy: resolved.policy });
    const overlays = buildRolloutPolicyDiagnosticsOverlays();
    const lifecycleSignals = diagnosticsLifecycleSignals({ policy: policyView, nowIso });
    const alerts = buildRolloutPolicyDiagnosticsAlerts({
      policy: policyView,
      lifecycleSignals,
      maintenanceStaleAfterMinutes,
      freezeExpiringSoonMinutes
    });

    const recommendedActions = includeRecommendedActions
      ? buildRolloutPolicyDiagnosticsRecommendedActions({ policy: policyView })
      : [];
    const runbookHooks = includeRunbookHooks
      ? buildRolloutPolicyDiagnosticsRunbookHooks()
      : [];
    const automationHints = includeAutomationHints
      ? buildRolloutPolicyDiagnosticsAutomationHints({
          recommendedActions,
          alerts,
          runbookHooks,
          maxActions: automationMaxActions,
          policyVersion: policyView?.version ?? 0
        })
      : null;

    const withAttestation = checkpointRequired || Boolean(attestationAfter);
    const withCheckpoint = checkpointRequired && withAttestation;

    const signedPayload = buildSignedPartnerProgramRolloutPolicyDiagnosticsExportPayload({
      exportedAt,
      query,
      policy: policyView,
      overlays,
      lifecycleSignals,
      alerts,
      recommendedActions,
      runbookHooks,
      automationHints,
      withAttestation,
      withCheckpoint
    });

    if (checkpointRequired && signedPayload?.checkpoint?.checkpoint_hash) {
      checkpointState[signedPayload.checkpoint.checkpoint_hash] = {
        checkpoint_hash: signedPayload.checkpoint.checkpoint_hash,
        checkpoint_after: signedPayload.checkpoint.checkpoint_after ?? null,
        attestation_chain_hash: signedPayload.attestation?.chain_hash ?? null,
        query_context_fingerprint: checkpointContextFingerprint,
        query_context: checkpointContext,
        exported_at: signedPayload.exported_at
      };
    }

    if (checkpointRequired) {
      pruneExpiredPartnerProgramRolloutPolicyDiagnosticsExportCheckpoints({ checkpointState, nowMs: checkpointNowMs });
    }

    return {
      ok: true,
      body: {
        correlation_id: correlationId,
        ...signedPayload
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

    const resolved = resolveVaultExportRolloutPolicy({
      store: this.store,
      nowIso: query?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString()
    });
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
