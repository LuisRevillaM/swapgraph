import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  buildCustodySnapshot,
  buildCustodyInclusionProof,
  verifyCustodyInclusionProof,
  normalizeCustodyHolding,
  custodyHoldingKey
} from '../src/custody/proofOfCustody.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function flipHexTail(hex) {
  const s = String(hex ?? '');
  if (!s) return s;
  const tail = s.slice(-1);
  const repl = tail === '0' ? '1' : '0';
  return `${s.slice(0, -1)}${repl}`;
}

const schemasDir = path.join(root, 'docs/spec/schemas');
const custodySnapshotSchema = readJson(path.join(schemasDir, 'CustodySnapshot.schema.json'));
const custodyInclusionProofSchema = readJson(path.join(schemasDir, 'CustodyInclusionProof.schema.json'));
const actorRefSchema = readJson(path.join(schemasDir, 'ActorRef.schema.json'));
const assetRefSchema = readJson(path.join(schemasDir, 'AssetRef.schema.json'));
const custodyHoldingSchema = readJson(path.join(schemasDir, 'CustodyHolding.schema.json'));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(actorRefSchema);
ajv.addSchema(assetRefSchema);
ajv.addSchema(custodyHoldingSchema);
ajv.addSchema(custodySnapshotSchema);
ajv.addSchema(custodyInclusionProofSchema);

const validateSnapshot = ajv.getSchema(custodySnapshotSchema.$id) ?? ajv.compile(custodySnapshotSchema);
const validateProof = ajv.getSchema(custodyInclusionProofSchema.$id) ?? ajv.compile(custodyInclusionProofSchema);

const scenario = readJson(path.join(root, 'fixtures/custody/m46_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/custody/m46_expected.json'));

const snapshot = buildCustodySnapshot({
  snapshotId: scenario.snapshot?.snapshot_id,
  recordedAt: scenario.snapshot?.recorded_at,
  holdings: scenario.snapshot?.holdings ?? []
});

if (!validateSnapshot(snapshot)) {
  throw new Error(`snapshot schema invalid: ${JSON.stringify(validateSnapshot.errors ?? [])}`);
}

const holdingsById = new Map((scenario.snapshot?.holdings ?? []).map(h => [h.holding_id, normalizeCustodyHolding(h)]));
const proofsByHoldingId = new Map();

const positiveChecks = [];
for (const check of scenario.proof_checks ?? []) {
  const normalizedHolding = holdingsById.get(check.holding_id);
  if (!normalizedHolding) throw new Error(`missing holding in scenario: ${check.holding_id}`);

  const proofResult = buildCustodyInclusionProof({ snapshot, holding: normalizedHolding });
  if (!proofResult.ok) throw new Error(`proof generation failed for ${check.holding_id}: ${proofResult.error}`);

  const proof = proofResult.proof;
  if (!validateProof(proof)) {
    throw new Error(`proof schema invalid for ${check.holding_id}: ${JSON.stringify(validateProof.errors ?? [])}`);
  }

  const verifyResult = verifyCustodyInclusionProof({ snapshot, holding: normalizedHolding, proof });

  const record = {
    holding_id: check.holding_id,
    holding_key: custodyHoldingKey(normalizedHolding),
    proof_leaf_index: proof.leaf_index,
    proof_siblings_count: (proof.siblings ?? []).length,
    verify_ok: verifyResult.ok,
    verify_error: verifyResult.ok ? null : verifyResult.error,
    derived_root_hash: verifyResult.details?.derived_root_hash ?? null
  };

  positiveChecks.push(record);
  proofsByHoldingId.set(check.holding_id, proof);

  if (typeof check.expect_ok === 'boolean') assert.equal(record.verify_ok, check.expect_ok);
}

const negativeChecks = [];
for (const check of scenario.negative_checks ?? []) {
  if (check.kind === 'build_missing') {
    const missingHolding = normalizeCustodyHolding(check.holding);
    const proofResult = buildCustodyInclusionProof({ snapshot, holding: missingHolding });

    const record = {
      name: check.name,
      kind: check.kind,
      ok: proofResult.ok,
      error: proofResult.ok ? null : proofResult.error,
      details: proofResult.ok ? null : (proofResult.details ?? null)
    };

    negativeChecks.push(record);

    assert.equal(record.ok, false);
    if (check.expect_error) assert.equal(record.error, check.expect_error);
    continue;
  }

  const sourceHolding = holdingsById.get(check.source_holding_id);
  if (!sourceHolding) throw new Error(`missing source_holding_id for negative check: ${check.name}`);

  const sourceProof = proofsByHoldingId.get(check.source_holding_id);
  if (!sourceProof) throw new Error(`missing source proof for negative check: ${check.name}`);

  const proof = clone(sourceProof);
  const holding = clone(sourceHolding);

  if (check.kind === 'tamper_sibling_hash') {
    const siblingIndex = Number.isInteger(check.sibling_index) ? check.sibling_index : 0;
    if (!proof.siblings?.[siblingIndex]) throw new Error(`missing sibling index ${siblingIndex} for ${check.name}`);
    proof.siblings[siblingIndex].hash = flipHexTail(proof.siblings[siblingIndex].hash);
  } else if (check.kind === 'tamper_holding_asset') {
    holding.asset.asset_id = check.override_asset_id;
  } else if (check.kind === 'tamper_sibling_position') {
    const siblingIndex = Number.isInteger(check.sibling_index) ? check.sibling_index : 0;
    if (!proof.siblings?.[siblingIndex]) throw new Error(`missing sibling index ${siblingIndex} for ${check.name}`);
    proof.siblings[siblingIndex].position = check.override_position;
  } else {
    throw new Error(`unsupported negative check kind: ${check.kind}`);
  }

  const verifyResult = verifyCustodyInclusionProof({ snapshot, holding, proof });

  const record = {
    name: check.name,
    kind: check.kind,
    ok: verifyResult.ok,
    error: verifyResult.ok ? null : verifyResult.error,
    details: verifyResult.ok ? null : (verifyResult.details ?? null)
  };

  negativeChecks.push(record);

  if (typeof check.expect_ok === 'boolean') assert.equal(record.ok, check.expect_ok);
  if (check.expect_error) assert.equal(record.error, check.expect_error);
}

const out = canonicalize({
  snapshot_summary: {
    snapshot_id: snapshot.snapshot_id,
    recorded_at: snapshot.recorded_at,
    leaf_count: snapshot.leaf_count,
    root_hash: snapshot.root_hash,
    holding_keys: snapshot.holdings.map(h => h.holding_key),
    leaf_hashes: snapshot.holdings.map(h => h.leaf_hash)
  },
  positive_checks: positiveChecks,
  negative_checks: negativeChecks
});

writeFileSync(path.join(outDir, 'proof_of_custody_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M46', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { leaf_count: snapshot.leaf_count, positives: positiveChecks.length, negatives: negativeChecks.length } }, null, 2));
