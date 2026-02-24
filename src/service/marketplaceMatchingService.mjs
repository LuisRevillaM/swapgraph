import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
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

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorResponse(correlationIdValue, code, message, details = {}) {
  return {
    correlation_id: correlationIdValue,
    error: {
      code,
      message,
      details
    }
  };
}

function activeEdgeIntentsForMatching({ store, nowIso }) {
  const nowMs = parseIsoMs(nowIso) ?? Date.now();
  return Object.values(store.state.edge_intents ?? {})
    .filter(row => {
      if (!row || typeof row !== 'object') return false;
      const sourceIntentId = normalizeOptionalString(row.source_intent_id);
      const targetIntentId = normalizeOptionalString(row.target_intent_id);
      if (!sourceIntentId || !targetIntentId || sourceIntentId === targetIntentId) return false;
      if (!store.state.intents?.[sourceIntentId] || !store.state.intents?.[targetIntentId]) return false;
      if ((row.status ?? 'active') !== 'active') return false;
      const expiresMs = parseIsoMs(row.expires_at);
      if (expiresMs !== null && expiresMs <= nowMs) return false;
      return true;
    });
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.intents ||= {};
  store.state.proposals ||= {};
  store.state.commits ||= {};
  store.state.reservations ||= {};
  store.state.timelines ||= {};
  store.state.receipts ||= {};
  store.state.tenancy ||= {};
  store.state.tenancy.proposals ||= {};
  store.state.marketplace_asset_values ||= {};
  store.state.marketplace_matching_runs ||= {};
  store.state.marketplace_matching_run_counter ||= 0;
  store.state.marketplace_matching_proposal_runs ||= {};
  store.state.marketplace_matching_shadow_diffs ||= {};
  store.state.marketplace_matching_ts_shadow_diffs ||= {};
  store.state.edge_intents ||= {};
  store.state.edge_intent_counter ||= 0;
}

function nextRunId(store) {
  store.state.marketplace_matching_run_counter = Number(store.state.marketplace_matching_run_counter ?? 0) + 1;
  const n = String(store.state.marketplace_matching_run_counter).padStart(6, '0');
  return `mrun_${n}`;
}

export class MarketplaceMatchingService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const requestHash = payloadHash(requestBody);
    const existing = this.store.state.idempotency[scopeKey];

    if (existing) {
      if (existing.payload_hash === requestHash) {
        return {
          replayed: true,
          result: clone(existing.result)
        };
      }

      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', {
            operation_id: operationId,
            idempotency_key: idempotencyKey
          })
        }
      };
    }

    const result = handler();
    this.store.state.idempotency[scopeKey] = {
      payload_hash: requestHash,
      result: clone(result)
    };

    return { replayed: false, result };
  }

  runMatching({ actor, auth, idempotencyKey, request }) {
    const op = 'marketplaceMatching.run';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
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
          let canaryState = ensureCanaryState(this.store);
          if (primaryConfig.enabled && primaryConfig.rollback_reset) {
            clearCanaryRollbackState(this.store);
            rollbackResetApplied = true;
            canaryState = ensureCanaryState(this.store);
          }

          canaryRollbackBefore = {
            active: canaryState.rollback_active === true,
            reason_code: canaryState.rollback_reason_code ?? null
          };
          canaryRollbackAfter = clone(canaryRollbackBefore);
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

        if (canarySelected) {
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
        }

        let canaryDiffRecord = null;
        let shadowRecord = null;
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

              shadowRecord = buildShadowDiffRecord({
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
              this.store.state.marketplace_matching_shadow_diffs[runId] = shadowRecord;
            } catch (error) {
              shadowRecord = buildShadowErrorRecord({
                runId,
                recordedAt: requestedAt,
                v2Config,
                error
              });
              this.store.state.marketplace_matching_shadow_diffs[runId] = shadowRecord;
            }
          }

          pruneShadowDiffHistory({
            store: this.store,
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

        const matching = primaryResult.matching;
        const selected = (matching?.proposals ?? []).slice(0, maxProposals);
        const primaryMatcherConfig = primaryEngine === 'v2' ? v2Config : v1Config;

        if (tsShadowConfig.enabled) {
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
            this.store.state.marketplace_matching_ts_shadow_diffs[runId] = tsShadowRecord;
          } catch (error) {
            const tsShadowErrorRecord = buildTsShadowErrorRecord({
              runId,
              recordedAt: requestedAt,
              primaryEngine,
              matcherConfig: primaryMatcherConfig,
              error
            });
            this.store.state.marketplace_matching_ts_shadow_diffs[runId] = tsShadowErrorRecord;
          }

          pruneTsShadowDiffHistory({
            store: this.store,
            maxShadowDiffs: tsShadowConfig.max_shadow_diffs
          });
        }

        if (decisionTrackingEnabled) {
          const canarySample = !canarySelected
            ? null
            : {
              run_id: runId,
              recorded_at: requestedAt,
              error: Boolean(canaryError),
              timeout: canaryError ? false : Boolean(v2SafetyTriggers.timeout_reached),
              limited: canaryError ? false : Boolean(v2SafetyTriggers.max_cycles_reached),
              non_negative_delta: canaryError
                ? false
                : Number(canaryDiffRecord?.metrics?.delta_score_sum_scaled ?? 0) >= 0
            };
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
          this.store.state.marketplace_matching_canary_decisions[runId] = {
            run_id: runId,
            recorded_at: requestedAt,
            mode: primaryConfig.enabled ? 'v2_primary' : 'v2_canary',
            primary_engine: primaryEngine,
            routed_to_v2: primaryEngine === 'v2',
            fallback_to_v1: canarySelected && primaryEngine !== 'v2',
            fallback_reason_code: canarySelected && primaryEngine !== 'v2' ? v2FallbackReasonCode : null,
            canary_selected: canarySelected,
            canary_enabled: canaryConfig.enabled,
            primary_enabled: primaryConfig.enabled,
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
                  code: primaryConfig.enabled ? 'matching_v2_primary_failed' : 'matching_v2_canary_failed',
                  name: String(canaryError?.name ?? 'Error'),
                  message: String(canaryError?.message ?? (primaryConfig.enabled ? 'v2 primary execution failed' : 'v2 canary execution failed'))
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

          pruneCanaryDecisionHistory({
            store: this.store,
            maxCanaryDecisions: canaryConfig.max_canary_decisions
          });
        }

        for (const proposal of selected) {
          this.store.state.proposals[proposal.id] = clone(proposal);
          this.store.state.tenancy.proposals[proposal.id] ||= { partner_id: 'marketplace' };
          this.store.state.marketplace_matching_proposal_runs[proposal.id] = runId;
        }

        const run = {
          run_id: runId,
          requested_by: {
            type: actor.type,
            id: actor.id
          },
          recorded_at: requestedAt,
          replace_existing: replaceExisting,
          max_proposals: maxProposals,
          active_intents_count: activeIntents.length,
          selected_proposals_count: selected.length,
          stored_proposals_count: selected.length,
          replaced_proposals_count: replacedProposalsCount,
          expired_proposals_count: expiredProposalsCount,
          proposal_ids: selected.map(proposal => proposal.id),
          stats: {
            intents_active: Number(matching?.stats?.intents_active ?? 0),
            edges: Number(matching?.stats?.edges ?? 0),
            candidate_cycles: Number(matching?.stats?.candidate_cycles ?? 0),
            candidate_proposals: Number(matching?.stats?.candidate_proposals ?? 0),
            selected_proposals: Number(matching?.stats?.selected_proposals ?? 0)
          }
        };

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
