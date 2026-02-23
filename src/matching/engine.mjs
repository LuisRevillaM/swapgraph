import { buildCompatibilityGraph } from './graph.mjs';
import { findBoundedSimpleCycles } from './cycles.mjs';
import { selectDisjointProposals } from './proposals.mjs';

export function runMatching({
  intents,
  assetValuesUsd,
  edgeIntents = [],
  nowIso = null,
  minCycleLength = 2,
  maxCycleLength = 3,
  maxEnumeratedCycles = null,
  timeoutMs = null
}) {
  const { byId, edges, edgeMeta } = buildCompatibilityGraph({ intents, assetValuesUsd, edgeIntents, nowIso });
  const cycleDiagnostics = {};
  const all = findBoundedSimpleCycles({
    edges,
    minCycleLength,
    maxCycleLength,
    maxEnumeratedCycles,
    timeoutMs,
    diagnostics: cycleDiagnostics
  });

  const { selected, trace, candidates_count } = selectDisjointProposals({
    candidateCycles: all,
    byId,
    assetValuesUsd,
    edgeMeta
  });

  return {
    proposals: selected,
    trace,
    stats: {
      intents_active: byId.size,
      edges: [...edges.values()].reduce((a, v) => a + v.length, 0),
      candidate_cycles: all.length,
      candidate_proposals: candidates_count,
      selected_proposals: selected.length,
      cycle_enumeration_limited: Boolean(cycleDiagnostics.max_cycles_reached),
      cycle_enumeration_timed_out: Boolean(cycleDiagnostics.timeout_reached)
    }
  };
}
