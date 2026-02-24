import { scoreScaledToDecimal } from './marketplaceMatchingHelpers.mts';

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

export function summarizeSelectedProposals(proposals) {
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

export function applyForcedSafetyTriggers({ safety, primaryConfig }) {
  return {
    timeout_reached: Boolean(safety?.timeout_reached) || primaryConfig.force_safety_timeout === true,
    max_cycles_reached: Boolean(safety?.max_cycles_reached) || primaryConfig.force_safety_limited === true
  };
}

export function applySafetyToDiffRecord({ diffRecord, safety }) {
  if (!diffRecord?.v2_safety_triggers) return diffRecord;
  diffRecord.v2_safety_triggers.timeout_reached = Boolean(safety?.timeout_reached);
  diffRecord.v2_safety_triggers.max_cycles_reached = Boolean(safety?.max_cycles_reached);
  return diffRecord;
}

export function buildShadowErrorRecord({ runId, recordedAt, v2Config, error }) {
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

export function buildShadowDiffRecord({
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

export function buildTsShadowErrorRecord({ runId, recordedAt, primaryEngine, matcherConfig, error }) {
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

export function buildTsShadowDiffRecord({
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
