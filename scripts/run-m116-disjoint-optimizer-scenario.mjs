import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { buildProposal, selectDisjointProposals } from '../src/matching/proposals.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M116';
const SCENARIO_FILE = 'fixtures/release/m116_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m116_expected.json';
const OUTPUT_FILE = 'disjoint_optimizer_output.json';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function scoreScaled(score) {
  return Math.round(Number(score ?? 0) * 10000);
}

function rotateToSmallest(ids) {
  const min = [...ids].sort()[0];
  const idx = ids.indexOf(min);
  return [...ids.slice(idx), ...ids.slice(0, idx)];
}

function cycleKeyFromProposal(proposal) {
  const ids = (proposal?.participants ?? []).map(p => String(p?.intent_id ?? '')).filter(Boolean);
  if (ids.length === 0) return null;
  return rotateToSmallest(ids).join('>');
}

function stableHash(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function buildCandidates({ candidateCycles, byId, assetValuesUsd, edgeMeta = null }) {
  const candidates = [];
  for (const cycle of candidateCycles ?? []) {
    const built = buildProposal({ cycleIntentIds: cycle, byId, assetValuesUsd, edgeMeta });
    if (!built.ok) continue;
    candidates.push({
      intent_ids: cycle,
      proposal: built.proposal,
      score: built.proposal.confidence_score
    });
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.proposal.id.localeCompare(b.proposal.id);
  });
  return candidates;
}

function greedyBaselineSelect({ candidates }) {
  const usedIntents = new Set();
  const selected = [];

  for (const candidate of candidates) {
    const conflict = candidate.intent_ids.some(id => usedIntents.has(id));
    if (conflict) continue;
    selected.push(candidate);
    for (const intentId of candidate.intent_ids) usedIntents.add(intentId);
  }

  return selected;
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const byId = new Map((scenario.intents ?? []).map(intent => [intent.id, intent]));
const operations = [];

for (const op of scenario.operations ?? []) {
  const candidateCycles = op.candidate_cycles ?? [];
  const assetValuesUsd = scenario.asset_values_usd ?? {};
  const candidates = buildCandidates({ candidateCycles, byId, assetValuesUsd });
  const baseline = greedyBaselineSelect({ candidates });

  const optimizedA = selectDisjointProposals({ candidateCycles, byId, assetValuesUsd });
  const optimizedB = selectDisjointProposals({ candidateCycles, byId, assetValuesUsd });
  assert.deepEqual(optimizedA, optimizedB, `optimizer_non_deterministic op=${op.name ?? 'unnamed'}`);

  const greedyScoreScaled = baseline.reduce((sum, row) => sum + scoreScaled(row.score), 0);
  const optimizedScoreScaled = (optimizedA.selected ?? [])
    .reduce((sum, proposal) => sum + scoreScaled(proposal?.confidence_score), 0);

  const rec = {
    op: op.name ?? 'unnamed',
    candidate_proposals: candidates.length,
    greedy_selected_count: baseline.length,
    greedy_total_score_scaled: greedyScoreScaled,
    greedy_selected_cycle_keys: baseline.map(row => cycleKeyFromProposal(row.proposal)).filter(Boolean).sort(),
    optimal_selected_count: optimizedA.selected?.length ?? 0,
    optimal_total_score_scaled: optimizedScoreScaled,
    optimal_selected_cycle_keys: (optimizedA.selected ?? []).map(cycleKeyFromProposal).filter(Boolean).sort(),
    improvement_scaled: optimizedScoreScaled - greedyScoreScaled
  };

  for (const [key, value] of Object.entries(op)) {
    if (!key.startsWith('expect_')) continue;
    const field = key.slice('expect_'.length);
    assert.deepEqual(rec[field], value, `expectation_failed op=${rec.op} field=${field}`);
  }

  operations.push(rec);
}

const out = canonicalize({ operations });
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const actualHash = stableHash(out);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: actualHash,
  matched: actualHash === expected.expected_sha256,
  operations_count: operations.length
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
