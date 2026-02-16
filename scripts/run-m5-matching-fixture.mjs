import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { runMatching } from '../src/matching/engine.mjs';

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

const input = readJson(path.join(root, 'fixtures/matching/m5_input.json'));
const expected = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));

const result = runMatching({ intents: input.intents, assetValuesUsd: input.asset_values_usd });

// Validate proposals against CycleProposal schema via AJV.
const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  const s = readJson(path.join(schemasDir, sf));
  ajv.addSchema(s);
}

const listSchema = readJson(path.join(schemasDir, 'CycleProposalListResponse.schema.json'));
const validateList = ajv.getSchema(listSchema.$id) ?? ajv.compile(listSchema);
const payload = { proposals: result.proposals };
const ok = validateList(payload);
if (!ok) {
  throw new Error(`matching output invalid: ${JSON.stringify(validateList.errors)}`);
}

// Compare to expected (deterministic)
assert.deepEqual(result, expected);

writeFileSync(path.join(outDir, 'matching_output.json'), JSON.stringify(result, null, 2));
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M5', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: result.stats }, null, 2));
