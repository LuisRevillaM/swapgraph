import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { commitIdForProposalId } from '../commit/commitIds.mjs';
import { runMatching } from '../matching/engine.mjs';

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
    min_cycle_length: minCycleLength,
    max_cycle_length: maxCycleLength,
    max_cycles_explored: parseBoundedInt(process.env.MATCHING_V2_MAX_CYCLES_EXPLORED, {
      fallback: 20000,
      min: 1,
      max: 200000
    }),
    timeout_ms: parseBoundedInt(process.env.MATCHING_V2_TIMEOUT_MS, {
      fallback: 100,
      min: 1,
      max: 5000
    })
  };
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
    timeoutMs: config.timeout_ms
  });
  const runtimeMs = Number((process.hrtime.bigint() - startedAtNs) / 1000000n);

  return {
    matching,
    runtime_ms: runtimeMs
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
          max_cycles_explored: null,
          timeout_ms: null
        };
        const v2Config = readMatchingV2ShadowConfigFromEnv();

        const v1Result = runMatcherWithConfig({
          intents: activeIntents,
          assetValuesUsd,
          edgeIntents,
          nowIso: requestedAt,
          config: v1Config
        });
        const matching = v1Result.matching;
        const selected = (matching?.proposals ?? []).slice(0, maxProposals);
        const runId = nextRunId(this.store);

        if (v2Config.shadow_enabled) {
          const v2Result = runMatcherWithConfig({
            intents: activeIntents,
            assetValuesUsd,
            edgeIntents,
            nowIso: requestedAt,
            config: v2Config
          });

          this.store.state.marketplace_matching_shadow_diffs[runId] = buildShadowDiffRecord({
            runId,
            recordedAt: requestedAt,
            maxProposals,
            v1Config,
            v1Result,
            v2Config,
            v2Result
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
