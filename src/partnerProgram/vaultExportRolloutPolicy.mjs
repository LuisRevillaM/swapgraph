function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizePlanId(planId) {
  return typeof planId === 'string' && planId.trim() ? planId.trim().toLowerCase() : null;
}

export function planRank(planId) {
  if (planId === 'starter') return 1;
  if (planId === 'pro') return 2;
  if (planId === 'enterprise') return 3;
  return null;
}

function parseAllowlistCsv(raw) {
  return Array.from(new Set(String(raw ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean))).sort();
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function parseMinPlanRequirementRaw(raw) {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) return { ok: true, min_plan_id: null };

  const normalized = normalizePlanId(trimmed);
  if (!normalized || planRank(normalized) === null) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_config_invalid',
        min_plan_id: trimmed.toLowerCase()
      }
    };
  }

  return { ok: true, min_plan_id: normalized };
}

export function ensureVaultExportRolloutPolicyState(store) {
  store.state.partner_program_rollout_policy ||= {};
  return store.state.partner_program_rollout_policy;
}

export function ensureVaultExportRolloutPolicyAuditState(store) {
  store.state.partner_program_rollout_policy_audit ||= [];
  return store.state.partner_program_rollout_policy_audit;
}

function parseStoredAllowlist(value) {
  if (value === undefined || value === null) return { ok: true, allowlist: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_config_invalid',
        allowlist_type: typeof value
      }
    };
  }

  const normalized = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return {
        ok: false,
        error: {
          reason_code: 'partner_rollout_config_invalid',
          allowlist_item: item ?? null
        }
      };
    }
    normalized.push(item.trim());
  }

  return { ok: true, allowlist: Array.from(new Set(normalized)).sort() };
}

export function normalizeRolloutPolicyAllowlistInput(value) {
  if (value === undefined || value === null) {
    return { ok: true, allowlist: [] };
  }

  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_allowlist_invalid',
        message: 'allowlist must be an array of partner ids'
      }
    };
  }

  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return {
        ok: false,
        error: {
          reason_code: 'partner_rollout_allowlist_invalid',
          message: 'allowlist must only contain non-empty string partner ids',
          invalid_item: item ?? null
        }
      };
    }
    out.push(item.trim());
  }

  const deduped = Array.from(new Set(out)).sort();
  if (deduped.length > 5000) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_allowlist_invalid',
        message: 'allowlist exceeds maximum size',
        max_size: 5000
      }
    };
  }

  return { ok: true, allowlist: deduped };
}

export function normalizeRolloutMinPlanInput(value) {
  if (value === undefined || value === null || value === '') return { ok: true, min_plan_id: null };
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_min_plan_invalid',
        message: 'min_plan_id must be null or one of starter|pro|enterprise'
      }
    };
  }

  const normalized = normalizePlanId(value);
  if (!normalized || planRank(normalized) === null) {
    return {
      ok: false,
      error: {
        reason_code: 'partner_rollout_min_plan_invalid',
        message: 'min_plan_id must be one of starter|pro|enterprise',
        provided: value
      }
    };
  }

  return { ok: true, min_plan_id: normalized };
}

export function parsePartnerProgramAdminAllowlist() {
  const raw = process.env.PARTNER_PROGRAM_ADMIN_ALLOWLIST;
  const parsed = raw === undefined ? ['ops-admin'] : parseAllowlistCsv(raw);
  return new Set(parsed);
}

export function isPartnerProgramAdminActor(actor) {
  if (actor?.type !== 'partner' || !actor?.id) return false;
  return parsePartnerProgramAdminAllowlist().has(actor.id);
}

export function resolveVaultExportRolloutPolicy({ store }) {
  const policyState = store ? ensureVaultExportRolloutPolicyState(store) : {};
  const storedPolicy = policyState?.vault_reconciliation_export;

  if (storedPolicy && typeof storedPolicy === 'object') {
    const parsedAllowlist = parseStoredAllowlist(storedPolicy.allowlist);
    if (!parsedAllowlist.ok) {
      return {
        ok: false,
        error: parsedAllowlist.error,
        policy: {
          source: 'store',
          allowlist_enforced: false,
          partner_allowed: null,
          min_plan_id: null,
          plan_meets_minimum: null,
          allowlist: []
        }
      };
    }

    const minPlanCfg = parseMinPlanRequirementRaw(storedPolicy.min_plan_id ?? null);
    if (!minPlanCfg.ok) {
      return {
        ok: false,
        error: minPlanCfg.error,
        policy: {
          source: 'store',
          allowlist_enforced: parsedAllowlist.allowlist.length > 0,
          partner_allowed: null,
          min_plan_id: minPlanCfg.error?.min_plan_id ?? null,
          plan_meets_minimum: null,
          allowlist: parsedAllowlist.allowlist
        }
      };
    }

    return {
      ok: true,
      policy: {
        source: 'store',
        allowlist: parsedAllowlist.allowlist,
        allowlist_enforced: parsedAllowlist.allowlist.length > 0,
        min_plan_id: minPlanCfg.min_plan_id,
        version: Number.isFinite(storedPolicy.version) ? Number(storedPolicy.version) : null,
        updated_at: normalizeOptionalString(storedPolicy.updated_at),
        updated_by: storedPolicy.updated_by ? clone(storedPolicy.updated_by) : null
      }
    };
  }

  const allowlist = parseAllowlistCsv(process.env.SETTLEMENT_VAULT_EXPORT_PARTNER_ALLOWLIST ?? '');
  const minPlanCfg = parseMinPlanRequirementRaw(process.env.SETTLEMENT_VAULT_EXPORT_MIN_PLAN ?? '');
  if (!minPlanCfg.ok) {
    return {
      ok: false,
      error: minPlanCfg.error,
      policy: {
        source: 'env',
        allowlist_enforced: allowlist.length > 0,
        partner_allowed: null,
        min_plan_id: minPlanCfg.error?.min_plan_id ?? null,
        plan_meets_minimum: null,
        allowlist
      }
    };
  }

  return {
    ok: true,
    policy: {
      source: 'env',
      allowlist,
      allowlist_enforced: allowlist.length > 0,
      min_plan_id: minPlanCfg.min_plan_id,
      version: null,
      updated_at: null,
      updated_by: null
    }
  };
}

export function evaluateVaultExportRolloutForPartner({ store, partnerId, partnerPlanId }) {
  const resolved = resolveVaultExportRolloutPolicy({ store });
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      policy: {
        ...(resolved.policy ?? {}),
        partner_allowed: resolved.policy?.allowlist_enforced ? resolved.policy.allowlist.includes(partnerId) : true,
        plan_meets_minimum: null
      }
    };
  }

  const policy = resolved.policy;
  const partnerAllowed = !policy.allowlist_enforced || policy.allowlist.includes(partnerId);

  const planIdNormalized = normalizePlanId(partnerPlanId);
  const planMeetsMinimum = policy.min_plan_id
    ? (planRank(planIdNormalized) ?? -1) >= (planRank(policy.min_plan_id) ?? Number.MAX_SAFE_INTEGER)
    : true;

  return {
    ok: true,
    policy: {
      ...policy,
      partner_allowed: partnerAllowed,
      plan_meets_minimum: planMeetsMinimum
    }
  };
}

export function vaultExportRolloutPolicyView({ policy }) {
  return {
    policy_key: 'vault_reconciliation_export',
    source: policy?.source ?? 'env',
    allowlist: Array.isArray(policy?.allowlist) ? [...policy.allowlist] : [],
    allowlist_enforced: policy?.allowlist_enforced === true,
    min_plan_id: policy?.min_plan_id ?? null,
    version: Number.isFinite(policy?.version) ? Number(policy.version) : null,
    updated_at: policy?.updated_at ?? null,
    updated_by: policy?.updated_by ?? null
  };
}
