export function buildCanarySample({
  runId,
  recordedAt,
  canarySelected,
  canaryError,
  v2SafetyTriggers,
  canaryDiffRecord
}) {
  if (!canarySelected) return null;
  return {
    run_id: runId,
    recorded_at: recordedAt,
    error: Boolean(canaryError),
    timeout: canaryError ? false : Boolean(v2SafetyTriggers.timeout_reached),
    limited: canaryError ? false : Boolean(v2SafetyTriggers.max_cycles_reached),
    non_negative_delta: canaryError
      ? false
      : Number(canaryDiffRecord?.metrics?.delta_score_sum_scaled ?? 0) >= 0
  };
}

export function buildMarketplaceCanaryDecisionRecord({
  runId,
  recordedAt,
  primaryConfigEnabled,
  primaryEngine,
  canarySelected,
  canaryConfig,
  rollbackResetApplied,
  canarySkippedReason,
  canaryBucketValue,
  inCanaryBucket,
  canaryRollbackBefore,
  canaryRollbackAfter,
  canaryRollbackTriggered,
  canaryError,
  v2FallbackReasonCode,
  canaryDiffRecord,
  v1Result,
  matching,
  canarySampleSummary
}) {
  return {
    run_id: runId,
    recorded_at: recordedAt,
    mode: primaryConfigEnabled ? 'v2_primary' : 'v2_canary',
    primary_engine: primaryEngine,
    routed_to_v2: primaryEngine === 'v2',
    fallback_to_v1: canarySelected && primaryEngine !== 'v2',
    fallback_reason_code: canarySelected && primaryEngine !== 'v2' ? v2FallbackReasonCode : null,
    canary_selected: canarySelected,
    canary_enabled: canaryConfig.enabled,
    primary_enabled: primaryConfigEnabled,
    rollback_reset_applied: rollbackResetApplied,
    skipped_reason: canarySkippedReason,
    rollout_bps: canaryConfig.rollout_bps,
    bucket_bps: canaryBucketValue,
    in_rollout_bucket: inCanaryBucket,
    rollback: {
      active_before: canaryRollbackBefore.active,
      reason_code_before: canaryRollbackBefore.reason_code,
      active_after: canaryRollbackAfter.active,
      reason_code_after: canaryRollbackAfter.reason_code,
      triggered: canaryRollbackTriggered,
      trigger_reason_code: canaryRollbackTriggered ? canaryRollbackAfter.reason_code : null
    },
    v2: {
      attempted: canarySelected,
      error: canaryError
        ? {
          code: primaryConfigEnabled ? 'matching_v2_primary_failed' : 'matching_v2_canary_failed',
          name: String(canaryError?.name ?? 'Error'),
          message: String(canaryError?.message ?? (primaryConfigEnabled ? 'v2 primary execution failed' : 'v2 canary execution failed'))
        }
        : null
    },
    metrics: {
      v1_candidate_cycles: Number(canaryDiffRecord?.metrics?.v1_candidate_cycles ?? v1Result?.matching?.stats?.candidate_cycles ?? 0),
      v2_candidate_cycles: canaryDiffRecord ? Number(canaryDiffRecord?.metrics?.v2_candidate_cycles ?? 0) : null,
      primary_candidate_cycles: Number(matching?.stats?.candidate_cycles ?? 0),
      delta_score_sum_scaled: canaryDiffRecord ? Number(canaryDiffRecord?.metrics?.delta_score_sum_scaled ?? 0) : null,
      timeout_reached: canaryDiffRecord ? Boolean(canaryDiffRecord?.v2_safety_triggers?.timeout_reached) : null,
      limited_reached: canaryDiffRecord ? Boolean(canaryDiffRecord?.v2_safety_triggers?.max_cycles_reached) : null
    },
    sample_summary: canarySampleSummary
  };
}
