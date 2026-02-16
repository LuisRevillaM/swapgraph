import { buildCompatibilityGraph } from './graph.mjs';
import { findCyclesLen2, findCyclesLen3 } from './cycles.mjs';
import { selectDisjointProposals } from './proposals.mjs';

export function runMatching({ intents, assetValuesUsd }) {
  const { byId, edges } = buildCompatibilityGraph({ intents, assetValuesUsd });
  const c2 = findCyclesLen2({ edges });
  const c3 = findCyclesLen3({ edges });
  const all = [...c2, ...c3];

  const { selected, trace, candidates_count } = selectDisjointProposals({
    candidateCycles: all,
    byId,
    assetValuesUsd
  });

  return {
    proposals: selected,
    trace,
    stats: {
      intents_active: byId.size,
      edges: [...edges.values()].reduce((a, v) => a + v.length, 0),
      candidate_cycles: all.length,
      candidate_proposals: candidates_count,
      selected_proposals: selected.length
    }
  };
}
