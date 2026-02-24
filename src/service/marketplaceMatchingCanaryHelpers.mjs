import { summarizeCanarySamples } from './marketplaceMatchingHelpers.mjs';
import { createHash } from 'node:crypto';

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function canaryBucketBps({ canaryConfig, actor, idempotencyKey, requestedAt }) {
  const actorType = normalizeOptionalString(actor?.type) ?? 'unknown';
  const actorId = normalizeOptionalString(actor?.id) ?? 'unknown';
  const safeIdempotencyKey = normalizeOptionalString(idempotencyKey) ?? 'none';
  const key = `${canaryConfig.salt}|${actorType}|${actorId}|${safeIdempotencyKey}|${requestedAt}`;
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
  const n = Number.parseInt(digest, 16);
  if (!Number.isFinite(n)) return 0;
  return n % 10000;
}

export function ensureCanaryState(store) {
  store.state.marketplace_matching_canary_state ||= {};
  const state = store.state.marketplace_matching_canary_state;
  state.rollback_active = state.rollback_active === true;
  state.rollback_reason_code = normalizeOptionalString(state.rollback_reason_code);
  state.rollback_activated_at = normalizeOptionalString(state.rollback_activated_at);
  state.rollback_run_id = normalizeOptionalString(state.rollback_run_id);
  state.recent_samples = Array.isArray(state.recent_samples) ? state.recent_samples : [];
  return state;
}

export function clearCanaryRollbackState(store) {
  const state = ensureCanaryState(store);
  state.rollback_active = false;
  state.rollback_reason_code = null;
  state.rollback_activated_at = null;
  state.rollback_run_id = null;
  state.recent_samples = [];
  return state;
}

export function updateCanaryRollbackState({ store, canaryConfig, runId, recordedAt, sample }) {
  const state = ensureCanaryState(store);
  const before = {
    active: state.rollback_active === true,
    reason_code: state.rollback_reason_code ?? null
  };

  if (sample && before.active !== true) {
    state.recent_samples.push(sample);
    const overflow = state.recent_samples.length - canaryConfig.rollback_window_runs;
    if (overflow > 0) state.recent_samples.splice(0, overflow);
  }

  const summary = summarizeCanarySamples({
    samples: state.recent_samples,
    canaryConfig
  });

  let triggered = false;
  if (!state.rollback_active && summary.samples_count > 0 && summary.reason_code) {
    state.rollback_active = true;
    state.rollback_reason_code = summary.reason_code;
    state.rollback_activated_at = recordedAt;
    state.rollback_run_id = runId;
    triggered = true;
  }

  const after = {
    active: state.rollback_active === true,
    reason_code: state.rollback_reason_code ?? null
  };

  return {
    before,
    after,
    summary,
    triggered
  };
}
