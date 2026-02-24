function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseBoundedInt(value, { fallback, min, max }) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toBps(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((Number(numerator ?? 0) * 10000) / denominator);
}

function runSequenceFromRunId(runId) {
  const match = /^mrun_(\d+)$/.exec(String(runId ?? ''));
  if (!match) return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function sortRunIdsBySequence(runIds) {
  return [...runIds].sort((a, b) => {
    const seqA = runSequenceFromRunId(a);
    const seqB = runSequenceFromRunId(b);
    if (seqA !== seqB) return seqA - seqB;
    return String(a).localeCompare(String(b));
  });
}

export function scoreScaledToDecimal(scoreScaled) {
  return Number((Number(scoreScaled ?? 0) / 10000).toFixed(4));
}

export function readMatchingV2ShadowConfigFromEnv() {
  const lmaxRaw = process.env.MATCHING_V2_LMAX;
  const maxCycleLength = parseBoundedInt(lmaxRaw ?? process.env.MATCHING_V2_MAX_CYCLE_LENGTH, {
    fallback: 5,
    min: 2,
    max: 8
  });
  const minCycleLength = parseBoundedInt(process.env.MATCHING_V2_MIN_CYCLE_LENGTH, {
    fallback: 2,
    min: 2,
    max: maxCycleLength
  });

  return {
    shadow_enabled: parseBooleanFlag(process.env.MATCHING_V2_SHADOW, false),
    force_shadow_error: parseBooleanFlag(process.env.MATCHING_V2_SHADOW_FORCE_ERROR, false),
    min_cycle_length: minCycleLength,
    max_cycle_length: maxCycleLength,
    include_cycle_diagnostics: true,
    max_cycles_explored: parseBoundedInt(process.env.MATCHING_V2_MAX_CYCLES_EXPLORED, {
      fallback: 20000,
      min: 1,
      max: 200000
    }),
    timeout_ms: parseBoundedInt(process.env.MATCHING_V2_TIMEOUT_MS, {
      fallback: 100,
      min: 1,
      max: 5000
    }),
    max_shadow_diffs: parseBoundedInt(process.env.MATCHING_V2_MAX_SHADOW_DIFFS, {
      fallback: 1000,
      min: 1,
      max: 100000
    })
  };
}

export function readMatchingTsShadowConfigFromEnv() {
  return {
    enabled: parseBooleanFlag(process.env.MATCHING_TS_SHADOW, false),
    force_shadow_error: parseBooleanFlag(process.env.MATCHING_TS_SHADOW_FORCE_ERROR, false),
    max_shadow_diffs: parseBoundedInt(process.env.MATCHING_TS_SHADOW_MAX_DIFFS, {
      fallback: 1000,
      min: 1,
      max: 100000
    })
  };
}

export function readMatchingV2CanaryConfigFromEnv() {
  return {
    enabled: parseBooleanFlag(process.env.MATCHING_V2_CANARY_ENABLED, false),
    rollout_bps: parseBoundedInt(process.env.MATCHING_V2_CANARY_PERCENT_BPS, {
      fallback: 0,
      min: 0,
      max: 10000
    }),
    salt: normalizeOptionalString(process.env.MATCHING_V2_CANARY_SALT) ?? 'swapgraph_v2_canary',
    force_bucket_v2: parseBooleanFlag(process.env.MATCHING_V2_CANARY_FORCE_BUCKET_V2, false),
    force_canary_error: parseBooleanFlag(process.env.MATCHING_V2_CANARY_FORCE_ERROR, false),
    max_canary_decisions: parseBoundedInt(process.env.MATCHING_V2_MAX_CANARY_DECISIONS, {
      fallback: 1000,
      min: 1,
      max: 100000
    }),
    rollback_window_runs: parseBoundedInt(process.env.MATCHING_V2_CANARY_ROLLBACK_WINDOW_RUNS, {
      fallback: 20,
      min: 1,
      max: 1000
    }),
    rollback_max_error_rate_bps: parseBoundedInt(process.env.MATCHING_V2_CANARY_ROLLBACK_MAX_ERROR_RATE_BPS, {
      fallback: 0,
      min: 0,
      max: 10000
    }),
    rollback_max_timeout_rate_bps: parseBoundedInt(process.env.MATCHING_V2_CANARY_ROLLBACK_MAX_TIMEOUT_RATE_BPS, {
      fallback: 0,
      min: 0,
      max: 10000
    }),
    rollback_max_limited_rate_bps: parseBoundedInt(process.env.MATCHING_V2_CANARY_ROLLBACK_MAX_LIMITED_RATE_BPS, {
      fallback: 0,
      min: 0,
      max: 10000
    }),
    rollback_min_non_negative_delta_rate_bps: parseBoundedInt(process.env.MATCHING_V2_CANARY_ROLLBACK_MIN_NON_NEGATIVE_DELTA_RATE_BPS, {
      fallback: 10000,
      min: 0,
      max: 10000
    })
  };
}

export function readMatchingV2PrimaryConfigFromEnv() {
  return {
    enabled: parseBooleanFlag(process.env.MATCHING_V2_PRIMARY_ENABLED, false),
    force_primary_error: parseBooleanFlag(process.env.MATCHING_V2_PRIMARY_FORCE_ERROR, false),
    force_safety_timeout: parseBooleanFlag(process.env.MATCHING_V2_PRIMARY_FORCE_SAFETY_TIMEOUT, false),
    force_safety_limited: parseBooleanFlag(process.env.MATCHING_V2_PRIMARY_FORCE_SAFETY_LIMITED, false),
    fallback_on_timeout: parseBooleanFlag(process.env.MATCHING_V2_FALLBACK_ON_TIMEOUT, true),
    fallback_on_limited: parseBooleanFlag(process.env.MATCHING_V2_FALLBACK_ON_LIMITED, true),
    rollback_reset: parseBooleanFlag(process.env.MATCHING_V2_ROLLBACK_RESET, false)
  };
}

export function summarizeCanarySamples({ samples, canaryConfig }) {
  const safeSamples = Array.isArray(samples) ? samples : [];
  const total = safeSamples.length;
  if (total === 0) {
    return {
      samples_count: 0,
      error_count: 0,
      timeout_count: 0,
      limited_count: 0,
      non_negative_delta_count: 0,
      rates_bps: {
        error_rate_bps: 0,
        timeout_rate_bps: 0,
        limited_rate_bps: 0,
        non_negative_delta_rate_bps: 10000
      },
      reason_code: null
    };
  }
  const errorCount = safeSamples.filter(sample => sample?.error === true).length;
  const timeoutCount = safeSamples.filter(sample => sample?.timeout === true).length;
  const limitedCount = safeSamples.filter(sample => sample?.limited === true).length;
  const nonNegativeDeltaCount = safeSamples.filter(sample => sample?.non_negative_delta === true).length;

  const ratesBps = {
    error_rate_bps: toBps(errorCount, total),
    timeout_rate_bps: toBps(timeoutCount, total),
    limited_rate_bps: toBps(limitedCount, total),
    non_negative_delta_rate_bps: toBps(nonNegativeDeltaCount, total)
  };

  let reasonCode = null;
  if (ratesBps.error_rate_bps > canaryConfig.rollback_max_error_rate_bps) {
    reasonCode = 'canary_error_rate_exceeded';
  } else if (ratesBps.timeout_rate_bps > canaryConfig.rollback_max_timeout_rate_bps) {
    reasonCode = 'canary_timeout_rate_exceeded';
  } else if (ratesBps.limited_rate_bps > canaryConfig.rollback_max_limited_rate_bps) {
    reasonCode = 'canary_limited_rate_exceeded';
  } else if (ratesBps.non_negative_delta_rate_bps < canaryConfig.rollback_min_non_negative_delta_rate_bps) {
    reasonCode = 'canary_negative_delta_rate_exceeded';
  }

  return {
    samples_count: total,
    error_count: errorCount,
    timeout_count: timeoutCount,
    limited_count: limitedCount,
    non_negative_delta_count: nonNegativeDeltaCount,
    rates_bps: ratesBps,
    reason_code: reasonCode
  };
}

export function pruneShadowDiffHistory({ store, maxShadowDiffs }) {
  if (!store?.state?.marketplace_matching_shadow_diffs || !Number.isFinite(maxShadowDiffs) || maxShadowDiffs < 1) {
    return;
  }
  const runIds = sortRunIdsBySequence(Object.keys(store.state.marketplace_matching_shadow_diffs));
  const overflow = runIds.length - maxShadowDiffs;
  if (overflow <= 0) return;
  for (let idx = 0; idx < overflow; idx += 1) {
    delete store.state.marketplace_matching_shadow_diffs[runIds[idx]];
  }
}

export function pruneTsShadowDiffHistory({ store, maxShadowDiffs }) {
  if (!store?.state?.marketplace_matching_ts_shadow_diffs || !Number.isFinite(maxShadowDiffs) || maxShadowDiffs < 1) {
    return;
  }
  const runIds = sortRunIdsBySequence(Object.keys(store.state.marketplace_matching_ts_shadow_diffs));
  const overflow = runIds.length - maxShadowDiffs;
  if (overflow <= 0) return;
  for (let idx = 0; idx < overflow; idx += 1) {
    delete store.state.marketplace_matching_ts_shadow_diffs[runIds[idx]];
  }
}

export function pruneCanaryDecisionHistory({ store, maxCanaryDecisions }) {
  if (!store?.state?.marketplace_matching_canary_decisions || !Number.isFinite(maxCanaryDecisions) || maxCanaryDecisions < 1) {
    return;
  }
  const runIds = sortRunIdsBySequence(Object.keys(store.state.marketplace_matching_canary_decisions));
  const overflow = runIds.length - maxCanaryDecisions;
  if (overflow <= 0) return;
  for (let idx = 0; idx < overflow; idx += 1) {
    delete store.state.marketplace_matching_canary_decisions[runIds[idx]];
  }
}
