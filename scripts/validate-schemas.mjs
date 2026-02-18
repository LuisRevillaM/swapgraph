import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = process.cwd();
const schemasDir = path.join(root, 'docs/spec/schemas');
const examplesDir = path.join(root, 'docs/spec/examples');

const schemaFiles = [
  'ActorRef.schema.json',
  'AssetRef.schema.json',
  'WantSpec.schema.json',
  'SwapIntent.schema.json',
  'CycleProposal.schema.json',
  'Commit.schema.json',
  'SettlementTimeline.schema.json',
  'SwapReceipt.schema.json',
  'TradingPolicy.schema.json',
  'PolicyAuditEntry.schema.json',
  'DelegationGrant.schema.json',
  'DelegationToken.schema.json',
  'DelegationTokenSigningKey.schema.json',
  'PolicyIntegritySigningKey.schema.json',
  'EventSignature.schema.json',
  'EventEnvelope.schema.json',
  'VaultHolding.schema.json',
  'VaultEvent.schema.json'
];

const exampleMap = {
  'ActorRef.schema.json': 'ActorRef.example.json',
  'AssetRef.schema.json': 'AssetRef.example.json',
  'WantSpec.schema.json': 'WantSpec.example.json',
  'SwapIntent.schema.json': 'SwapIntent.example.json',
  'CycleProposal.schema.json': 'CycleProposal.example.json',
  'Commit.schema.json': 'Commit.example.json',
  'SettlementTimeline.schema.json': 'SettlementTimeline.example.json',
  'SwapReceipt.schema.json': 'SwapReceipt.example.json',
  'TradingPolicy.schema.json': 'TradingPolicy.example.json',
  'PolicyAuditEntry.schema.json': 'PolicyAuditEntry.example.json',
  'DelegationGrant.schema.json': 'DelegationGrant.example.json',
  'DelegationToken.schema.json': 'DelegationToken.example.json',
  'DelegationTokenSigningKey.schema.json': 'DelegationTokenSigningKey.example.json',
  'PolicyIntegritySigningKey.schema.json': 'PolicyIntegritySigningKey.example.json',
  'EventSignature.schema.json': 'EventSignature.example.json',
  'EventEnvelope.schema.json': 'EventEnvelope.example.json',
  'VaultHolding.schema.json': 'VaultHolding.example.json',
  'VaultEvent.schema.json': 'VaultEvent.example.json'
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

// Preload all schemas so $ref resolves via their $id values.
for (const sf of schemaFiles) {
  const schemaPath = path.join(schemasDir, sf);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  ajv.addSchema(schema);
}

const results = [];
for (const sf of schemaFiles) {
  const schemaPath = path.join(schemasDir, sf);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);

  const exFile = exampleMap[sf];
  const exPath = path.join(examplesDir, exFile);
  const example = JSON.parse(readFileSync(exPath, 'utf8'));

  const ok = validate(example);
  results.push({ schema: sf, example: exFile, ok, errors: validate.errors ?? [] });
}

const overall = results.every(r => r.ok);
if (!overall) {
  console.error(JSON.stringify({ overall, results }, null, 2));
  process.exit(2);
}
console.log(JSON.stringify({ overall, results }, null, 2));
