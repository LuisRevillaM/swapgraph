import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { commitIdForProposalId } from '../commit/commitIds.mjs';
import { runMatching as runMatchingJs } from '../matching/engine.mjs';
import { runMatching as runMatchingTsShadow } from '../matching-ts-shadow/engine.mjs';
import {
  readMatchingV2ShadowConfigFromEnv,
  readMatchingTsShadowConfigFromEnv,
  readMatchingV2CanaryConfigFromEnv,
  readMatchingV2PrimaryConfigFromEnv,
  scoreScaledToDecimal,
  summarizeCanarySamples,
  pruneShadowDiffHistory,
  pruneTsShadowDiffHistory,
  pruneCanaryDecisionHistory
} from './marketplaceMatchingHelpers.mjs';
import { createHash } from 'node:crypto';

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function parsePositiveInt(value, fallback, max = 200) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, max);
}

function canaryBucketBps({ canaryConfig, actor, idempotencyKey, requestedAt }) {
  const actorType = normalizeOptionalString(actor?.type) ?? 'unknown';
  const actorId = normalizeOptionalString(actor?.id) ?? 'unknown';
  const safeIdempotencyKey = normalizeOptionalString(idempotencyKey) ?? 'none';
  const key = `${canaryConfig.salt}|${actorType}|${actorId}|${safeIdempotencyKey}|${requestedAt}`;
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
  const n = Number.parseInt(digest, 16);
  if (!Number.isFinite(n)) return 0;
  return n % 10000;
}

function rotateToSmallest(ids) {
  const min = [...ids].sort()[0];
  const idx = ids.indexOf(min);
  return [...ids.slice(idx), ...ids.slice(0, idx)];
}

function cycleKeyFromProposal(proposal) {
  const ids = (proposal?.participants ?? []).map(participant => String(participant?.intent_id ?? '')).filter(Boolean);
  if (ids.length === 0) return null;
  return rotateToSmallest(ids).join('>');
}

function scoreScaledFromProposal(proposal) {
  return Math.round(Number(proposal?.confidence_score ?? 0) * 10000);
}

function summarizeSelectedProposals(proposals) {
  const cycleKeys = [];
  let totalScoreScaled = 0;
  for (const proposal of proposals ?? []) {
    const cycleKey = cycleKeyFromProposal(proposal);
    if (cycleKey) cycleKeys.push(cycleKey);
    totalScoreScaled += scoreScaledFromProposal(proposal);
  }
  cycleKeys.sort();
  return {
    selected_count: (proposals ?? []).length,
    selected_cycle_keys: cycleKeys,
    selected_total_score_scaled: totalScoreScaled
  };
}

function runMatcherWithConfig({ intents, assetValuesUsd, edgeIntents, nowIso, config }) {
  const startedAtNs = process.hrtime.bigint();
  const matching = runMatchingJs({
    intents,
    assetValuesUsd,
    edgeIntents,
    nowIso,
    minCycleLength: config.min_cycle_length,
    maxCycleLength: config.max_cycle_length,
    maxEnumeratedCycles: config.max_cycles_explored,
    timeoutMs: config.timeout_ms,
    includeCycleDiagnostics: config.include_cycle_diagnostics === true
  });
  const runtimeMs = Number((process.hrtime.bigint() - startedAtNs) / 1000000n);

  return {
    matching,
    runtime_ms: runtimeMs
  };
}

function runMatcherTsShadowWithConfig({ intents, assetValuesUsd, edgeIntents, nowIso, config }) {
  const startedAtNs = process.hrtime.bigint();
  const matching = runMatchingTsShadow({
    intents,
    assetValuesUsd,
    edgeIntents,
    nowIso,
    minCycleLength: config.min_cycle_length,
    maxCycleLength: config.max_cycle_length,
    maxEnumeratedCycles: config.max_cycles_explored,
    timeoutMs: config.timeout_ms,
    includeCycleDiagnostics: config.include_cycle_diagnostics === true
  });
  const runtimeMs = Number((process.hrtime.bigint() - startedAtNs) / 1000000n);

  return {
    matching,
    runtime_ms: runtimeMs
  };
}

function ensureCanaryState(store) {
  store.state.marketplace_matching_canary_state ||= {};
  const state = store.state.marketplace_matching_canary_state;
  state.rollback_active = state.rollback_active === true;
  state.rollback_reason_code = normalizeOptionalString(state.rollback_reason_code);
  state.rollback_activated_at = normalizeOptionalString(state.rollback_activated_at);
  state.rollback_run_id = normalizeOptionalString(state.rollback_run_id);
  state.recent_samples = Array.isArray(state.recent_samples) ? state.recent_samples : [];
  return state;
}

function clearCanaryRollbackState(store) {
  const state = ensureCanaryState(store);
  state.rollback_active = false;
  state.rollback_reason_code = null;
  state.rollback_activated_at = null;
  state.rollback_run_id = null;
  state.recent_samples = [];
  return state;
}

function applyForcedSafetyTriggers({ safety, primaryConfig }) {
  return {
    timeout_reached: Boolean(safety?.timeout_reached) || primaryConfig.force_safety_timeout === true,
    max_cycles_reached: Boolean(safety?.max_cycles_reached) || primaryConfig.force_safety_limited === true
  };
}

function applySafetyToDiffRecord({ diffRecord, safety }) {
  if (!diffRecord?.v2_safety_triggers) return diffRecord;
  diffRecord.v2_safety_triggers.timeout_reached = Boolean(safety?.timeout_reached);
  diffRecord.v2_safety_triggers.max_cycles_reached = Boolean(safety?.max_cycles_reached);
  return diffRecord;
}

function updateCanaryRollbackState({ store, canaryConfig, runId, recordedAt, sample }) {
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

function buildShadowErrorRecord({ runId, recordedAt, v2Config, error }) {
  return {
    run_id: runId,
    recorded_at: recordedAt,
    shadow_error: {
      code: 'matching_v2_shadow_failed',
      name: String(error?.name ?? 'Error'),
      message: String(error?.message ?? 'shadow execution failed')
    },
    v2_cycle_bounds: {
      min_cycle_length: v2Config.min_cycle_length,
      max_cycle_length: v2Config.max_cycle_length
    },
    v2_safety_limits: {
      max_cycles_explored: v2Config.max_cycles_explored,
      timeout_ms: v2Config.timeout_ms
    }
  };
}

function buildShadowDiffRecord({
  runId,
  recordedAt,
  maxProposals,
  v1Config,
  v1Result,
  v2Config,
  v2Result
}) {
  const v1Selected = (v1Result?.matching?.proposals ?? []).slice(0, maxProposals);
  const v2Selected = (v2Result?.matching?.proposals ?? []).slice(0, maxProposals);
  const v1Summary = summarizeSelectedProposals(v1Selected);
  const v2Summary = summarizeSelectedProposals(v2Selected);

  const v1Set = new Set(v1Summary.selected_cycle_keys);
  const v2Set = new Set(v2Summary.selected_cycle_keys);
  const overlap = [...v1Set].filter(cycleKey => v2Set.has(cycleKey)).sort();
  const onlyV1 = [...v1Set].filter(cycleKey => !v2Set.has(cycleKey)).sort();
  const onlyV2 = [...v2Set].filter(cycleKey => !v1Set.has(cycleKey)).sort();
  const deltaScoreScaled = v2Summary.selected_total_score_scaled - v1Summary.selected_total_score_scaled;

  return {
    run_id: runId,
    recorded_at: recordedAt,
    max_proposals: maxProposals,
    v1_cycle_bounds: {
      min_cycle_length: v1Config.min_cycle_length,
      max_cycle_length: v1Config.max_cycle_length
    },
    v2_cycle_bounds: {
      min_cycle_length: v2Config.min_cycle_length,
      max_cycle_length: v2Config.max_cycle_length
    },
    v2_safety_limits: {
      max_cycles_explored: v2Config.max_cycles_explored,
      timeout_ms: v2Config.timeout_ms
    },
    metrics: {
      v1_candidate_cycles: Number(v1Result?.matching?.stats?.candidate_cycles ?? 0),
      v2_candidate_cycles: Number(v2Result?.matching?.stats?.candidate_cycles ?? 0),
      v1_selected_proposals: Number(v1Summary.selected_count ?? 0),
      v2_selected_proposals: Number(v2Summary.selected_count ?? 0),
      v1_vs_v2_overlap: overlap.length,
      delta_score_sum_scaled: deltaScoreScaled,
      delta_score_sum: scoreScaledToDecimal(deltaScoreScaled),
      v1_runtime_ms: Number(v1Result?.runtime_ms ?? 0),
      v2_runtime_ms: Number(v2Result?.runtime_ms ?? 0)
    },
    v2_safety_triggers: {
      max_cycles_reached: Boolean(v2Result?.matching?.stats?.cycle_enumeration_limited),
      timeout_reached: Boolean(v2Result?.matching?.stats?.cycle_enumeration_timed_out)
    },
    selected_cycle_keys: {
      overlap_count: overlap.length,
      only_v1_count: onlyV1.length,
      only_v2_count: onlyV2.length,
      overlap,
      only_v1: onlyV1,
      only_v2: onlyV2
    }
  };
}

function buildTsShadowErrorRecord({ runId, recordedAt, primaryEngine, matcherConfig, error }) {
  return {
    run_id: runId,
    recorded_at: recordedAt,
    primary_engine: primaryEngine,
    ts_shadow_error: {
      code: 'matching_ts_shadow_failed',
      name: String(error?.name ?? 'Error'),
      message: String(error?.message ?? 'typescript shadow execution failed')
    },
    matcher_cycle_bounds: {
      min_cycle_length: matcherConfig.min_cycle_length,
      max_cycle_length: matcherConfig.max_cycle_length
    },
    matcher_safety_limits: {
      max_cycles_explored: matcherConfig.max_cycles_explored,
      timeout_ms: matcherConfig.timeout_ms
    }
  };
}

function buildTsShadowDiffRecord({
  runId,
  recordedAt,
  maxProposals,
  primaryEngine,
  matcherConfig,
  jsResult,
  tsResult
}) {
  const jsSelected = (jsResult?.matching?.proposals ?? []).slice(0, maxProposals);
  const tsSelected = (tsResult?.matching?.proposals ?? []).slice(0, maxProposals);
  const jsSummary = summarizeSelectedProposals(jsSelected);
  const tsSummary = summarizeSelectedProposals(tsSelected);

  const jsSet = new Set(jsSummary.selected_cycle_keys);
  const tsSet = new Set(tsSummary.selected_cycle_keys);
  const overlap = [...jsSet].filter(cycleKey => tsSet.has(cycleKey)).sort();
  const onlyJs = [...jsSet].filter(cycleKey => !tsSet.has(cycleKey)).sort();
  const onlyTs = [...tsSet].filter(cycleKey => !jsSet.has(cycleKey)).sort();
  const deltaScoreScaled = tsSummary.selected_total_score_scaled - jsSummary.selected_total_score_scaled;

  return {
    run_id: runId,
    recorded_at: recordedAt,
    primary_engine: primaryEngine,
    max_proposals: maxProposals,
    matcher_cycle_bounds: {
      min_cycle_length: matcherConfig.min_cycle_length,
      max_cycle_length: matcherConfig.max_cycle_length
    },
    matcher_safety_limits: {
      max_cycles_explored: matcherConfig.max_cycles_explored,
      timeout_ms: matcherConfig.timeout_ms
    },
    metrics: {
      js_candidate_cycles: Number(jsResult?.matching?.stats?.candidate_cycles ?? 0),
      ts_candidate_cycles: Number(tsResult?.matching?.stats?.candidate_cycles ?? 0),
      js_selected_proposals: Number(jsSummary.selected_count ?? 0),
      ts_selected_proposals: Number(tsSummary.selected_count ?? 0),
      js_vs_ts_overlap: overlap.length,
      delta_score_sum_scaled: deltaScoreScaled,
      delta_score_sum: scoreScaledToDecimal(deltaScoreScaled),
      js_runtime_ms: Number(jsResult?.runtime_ms ?? 0),
      ts_runtime_ms: Number(tsResult?.runtime_ms ?? 0)
    },
    js_safety_triggers: {
      max_cycles_reached: Boolean(jsResult?.matching?.stats?.cycle_enumeration_limited),
      timeout_reached: Boolean(jsResult?.matching?.stats?.cycle_enumeration_timed_out)
    },
    ts_safety_triggers: {
      max_cycles_reached: Boolean(tsResult?.matching?.stats?.cycle_enumeration_limited),
      timeout_reached: Boolean(tsResult?.matching?.stats?.cycle_enumeration_timed_out)
    },
    selected_cycle_keys: {
      overlap_count: overlap.length,
      only_js_count: onlyJs.length,
      only_ts_count: onlyTs.length,
      overlap,
      only_js: onlyJs,
      only_ts: onlyTs
    }
  };
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

function normalizeAssetValuesMap(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const out = {};
  for (const [assetId, amount] of Object.entries(value)) {
    const key = normalizeOptionalString(assetId);
    const numeric = Number(amount);
    if (!key || !Number.isFinite(numeric) || numeric < 0) return null;
    out[key] = numeric;
  }
  return out;
}

function valueFromAsset(asset) {
  const candidates = [
    asset?.estimated_value_usd,
    asset?.value_usd,
    asset?.metadata?.estimated_value_usd,
    asset?.metadata?.value_usd
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  return null;
}

function deriveAssetValuesFromIntents(intents) {
  const out = {};
  for (const intent of intents ?? []) {
    for (const asset of intent?.offer ?? []) {
      const assetId = normalizeOptionalString(asset?.asset_id);
      const value = valueFromAsset(asset);
      if (assetId && value !== null) out[assetId] = value;
    }
  }
  return out;
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

function proposalInUse({ store, proposalId }) {
  const commitId = commitIdForProposalId(proposalId);
  if (store.state?.commits?.[commitId]) return true;
  if (store.state?.timelines?.[proposalId]) return true;
  if (Object.values(store.state?.receipts ?? {}).some(receipt => receipt?.cycle_id === proposalId)) return true;
  if (Object.values(store.state?.reservations ?? {}).some(reservation => reservation?.cycle_id === proposalId)) return true;
  return false;
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

  _expireMarketplaceProposals({ nowIso }) {
    const nowMs = parseIsoMs(nowIso) ?? Date.now();
    let expired = 0;

    for (const proposalId of Object.keys(this.store.state.marketplace_matching_proposal_runs ?? {})) {
      const proposal = this.store.state.proposals?.[proposalId] ?? null;
      if (!proposal) {
        delete this.store.state.marketplace_matching_proposal_runs[proposalId];
        continue;
      }

      const expiresMs = parseIsoMs(proposal?.expires_at);
      if (expiresMs === null || expiresMs > nowMs) continue;
      if (proposalInUse({ store: this.store, proposalId })) continue;

      delete this.store.state.proposals[proposalId];
      delete this.store.state.tenancy?.proposals?.[proposalId];
      delete this.store.state.marketplace_matching_proposal_runs[proposalId];
      expired += 1;
    }

    return expired;
  }

  _replaceMarketplaceProposals() {
    let replaced = 0;

    for (const proposalId of Object.keys(this.store.state.marketplace_matching_proposal_runs ?? {})) {
      if (proposalInUse({ store: this.store, proposalId })) continue;
      delete this.store.state.proposals[proposalId];
      delete this.store.state.tenancy?.proposals?.[proposalId];
      delete this.store.state.marketplace_matching_proposal_runs[proposalId];
      replaced += 1;
    }

    return replaced;
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

        const expiredProposalsCount = this._expireMarketplaceProposals({ nowIso: requestedAt });
        const replacedProposalsCount = replaceExisting ? this._replaceMarketplaceProposals() : 0;

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
