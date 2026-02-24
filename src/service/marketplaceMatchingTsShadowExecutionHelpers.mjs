import { buildTsShadowDiffRecord, buildTsShadowErrorRecord } from './marketplaceMatchingDiffHelpers.mjs';
import { pruneTsShadowDiffHistory } from './marketplaceMatchingHelpers.mjs';
import { runMatcherTsShadowWithConfig } from './marketplaceMatcherRunners.mjs';

export function executeMarketplaceTsShadow({
  store,
  runId,
  requestedAt,
  maxProposals,
  primaryEngine,
  primaryMatcherConfig,
  activeIntents,
  assetValuesUsd,
  edgeIntents,
  primaryResult,
  tsShadowConfig
}) {
  if (!tsShadowConfig.enabled) return;

  try {
    if (tsShadowConfig.force_shadow_error) {
      throw new Error('forced matching ts shadow error');
    }

    const tsResult = runMatcherTsShadowWithConfig({
      intents: activeIntents,
      assetValuesUsd,
      edgeIntents,
      nowIso: requestedAt,
      config: primaryMatcherConfig
    });

    const tsShadowRecord = buildTsShadowDiffRecord({
      runId,
      recordedAt: requestedAt,
      maxProposals,
      primaryEngine,
      matcherConfig: primaryMatcherConfig,
      jsResult: primaryResult,
      tsResult
    });
    store.state.marketplace_matching_ts_shadow_diffs[runId] = tsShadowRecord;
  } catch (error) {
    const tsShadowErrorRecord = buildTsShadowErrorRecord({
      runId,
      recordedAt: requestedAt,
      primaryEngine,
      matcherConfig: primaryMatcherConfig,
      error
    });
    store.state.marketplace_matching_ts_shadow_diffs[runId] = tsShadowErrorRecord;
  }

  pruneTsShadowDiffHistory({
    store,
    maxShadowDiffs: tsShadowConfig.max_shadow_diffs
  });
}
