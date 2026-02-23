import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { runMatching } from '../src/matching/engine.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M115';
const SCENARIO_FILE = 'fixtures/release/m115_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m115_expected.json';
const OUTPUT_FILE = 'bounded_cycle_matching_output.json';

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

function stableHash(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const operations = [];

for (const op of scenario.operations ?? []) {
  const request = {
    intents: scenario.matching_input?.intents ?? [],
    assetValuesUsd: scenario.matching_input?.asset_values_usd ?? {},
    minCycleLength: Number(op.min_cycle_length ?? 2),
    maxCycleLength: Number(op.max_cycle_length ?? 3)
  };

  const first = runMatching(request);
  const second = runMatching(request);

  // Determinism gate: same request must produce exactly the same result.
  assert.deepEqual(first, second, `non_deterministic_result max_cycle_length=${request.maxCycleLength}`);

  const selectedCycleKeys = [...new Set(
    (first.proposals ?? [])
      .map(cycleKeyFromProposal)
      .filter(Boolean)
  )].sort();

  const candidateCycleLengthsSorted = (first.trace ?? [])
    .map(entry => (Array.isArray(entry?.cycle) ? entry.cycle.length : null))
    .filter(length => Number.isFinite(length))
    .sort((a, b) => a - b);

  const rec = {
    min_cycle_length: request.minCycleLength,
    max_cycle_length: request.maxCycleLength,
    candidate_cycles: Number(first.stats?.candidate_cycles ?? 0),
    candidate_proposals: Number(first.stats?.candidate_proposals ?? 0),
    selected_proposals: Number(first.stats?.selected_proposals ?? 0),
    candidate_cycle_lengths_sorted: candidateCycleLengthsSorted,
    selected_cycle_keys: selectedCycleKeys
  };

  if (Object.prototype.hasOwnProperty.call(op, 'expect_candidate_cycles')) {
    assert.equal(rec.candidate_cycles, op.expect_candidate_cycles, 'candidate_cycles mismatch');
  }
  if (Object.prototype.hasOwnProperty.call(op, 'expect_candidate_proposals')) {
    assert.equal(rec.candidate_proposals, op.expect_candidate_proposals, 'candidate_proposals mismatch');
  }
  if (Object.prototype.hasOwnProperty.call(op, 'expect_selected_proposals')) {
    assert.equal(rec.selected_proposals, op.expect_selected_proposals, 'selected_proposals mismatch');
  }
  if (Object.prototype.hasOwnProperty.call(op, 'expect_candidate_cycle_lengths_sorted')) {
    assert.deepEqual(
      rec.candidate_cycle_lengths_sorted,
      op.expect_candidate_cycle_lengths_sorted,
      'candidate_cycle_lengths_sorted mismatch'
    );
  }
  if (Object.prototype.hasOwnProperty.call(op, 'expect_selected_cycle_keys')) {
    const expectedKeys = [...(op.expect_selected_cycle_keys ?? [])].sort();
    assert.deepEqual(rec.selected_cycle_keys, expectedKeys, 'selected_cycle_keys mismatch');
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
