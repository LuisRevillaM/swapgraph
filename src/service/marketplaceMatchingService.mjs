import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { commitIdForProposalId } from '../commit/commitIds.mjs';
import { runMatching } from '../matching/engine.mjs';
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

function scoreScaledToDecimal(scoreScaled) {
  return Number((Number(scoreScaled ?? 0) / 10000).toFixed(4));
}

function readMatchingV2ShadowConfigFromEnv() {
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

function readMatchingV2CanaryConfigFromEnv() {
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

function toBps(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((Number(numerator ?? 0) * 10000) / denominator);
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
  const matching = runMatching({
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

function pruneShadowDiffHistory({ store, maxShadowDiffs }) {
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

function summarizeCanarySamples({ samples, canaryConfig }) {
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

function pruneCanaryDecisionHistory({ store, maxCanaryDecisions }) {
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
        const canaryConfig = readMatchingV2CanaryConfigFromEnv();

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
        let primaryResult = v1Result;
        let primaryEngine = 'v1';

        let canaryBucketValue = null;
        let inCanaryBucket = false;
        let canarySkippedReason = 'canary_disabled';
        let canarySelected = false;
        let canaryRollbackBefore = { active: false, reason_code: null };
        let canaryRollbackAfter = { active: false, reason_code: null };
        let canaryRollbackTriggered = false;
        let canarySampleSummary = summarizeCanarySamples({
          samples: [],
          canaryConfig
        });

        if (canaryConfig.enabled) {
          const canaryState = ensureCanaryState(this.store);
          canaryRollbackBefore = {
            active: canaryState.rollback_active === true,
            reason_code: canaryState.rollback_reason_code ?? null
          };
          canaryRollbackAfter = clone(canaryRollbackBefore);
          canarySampleSummary = summarizeCanarySamples({
            samples: canaryState.recent_samples,
            canaryConfig
          });

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

        if (canarySelected) {
          try {
            if (canaryConfig.force_canary_error) {
              throw new Error('forced matching v2 canary error');
            }

            v2Result = runMatcherWithConfig({
              intents: activeIntents,
              assetValuesUsd,
              edgeIntents,
              nowIso: requestedAt,
              config: v2Config
            });
            primaryResult = v2Result;
            primaryEngine = 'v2';
          } catch (error) {
            canaryError = error;
          }
        }

        let canaryDiffRecord = null;
        let shadowRecord = null;
        if (v2Config.shadow_enabled) {
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

            shadowRecord = buildShadowDiffRecord({
              runId,
              recordedAt: requestedAt,
              maxProposals,
              v1Config,
              v1Result,
              v2Config,
              v2Result
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
        }

        const matching = primaryResult.matching;
        const selected = (matching?.proposals ?? []).slice(0, maxProposals);

        if (canaryConfig.enabled) {
          const canarySample = !canarySelected
            ? null
            : {
              run_id: runId,
              recorded_at: requestedAt,
              error: Boolean(canaryError),
              timeout: canaryError ? false : Boolean(canaryDiffRecord?.v2_safety_triggers?.timeout_reached),
              limited: canaryError ? false : Boolean(canaryDiffRecord?.v2_safety_triggers?.max_cycles_reached),
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
            primary_engine: primaryEngine,
            routed_to_v2: primaryEngine === 'v2',
            fallback_to_v1: canarySelected && primaryEngine !== 'v2',
            canary_selected: canarySelected,
            canary_enabled: true,
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
                  code: 'matching_v2_canary_failed',
                  name: String(canaryError?.name ?? 'Error'),
                  message: String(canaryError?.message ?? 'v2 canary execution failed')
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
