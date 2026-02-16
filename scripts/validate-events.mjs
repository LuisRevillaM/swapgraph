import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = process.cwd();
const schemasDir = path.join(root, 'docs/spec/schemas');
const eventsManifestPath = path.join(root, 'docs/spec/events/manifest.v1.json');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const manifest = readJson(eventsManifestPath);
const errors = [];
if (manifest.version !== 1) errors.push({ code: 'MANIFEST_VERSION', msg: 'events manifest version must be 1' });
if (!manifest.id) errors.push({ code: 'MANIFEST_ID', msg: 'events manifest missing id' });
if (!manifest.event_envelope_schema) errors.push({ code: 'MANIFEST_ENVELOPE', msg: 'missing event_envelope_schema' });

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

// Load all schemas.
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
for (const sf of schemaFiles) {
  const s = readJson(path.join(schemasDir, sf));
  ajv.addSchema(s);
}

const envelopeSchemaPath = path.join(schemasDir, manifest.event_envelope_schema);
if (!existsSync(envelopeSchemaPath)) {
  errors.push({ code: 'ENVELOPE_SCHEMA_MISSING', msg: `missing ${manifest.event_envelope_schema}` });
}

const typeToSchema = new Map();
for (const et of manifest.event_types ?? []) {
  if (!et.type || !et.payload_schema) {
    errors.push({ code: 'EVENT_TYPE_FIELDS', msg: 'event type missing type/payload_schema', eventType: et });
    continue;
  }
  const schemaPath = path.join(schemasDir, et.payload_schema);
  if (!existsSync(schemaPath)) {
    errors.push({ code: 'PAYLOAD_SCHEMA_MISSING', msg: `missing payload schema: ${et.payload_schema}`, type: et.type });
    continue;
  }
  typeToSchema.set(et.type, et.payload_schema);
}

const overall = errors.length === 0;
if (!overall) {
  console.error(JSON.stringify({ overall, errors }, null, 2));
  process.exit(2);
}

console.log(JSON.stringify({ overall, manifest: manifest.id, event_types: [...typeToSchema.entries()] }, null, 2));
