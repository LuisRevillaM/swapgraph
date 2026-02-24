import { authorizeApiOperation } from '../core/authz.mjs';
import {
  readMatchingV2ShadowConfigFromEnv,
  readMatchingTsShadowConfigFromEnv,
  readMatchingV2CanaryConfigFromEnv,
  readMatchingV2PrimaryConfigFromEnv,
  summarizeCanarySamples,
  pruneShadowDiffHistory,
  pruneTsShadowDiffHistory,
  pruneCanaryDecisionHistory
} from './marketplaceMatchingHelpers.mjs';
import {
  summarizeSelectedProposals,
  applyForcedSafetyTriggers,
  applySafetyToDiffRecord,
  buildShadowErrorRecord,
  buildShadowDiffRecord,
  buildTsShadowErrorRecord,
  buildTsShadowDiffRecord
} from './marketplaceMatchingDiffHelpers.mjs';
import {
  runMatcherWithConfig,
  runMatcherTsShadowWithConfig
} from './marketplaceMatcherRunners.mjs';
import {
  canaryBucketBps,
  ensureCanaryState,
  clearCanaryRollbackState,
  updateCanaryRollbackState
} from './marketplaceMatchingCanaryHelpers.mjs';
import {
  normalizeOptionalString,
  parseIsoMs,
  parsePositiveInt,
  normalizeAssetValuesMap,
  deriveAssetValuesFromIntents
} from './marketplaceMatchingRequestHelpers.mjs';
import {
  expireMarketplaceProposals,
  replaceMarketplaceProposals
} from './marketplaceMatchingProposalLifecycleHelpers.mjs';
import {
  activeEdgeIntentsForMatching,
  ensureState,
  nextRunId
} from './marketplaceMatchingStateHelpers.mjs';
import {
  buildMarketplaceRunRecord,
  persistSelectedMarketplaceProposals
} from './marketplaceMatchingRunRecordHelpers.mjs';
import {
  buildCanarySample,
  buildMarketplaceCanaryDecisionRecord
} from './marketplaceMatchingCanaryDecisionHelpers.mjs';
import {
  executeMarketplaceShadowDiff,
  executeMarketplaceV2CanarySelection
} from './marketplaceMatchingExecutionHelpers.mjs';
import { buildMarketplaceCanaryRoutingContext } from './marketplaceMatchingCanaryRoutingHelpers.mjs';
import { executeMarketplaceTsShadow } from './marketplaceMatchingTsShadowExecutionHelpers.mjs';
import {
  correlationId,
  clone,
  errorResponse,
  withIdempotency
} from './marketplaceMatchingResponseHelpers.mjs';

export class MarketplaceMatchingService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  runMatching({ actor, auth, idempotencyKey, request }) {
    const op = 'marketplaceMatching.run';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) } };

    return withIdempotency({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationIdValue: corr,
      handler: () => {
        const replaceExisting = request?.replace_existing !== false;
        const maxProposals = parsePositiveInt(request?.max_proposals, 50);
        const requestedAt = normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
        const requestAssetValues = normalizeAssetValuesMap(request?.asset_values_usd);

        if (maxProposals === null || parseIsoMs(requestedAt) === null || requestAssetValues === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid marketplace matching request', {
              reason_code: 'marketplace_matching_invalid_request'
            })
          };
        }

        const activeIntents = Object.values(this.store.state.intents ?? {})
          .filter(intent => (intent?.status ?? 'active') === 'active')
          .filter(intent => intent?.actor?.type === 'user');

        const derivedAssetValues = deriveAssetValuesFromIntents(activeIntents);
        const storedAssetValues = clone(this.store.state.marketplace_asset_values ?? {});
        const assetValuesUsd = {
          ...storedAssetValues,
          ...derivedAssetValues,
          ...requestAssetValues
        };

        if (Object.keys(assetValuesUsd).length === 0) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'asset values are required to score marketplace matching proposals', {
              reason_code: 'marketplace_matching_asset_values_missing'
            })
          };
        }

        this.store.state.marketplace_asset_values = assetValuesUsd;

        const expiredProposalsCount = expireMarketplaceProposals({
          store: this.store,
          nowIso: requestedAt
        });
        const replacedProposalsCount = replaceExisting
          ? replaceMarketplaceProposals({ store: this.store })
          : 0;

        const edgeIntents = activeEdgeIntentsForMatching({ store: this.store, nowIso: requestedAt });
        const v1Config = {
          min_cycle_length: 2,
          max_cycle_length: 3,
          include_cycle_diagnostics: false,
          max_cycles_explored: null,
          timeout_ms: null
        };
        const v2Config = readMatchingV2ShadowConfigFromEnv();
        const tsShadowConfig = readMatchingTsShadowConfigFromEnv();
        const canaryConfig = readMatchingV2CanaryConfigFromEnv();
        const primaryConfig = readMatchingV2PrimaryConfigFromEnv();

        const v1Result = runMatcherWithConfig({
          intents: activeIntents,
          assetValuesUsd,
          edgeIntents,
          nowIso: requestedAt,
          config: v1Config
        });
        const runId = nextRunId(this.store);
        let v2Result = null;
        let canaryError = null;
        let v2FallbackReasonCode = null;
        let v2SafetyTriggers = {
          timeout_reached: false,
          max_cycles_reached: false
        };
        let primaryResult = v1Result;
        let primaryEngine = 'v1';

        let {
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
        } = buildMarketplaceCanaryRoutingContext({
          store: this.store,
          primaryConfig,
          canaryConfig,
          actor,
          idempotencyKey,
          requestedAt,
          cloneValue: clone
        });

        ({
          v2Result,
          canaryError,
          v2FallbackReasonCode,
          v2SafetyTriggers,
          primaryResult,
          primaryEngine
        } = executeMarketplaceV2CanarySelection({
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
        }));

        let canaryDiffRecord = null;
        ({
          v2Result,
          v2SafetyTriggers,
          canaryDiffRecord
        } = executeMarketplaceShadowDiff({
          store: this.store,
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
        }));

        const matching = primaryResult.matching;
        const selected = (matching?.proposals ?? []).slice(0, maxProposals);
        const primaryMatcherConfig = primaryEngine === 'v2' ? v2Config : v1Config;

        executeMarketplaceTsShadow({
          store: this.store,
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
        });

        if (decisionTrackingEnabled) {
          const canarySample = buildCanarySample({
            runId,
            recordedAt: requestedAt,
            canarySelected,
            canaryError,
            v2SafetyTriggers,
            canaryDiffRecord
          });
          const rollbackUpdate = updateCanaryRollbackState({
            store: this.store,
            canaryConfig,
            runId,
            recordedAt: requestedAt,
            sample: canarySample
          });
          canaryRollbackBefore = rollbackUpdate.before;
          canaryRollbackAfter = rollbackUpdate.after;
          canaryRollbackTriggered = rollbackUpdate.triggered;
          canarySampleSummary = rollbackUpdate.summary;

          this.store.state.marketplace_matching_canary_decisions ||= {};
          this.store.state.marketplace_matching_canary_decisions[runId] = buildMarketplaceCanaryDecisionRecord({
            runId,
            recordedAt: requestedAt,
            primaryConfigEnabled: primaryConfig.enabled,
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
          });

          pruneCanaryDecisionHistory({
            store: this.store,
            maxCanaryDecisions: canaryConfig.max_canary_decisions
          });
        }

        persistSelectedMarketplaceProposals({
          store: this.store,
          selected,
          runId,
          cloneValue: clone
        });

        const run = buildMarketplaceRunRecord({
          actor,
          runId,
          requestedAt,
          replaceExisting,
          maxProposals,
          activeIntentsCount: activeIntents.length,
          selected,
          replacedProposalsCount,
          expiredProposalsCount,
          matching
        });

        this.store.state.marketplace_matching_runs[runId] = clone(run);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            run
          }
        };
      }
    });
  }

  getMatchingRun({ actor, auth, runId }) {
    const op = 'marketplaceMatchingRun.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    const normalizedRunId = normalizeOptionalString(runId);
    if (!normalizedRunId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'run_id is required', {
          reason_code: 'marketplace_matching_invalid_request'
        })
      };
    }

    const run = this.store.state.marketplace_matching_runs?.[normalizedRunId] ?? null;
    if (!run) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'marketplace matching run not found', {
          run_id: normalizedRunId,
          reason_code: 'marketplace_matching_run_not_found'
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        run: clone(run)
      }
    };
  }
}
