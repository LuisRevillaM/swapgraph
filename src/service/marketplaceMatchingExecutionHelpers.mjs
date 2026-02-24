import { applyForcedSafetyTriggers, applySafetyToDiffRecord, buildShadowErrorRecord, buildShadowDiffRecord } from './marketplaceMatchingDiffHelpers.mjs';
import { pruneShadowDiffHistory } from './marketplaceMatchingHelpers.mjs';
import { runMatcherWithConfig } from './marketplaceMatcherRunners.mjs';

export function executeMarketplaceV2CanarySelection({
  canarySelected,
  primaryConfig,
  canaryConfig,
  activeIntents,
  assetValuesUsd,
  edgeIntents,
  requestedAt,
  v2Config,
  v1Result,
  v2Result,
  v2SafetyTriggers,
  primaryResult,
  primaryEngine,
  v2FallbackReasonCode,
  canaryError
}) {
  if (!canarySelected) {
    return {
      v2Result,
      canaryError,
      v2FallbackReasonCode,
      v2SafetyTriggers,
      primaryResult,
      primaryEngine
    };
  }

  try {
    if (primaryConfig.enabled && primaryConfig.force_primary_error) {
      throw new Error('forced matching v2 primary error');
    }
    if (!primaryConfig.enabled && canaryConfig.force_canary_error) {
      throw new Error('forced matching v2 canary error');
    }

    v2Result = runMatcherWithConfig({
      intents: activeIntents,
      assetValuesUsd,
      edgeIntents,
      nowIso: requestedAt,
      config: v2Config
    });

    v2SafetyTriggers = applyForcedSafetyTriggers({
      safety: {
        timeout_reached: Boolean(v2Result?.matching?.stats?.cycle_enumeration_timed_out),
        max_cycles_reached: Boolean(v2Result?.matching?.stats?.cycle_enumeration_limited)
      },
      primaryConfig
    });

    if (primaryConfig.enabled) {
      const timeoutFallback = v2SafetyTriggers.timeout_reached && primaryConfig.fallback_on_timeout;
      const limitedFallback = v2SafetyTriggers.max_cycles_reached && primaryConfig.fallback_on_limited;
      if (timeoutFallback || limitedFallback) {
        primaryResult = v1Result;
        primaryEngine = 'v1';
        v2FallbackReasonCode = timeoutFallback ? 'v2_timeout_safety' : 'v2_limited_safety';
      } else {
        primaryResult = v2Result;
        primaryEngine = 'v2';
      }
    } else {
      primaryResult = v2Result;
      primaryEngine = 'v2';
    }
  } catch (error) {
    canaryError = error;
    v2FallbackReasonCode = primaryConfig.enabled ? 'v2_error' : 'canary_error';
  }

  return {
    v2Result,
    canaryError,
    v2FallbackReasonCode,
    v2SafetyTriggers,
    primaryResult,
    primaryEngine
  };
}

export function executeMarketplaceShadowDiff({
  store,
  runId,
  requestedAt,
  maxProposals,
  v1Config,
  v1Result,
  activeIntents,
  assetValuesUsd,
  edgeIntents,
  v2Config,
  v2Result,
  v2SafetyTriggers,
  primaryConfig,
  canarySkippedReason
}) {
  let canaryDiffRecord = null;
  const skipShadowDueToPrimaryRollbackLatch = primaryConfig.enabled
    && canarySkippedReason === 'rollback_active'
    && !v2Result;

  if (v2Config.shadow_enabled) {
    if (!skipShadowDueToPrimaryRollbackLatch) {
      try {
        if (!v2Result) {
          if (v2Config.force_shadow_error) {
            throw new Error('forced matching v2 shadow error');
          }
          v2Result = runMatcherWithConfig({
            intents: activeIntents,
            assetValuesUsd,
            edgeIntents,
            nowIso: requestedAt,
            config: v2Config
          });
        }

        v2SafetyTriggers = applyForcedSafetyTriggers({
          safety: {
            timeout_reached: Boolean(v2Result?.matching?.stats?.cycle_enumeration_timed_out),
            max_cycles_reached: Boolean(v2Result?.matching?.stats?.cycle_enumeration_limited)
          },
          primaryConfig
        });

        let shadowRecord = buildShadowDiffRecord({
          runId,
          recordedAt: requestedAt,
          maxProposals,
          v1Config,
          v1Result,
          v2Config,
          v2Result
        });
        shadowRecord = applySafetyToDiffRecord({
          diffRecord: shadowRecord,
          safety: v2SafetyTriggers
        });
        canaryDiffRecord = shadowRecord;
        store.state.marketplace_matching_shadow_diffs[runId] = shadowRecord;
      } catch (error) {
        const shadowRecord = buildShadowErrorRecord({
          runId,
          recordedAt: requestedAt,
          v2Config,
          error
        });
        store.state.marketplace_matching_shadow_diffs[runId] = shadowRecord;
      }
    }

    pruneShadowDiffHistory({
      store,
      maxShadowDiffs: v2Config.max_shadow_diffs
    });
  } else if (v2Result) {
    canaryDiffRecord = buildShadowDiffRecord({
      runId,
      recordedAt: requestedAt,
      maxProposals,
      v1Config,
      v1Result,
      v2Config,
      v2Result
    });
    canaryDiffRecord = applySafetyToDiffRecord({
      diffRecord: canaryDiffRecord,
      safety: v2SafetyTriggers
    });
  }

  return {
    v2Result,
    v2SafetyTriggers,
    canaryDiffRecord
  };
}
