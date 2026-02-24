import crypto from 'node:crypto';
import { valueOfAssets, round, clamp01 } from './values.mts';
import { computeValueSpread, scoreCycle } from './scoring.mts';

const EXACT_COMPONENT_MAX = 18;

function cycleKey(ids) {
  return ids.join('>');
}

function cycleId(ids) {
  // Deterministic stable id.
  const h = crypto.createHash('sha256').update(cycleKey(ids)).digest('hex').slice(0, 12);
  return `cycle_${h}`;
}

function edgeKey(sourceIntentId, targetIntentId) {
  return `${sourceIntentId}>${targetIntentId}`;
}

function minIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function buildProposal({ cycleIntentIds, byId, assetValuesUsd, edgeMeta = null }) {
  const L = cycleIntentIds.length;
  const intents = cycleIntentIds.map(id => byId.get(id));

  // Enforce max_cycle_length for each intent.
  for (const it of intents) {
    const maxLen = it?.trust_constraints?.max_cycle_length;
    if (typeof maxLen === 'number' && maxLen < L) {
      return { ok: false, reason: 'max_cycle_length_exceeded' };
    }
  }

  // Expires at = earliest expiry among intents.
  let expiresAt = null;
  for (const it of intents) {
    expiresAt = minIso(expiresAt, it?.time_constraints?.expires_at ?? null);
  }

  const participants = [];
  const getValues = [];
  let explicitPreferenceStrength = 0;

  for (let i = 0; i < L; i++) {
    const a = intents[i];
    const b = intents[(i + 1) % L];
    const give = a.offer;
    const get = b.offer;

    const gv = valueOfAssets({ assets: get, assetValuesUsd });
    getValues.push(gv);
    explicitPreferenceStrength += Number(edgeMeta?.get(edgeKey(a.id, b.id))?.explicit_prefer_strength ?? 0);

    participants.push({
      intent_id: a.id,
      actor: a.actor,
      give,
      get
    });
  }

  const valueSpread = round(computeValueSpread({ getValues }), 4);
  const baseConfidence = scoreCycle({ length: L, valueSpread });
  const preferenceBonus = round(Math.min(0.1, explicitPreferenceStrength * 0.02), 4);
  const confidence = round(clamp01(baseConfidence + preferenceBonus), 4);

  // Fee: 1% of what you receive.
  const fee_breakdown = participants.map((p, idx) => ({
    actor: p.actor,
    fee_usd: round(getValues[idx] * 0.01, 2)
  }));

  const explainability = [
    'All wants satisfied within explicit constraints',
    `cycle_length=${L}`,
    `value_spread=${valueSpread}`,
    `explicit_preference_strength=${round(explicitPreferenceStrength, 4)}`,
    `confidence_score=${confidence}`
  ];

  return {
    ok: true,
    proposal: {
      id: cycleId(cycleIntentIds),
      expires_at: expiresAt ?? new Date(0).toISOString(),
      participants,
      confidence_score: confidence,
      value_spread: valueSpread,
      fee_breakdown,
      explainability
    }
  };
}

function sortCandidates(candidates) {
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.proposal.id.localeCompare(b.proposal.id);
  });
}

function buildConflictAdjacency(candidates) {
  const adjacency = Array.from({ length: candidates.length }, () => new Set());
  const byIntent = new Map();

  for (let idx = 0; idx < candidates.length; idx += 1) {
    for (const intentId of candidates[idx].intent_ids) {
      const list = byIntent.get(intentId) ?? [];
      list.push(idx);
      byIntent.set(intentId, list);
    }
  }

  for (const idxs of byIntent.values()) {
    for (let i = 0; i < idxs.length; i += 1) {
      for (let j = i + 1; j < idxs.length; j += 1) {
        const a = idxs[i];
        const b = idxs[j];
        adjacency[a].add(b);
        adjacency[b].add(a);
      }
    }
  }

  return adjacency;
}

function connectedComponents(adjacency) {
  const seen = new Set();
  const components = [];

  for (let i = 0; i < adjacency.length; i += 1) {
    if (seen.has(i)) continue;
    const stack = [i];
    seen.add(i);
    const component = [];

    while (stack.length > 0) {
      const node = stack.pop();
      component.push(node);
      for (const neighbor of adjacency[node]) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        stack.push(neighbor);
      }
    }

    component.sort((a, b) => a - b);
    components.push(component);
  }

  return components;
}

function selectComponentGreedy({ component, adjacency }) {
  const selected = [];
  const blocked = new Set();

  for (const idx of component) {
    if (blocked.has(idx)) continue;
    selected.push(idx);
    blocked.add(idx);
    for (const neighbor of adjacency[idx]) blocked.add(neighbor);
  }

  return selected;
}

function selectComponentExact({ component, candidates, adjacency }) {
  const localToGlobal = [...component].sort((a, b) => a - b);
  const globalToLocal = new Map(localToGlobal.map((g, i) => [g, i]));
  const n = localToGlobal.length;
  const localConflicts = Array.from({ length: n }, () => 0n);
  const weights = localToGlobal.map(globalIdx => Math.round(Number(candidates[globalIdx].score ?? 0) * 10000));
  const proposalIds = localToGlobal.map(globalIdx => String(candidates[globalIdx].proposal.id));

  for (let localIdx = 0; localIdx < n; localIdx += 1) {
    const globalIdx = localToGlobal[localIdx];
    let mask = 0n;
    for (const neighborGlobal of adjacency[globalIdx]) {
      const neighborLocal = globalToLocal.get(neighborGlobal);
      if (neighborLocal === undefined) continue;
      mask |= (1n << BigInt(neighborLocal));
    }
    localConflicts[localIdx] = mask;
  }

  const memo = new Map();
  const signatureCache = new Map();

  function signatureForPicks(picksMask) {
    const cached = signatureCache.get(picksMask);
    if (cached !== undefined) return cached;
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      if (((picksMask >> BigInt(i)) & 1n) === 1n) ids.push(proposalIds[i]);
    }
    ids.sort();
    const signature = ids.join('>');
    signatureCache.set(picksMask, signature);
    return signature;
  }

  function better(a, b) {
    if (a.score_scaled !== b.score_scaled) {
      return a.score_scaled > b.score_scaled ? a : b;
    }
    const aSig = signatureForPicks(a.picks_mask);
    const bSig = signatureForPicks(b.picks_mask);
    return aSig.localeCompare(bSig) <= 0 ? a : b;
  }

  function solve(mask) {
    if (mask === 0n) return { score_scaled: 0, picks_mask: 0n };
    const key = mask.toString();
    const cached = memo.get(key);
    if (cached) return cached;

    let localIdx = 0;
    while (((mask >> BigInt(localIdx)) & 1n) === 0n) localIdx += 1;

    const bit = 1n << BigInt(localIdx);
    const without = mask & ~bit;

    const skip = solve(without);
    const takeRest = solve(without & ~localConflicts[localIdx]);
    const take = {
      score_scaled: takeRest.score_scaled + weights[localIdx],
      picks_mask: takeRest.picks_mask | bit
    };

    const best = better(take, skip);
    memo.set(key, best);
    return best;
  }

  const fullMask = (1n << BigInt(n)) - 1n;
  const best = solve(fullMask);

  const selected = [];
  for (let i = 0; i < n; i += 1) {
    if (((best.picks_mask >> BigInt(i)) & 1n) === 1n) {
      selected.push(localToGlobal[i]);
    }
  }

  return selected.sort((a, b) => a - b);
}

function selectDisjointCandidateIndexes(candidates) {
  if (candidates.length === 0) return { selectedIndexes: new Set(), adjacency: [] };

  const adjacency = buildConflictAdjacency(candidates);
  const components = connectedComponents(adjacency);
  const selected = new Set();

  for (const component of components) {
    const picked = component.length <= EXACT_COMPONENT_MAX
      ? selectComponentExact({ component, candidates, adjacency })
      : selectComponentGreedy({ component, adjacency });
    for (const idx of picked) selected.add(idx);
  }

  return { selectedIndexes: selected, adjacency };
}

export function selectDisjointProposals({ candidateCycles, byId, assetValuesUsd, edgeMeta = null }) {
  const candidates = [];
  for (const cyc of candidateCycles) {
    const built = buildProposal({ cycleIntentIds: cyc, byId, assetValuesUsd, edgeMeta });
    if (!built.ok) continue;
    const L = cyc.length;
    candidates.push({
      intent_ids: cyc,
      proposal: built.proposal,
      score: built.proposal.confidence_score,
      length: L
    });
  }

  sortCandidates(candidates);
  const { selectedIndexes, adjacency } = selectDisjointCandidateIndexes(candidates);
  const trace = [];
  const selected = [];

  for (let idx = 0; idx < candidates.length; idx += 1) {
    const c = candidates[idx];
    const picked = selectedIndexes.has(idx);
    let conflict = false;
    if (!picked) {
      for (const selectedIdx of selectedIndexes) {
        if (adjacency[idx]?.has(selectedIdx)) {
          conflict = true;
          break;
        }
      }
    }
    trace.push({
      cycle: c.intent_ids,
      proposal_id: c.proposal.id,
      score: c.score,
      selected: picked,
      reason: picked ? 'picked' : (conflict ? 'conflict_shared_intent' : 'not_selected_optimizer')
    });
    if (!picked) continue;
    selected.push(c.proposal);
  }

  return { selected, trace, candidates_count: candidates.length };
}
