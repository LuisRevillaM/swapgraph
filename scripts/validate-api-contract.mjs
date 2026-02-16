import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = process.cwd();
const schemasDir = path.join(root, 'docs/spec/schemas');
const apiDir = path.join(root, 'docs/spec/api');
const examplesDir = path.join(root, 'docs/spec/examples/api');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// --- Validate API manifest structure (lightweight, but strict) ---
const apiManifestPath = path.join(apiDir, 'manifest.v1.json');
const apiManifest = readJson(apiManifestPath);

const errors = [];
if (apiManifest.version !== 1) errors.push({ code: 'MANIFEST_VERSION', msg: 'manifest.v1.json version must be 1' });
if (!apiManifest.id) errors.push({ code: 'MANIFEST_ID', msg: 'manifest.v1.json missing id' });
if (!Array.isArray(apiManifest.endpoints) || apiManifest.endpoints.length === 0) {
  errors.push({ code: 'MANIFEST_ENDPOINTS', msg: 'manifest.v1.json endpoints must be a non-empty array' });
}

const opIds = new Set();
for (const ep of apiManifest.endpoints ?? []) {
  if (!ep.method || !ep.path || !ep.operation_id) {
    errors.push({ code: 'ENDPOINT_FIELDS', msg: 'endpoint missing method/path/operation_id', endpoint: ep });
    continue;
  }
  const key = `${ep.method} ${ep.path}`;
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(ep.method)) {
    errors.push({ code: 'ENDPOINT_METHOD', msg: 'unsupported method', key });
  }
  if (opIds.has(ep.operation_id)) {
    errors.push({ code: 'ENDPOINT_OPERATION_ID_DUP', msg: 'operation_id must be unique', operation_id: ep.operation_id });
  }
  opIds.add(ep.operation_id);
  if (ep.idempotency_required && ep.method === 'GET') {
    errors.push({ code: 'ENDPOINT_IDEMPOTENCY', msg: 'GET endpoints should not require idempotency', key });
  }
  for (const f of ['request_schema', 'response_schema']) {
    if (ep[f]) {
      const schemaPath = path.join(schemasDir, ep[f]);
      if (!existsSync(schemaPath)) {
        errors.push({ code: 'ENDPOINT_SCHEMA_MISSING', msg: `schema file not found: ${ep[f]}`, key });
      }
    }
  }
}

// --- Load all schemas into AJV ---
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
for (const sf of schemaFiles) {
  const s = readJson(path.join(schemasDir, sf));
  ajv.addSchema(s);
}

// --- Validate API examples ---
const exManifestPath = path.join(examplesDir, '_manifest.v1.json');
const exManifest = readJson(exManifestPath);
if (exManifest.version !== 1) errors.push({ code: 'EXAMPLES_VERSION', msg: 'examples manifest version must be 1' });

const exampleResults = [];
for (const ex of exManifest.examples ?? []) {
  const exPath = path.join(examplesDir, ex.file);
  const schemaPath = path.join(schemasDir, ex.schema);

  if (!existsSync(exPath)) {
    errors.push({ code: 'EXAMPLE_MISSING', msg: `example file not found: ${ex.file}` });
    continue;
  }
  if (!existsSync(schemaPath)) {
    errors.push({ code: 'EXAMPLE_SCHEMA_MISSING', msg: `schema file not found: ${ex.schema}` });
    continue;
  }

  const schema = readJson(schemaPath);
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const payload = readJson(exPath);

  const ok = validate(payload);
  exampleResults.push({ file: ex.file, schema: ex.schema, ok, errors: validate.errors ?? [] });
}

const overall = errors.length === 0 && exampleResults.every(r => r.ok);
const out = { overall, manifest: apiManifest.id, errors, exampleResults };

if (!overall) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(out, null, 2));
