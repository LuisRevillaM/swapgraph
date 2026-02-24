import { summarizeCanarySamples } from './marketplaceMatchingHelpers.mjs';
import { canaryBucketBps, clearCanaryRollbackState, ensureCanaryState } from './marketplaceMatchingCanaryHelpers.mjs';

export function buildMarketplaceCanaryRoutingContext({
  store,
  primaryConfig,
  canaryConfig,
  actor,
  idempotencyKey,
  requestedAt,
  cloneValue
}) {
  let canaryBucketValue = null;
  let inCanaryBucket = false;
  let canarySkippedReason = 'canary_disabled';
  let canarySelected = false;
  let rollbackResetApplied = false;
  let canaryRollbackBefore = { active: false, reason_code: null };
  let canaryRollbackAfter = { active: false, reason_code: null };
  let canaryRollbackTriggered = false;
  let canarySampleSummary = summarizeCanarySamples({
    samples: [],
    canaryConfig
  });
  const decisionTrackingEnabled = primaryConfig.enabled || canaryConfig.enabled;

  if (decisionTrackingEnabled) {
    let canaryState = ensureCanaryState(store);
    if (primaryConfig.enabled && primaryConfig.rollback_reset) {
      clearCanaryRollbackState(store);
      rollbackResetApplied = true;
      canaryState = ensureCanaryState(store);
    }

    canaryRollbackBefore = {
      active: canaryState.rollback_active === true,
      reason_code: canaryState.rollback_reason_code ?? null
    };
    canaryRollbackAfter = cloneValue(canaryRollbackBefore);
    canarySampleSummary = summarizeCanarySamples({
      samples: canaryState.recent_samples,
      canaryConfig
    });

    if (primaryConfig.enabled) {
      inCanaryBucket = true;
      if (canaryRollbackBefore.active) {
        canarySkippedReason = 'rollback_active';
      } else {
        canarySkippedReason = null;
        canarySelected = true;
      }
    } else {
      canaryBucketValue = canaryBucketBps({
        canaryConfig,
        actor,
        idempotencyKey,
        requestedAt
      });
      inCanaryBucket = canaryConfig.force_bucket_v2 || canaryBucketValue < canaryConfig.rollout_bps;

      if (canaryRollbackBefore.active) {
        canarySkippedReason = 'rollback_active';
      } else if (!inCanaryBucket) {
        canarySkippedReason = 'rollout_excluded';
      } else {
        canarySkippedReason = null;
        canarySelected = true;
      }
    }
  }

  return {
    canaryBucketValue,
    inCanaryBucket,
    canarySkippedReason,
    canarySelected,
    rollbackResetApplied,
    canaryRollbackBefore,
    canaryRollbackAfter,
    canaryRollbackTriggered,
    canarySampleSummary,
    decisionTrackingEnabled
  };
}
