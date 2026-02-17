import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = process.cwd();
const schemasDir = path.join(root, 'docs/spec/schemas');
const apiExamplesDir = path.join(root, 'docs/spec/examples/api');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

// --- Partner auth model doc check ---
const apiDocPath = path.join(root, 'docs/spec/API.md');
const apiDoc = readFileSync(apiDocPath, 'utf8');

const partnerAuthChecks = {
  mentions_partner_id: apiDoc.includes('partner_id'),
  mentions_actor_ref: apiDoc.includes('ActorRef'),
  mentions_partner_actor_example: apiDoc.includes('type:"partner"') || apiDoc.includes("type:'partner'") || apiDoc.includes('type="partner"')
};

// --- Load all schemas into AJV ---
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
for (const sf of schemaFiles) {
  const s = readJson(path.join(schemasDir, sf));
  ajv.addSchema(s);
}

// --- Correlation ID contract checks for read responses ---
const targets = [
  {
    schemaFile: 'SettlementInstructionsGetResponse.schema.json',
    exampleFile: 'settlement.instructions.response.json'
  },
  {
    schemaFile: 'SettlementStatusGetResponse.schema.json',
    exampleFile: 'settlement.status.response.json'
  },
  {
    schemaFile: 'SwapReceiptGetResponse.schema.json',
    exampleFile: 'receipts.get.response.json'
  }
];

const correlationChecks = [];
for (const t of targets) {
  const schemaPath = path.join(schemasDir, t.schemaFile);
  const schema = readJson(schemaPath);

  const examplePath = path.join(apiExamplesDir, t.exampleFile);
  const example = readJson(examplePath);

  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);

  const exampleValid = !!validate(example);
  const exampleErrors = validate.errors ?? [];

  const withoutCorrelation = deepClone(example);
  delete withoutCorrelation.correlation_id;

  const withoutValid = !!validate(withoutCorrelation);
  const withoutErrors = validate.errors ?? [];

  const required = Array.isArray(schema.required) ? schema.required : [];

  correlationChecks.push({
    schema: t.schemaFile,
    example: t.exampleFile,
    required_in_schema: required.includes('correlation_id'),
    example_has_correlation_id: typeof example.correlation_id === 'string' && example.correlation_id.length > 0,
    example_valid: exampleValid,
    without_correlation_valid: withoutValid,
    example_errors: exampleValid ? [] : exampleErrors,
    without_errors: withoutValid ? [] : withoutErrors
  });
}

const overall =
  partnerAuthChecks.mentions_partner_id &&
  partnerAuthChecks.mentions_actor_ref &&
  correlationChecks.every(r => r.required_in_schema && r.example_has_correlation_id && r.example_valid && !r.without_correlation_valid);

const out = {
  overall,
  partner_auth_model: partnerAuthChecks,
  correlation_id_contract: correlationChecks
};

if (!overall) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(out, null, 2));
