import crypto from 'node:crypto';
import { valueOfAssets, round } from './values.mjs';
import { computeValueSpread, scoreCycle } from './scoring.mjs';

function cycleKey(ids) {
  return ids.join('>');
}

function cycleId(ids) {
  // Deterministic stable id.
  const h = crypto.createHash('sha256').update(cycleKey(ids)).digest('hex').slice(0, 12);
  return `cycle_${h}`;
}

function minIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function buildProposal({ cycleIntentIds, byId, assetValuesUsd }) {
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

  for (let i = 0; i < L; i++) {
    const a = intents[i];
    const b = intents[(i + 1) % L];
    const give = a.offer;
    const get = b.offer;

    const gv = valueOfAssets({ assets: get, assetValuesUsd });
    getValues.push(gv);

    participants.push({
      intent_id: a.id,
      actor: a.actor,
      give,
      get
    });
  }

  const valueSpread = round(computeValueSpread({ getValues }), 4);
  const confidence = scoreCycle({ length: L, valueSpread });

  // Fee: 1% of what you receive.
  const fee_breakdown = participants.map((p, idx) => ({
    actor: p.actor,
    fee_usd: round(getValues[idx] * 0.01, 2)
  }));

  const explainability = [
    'All wants satisfied within explicit constraints',
    `cycle_length=${L}`,
    `value_spread=${valueSpread}`,
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

export function selectDisjointProposals({ candidateCycles, byId, assetValuesUsd }) {
  const candidates = [];
  for (const cyc of candidateCycles) {
    const built = buildProposal({ cycleIntentIds: cyc, byId, assetValuesUsd });
    if (!built.ok) continue;
    const L = cyc.length;
    candidates.push({
      intent_ids: cyc,
      proposal: built.proposal,
      score: built.proposal.confidence_score,
      length: L
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.proposal.id.localeCompare(b.proposal.id);
  });

  const used = new Set();
  const selected = [];
  const trace = [];

  for (const c of candidates) {
    const conflict = c.intent_ids.some(id => used.has(id));
    trace.push({
      cycle: c.intent_ids,
      proposal_id: c.proposal.id,
      score: c.score,
      selected: !conflict,
      reason: conflict ? 'conflict_shared_intent' : 'picked'
    });
    if (conflict) continue;
    selected.push(c.proposal);
    c.intent_ids.forEach(id => used.add(id));
  }

  return { selected, trace, candidates_count: candidates.length };
}
