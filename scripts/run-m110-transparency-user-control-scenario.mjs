import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { LiquidityTransparencyService } from '../src/service/liquidityTransparencyService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M110';
const SCENARIO_FILE = 'fixtures/release/m110_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m110_expected.json';
const OUTPUT_FILE = 'liquidity_transparency_output.json';

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function reasonCodeFromError(body) {
  return body?.error?.details?.reason_code ?? null;
}

function resolveRefs(value, refs) {
  if (Array.isArray(value)) return value.map(x => resolveRefs(x, refs));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key.endsWith('_ref')) {
      const resolved = refs.get(inner);
      if (resolved === undefined) throw new Error(`missing ref value for ${key} -> ${inner}`);
      out[key.slice(0, -4)] = resolved;
      continue;
    }
    out[key] = resolveRefs(inner, refs);
  }
  return out;
}

function applyExpectations(op, rec) {
  for (const [key, value] of Object.entries(op)) {
    if (!key.startsWith('expect_')) continue;
    const field = key.slice('expect_'.length);
    assert.deepEqual(rec[field], value, `expectation_failed op=${op.op} field=${field}`);
  }
}

const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(ep => [ep.operation_id, ep]));

function endpointFor(opId) {
  const endpoint = endpointsByOp.get(opId);
  if (!endpoint) throw new Error(`missing endpoint for operation_id=${opId}`);
  return endpoint;
}

function validateApiRequest(opId, requestPayload) {
  const endpoint = endpointFor(opId);
  if (!endpoint.request_schema) return;
  const v = validateAgainstSchemaFile(endpoint.request_schema, requestPayload);
  if (!v.ok) throw new Error(`request invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
}

function validateApiResponse(opId, response) {
  const endpoint = endpointFor(opId);
  if (response.ok) {
    const v = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!v.ok) throw new Error(`response invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
    return;
  }
  const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
  if (!verr.ok) throw new Error(`error response invalid for op=${opId}: ${JSON.stringify(verr.errors)}`);
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}

store.state.idempotency ||= {};
store.state.counterparty_preferences ||= {};
store.state.liquidity_providers ||= {};
store.state.liquidity_provider_personas ||= {};
store.state.proposals ||= {};
store.state.receipts ||= {};
store.state.intents ||= {};
store.state.liquidity_decisions ||= {};
store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
store.state.tenancy.cycles ||= {};

const service = new LiquidityTransparencyService({ store });

const operations = [];
const refs = new Map();

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};
  const providerId = op.provider_id_ref ? refs.get(op.provider_id_ref) : op.provider_id;
  const proposalId = op.proposal_id_ref ? refs.get(op.proposal_id_ref) : op.proposal_id;
  const receiptId = op.receipt_id_ref ? refs.get(op.receipt_id_ref) : op.receipt_id;

  let response;
  let replayed = null;

  if (op.op === 'liquidityDirectory.list') {
    const query = resolveRefs(clone(op.query ?? {}), refs);
    response = service.listDirectory({ actor, auth, query });
  } else if (op.op === 'liquidityDirectory.get') {
    response = service.getDirectoryProvider({ actor, auth, providerId });
  } else if (op.op === 'liquidityDirectory.persona.list') {
    response = service.listDirectoryPersonas({ actor, auth, providerId });
  } else if (op.op === 'counterpartyPreferences.get') {
    response = service.getCounterpartyPreferences({ actor, auth });
  } else if (op.op === 'counterpartyPreferences.upsert') {
    const request = resolveRefs(clone(op.request ?? {}), refs);
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertCounterpartyPreferences({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'proposalCounterpartyDisclosure.get') {
    response = service.getProposalCounterpartyDisclosure({ actor, auth, proposalId });
  } else if (op.op === 'receiptCounterpartyDisclosure.get') {
    response = service.getReceiptCounterpartyDisclosure({ actor, auth, receiptId });
  } else {
    throw new Error(`unsupported op: ${op.op}`);
  }

  validateApiResponse(op.op, response);

  const rec = {
    op: op.op,
    ok: response.ok,
    replayed,
    error_code: response.ok ? null : response.body.error.code,
    reason_code: response.ok ? null : reasonCodeFromError(response.body)
  };

  if (op.op === 'liquidityDirectory.list' && response.ok) {
    const providers = response.body.providers ?? [];
    rec.providers_count = providers.length;
    rec.total_filtered = response.body.total_filtered ?? null;
    rec.first_provider_id = providers[0]?.provider_id ?? null;
  }

  if (op.op === 'liquidityDirectory.get' && response.ok) {
    rec.provider_id = response.body.provider?.provider_id ?? null;
    rec.provider_type = response.body.provider?.provider_type ?? null;
  }

  if (op.op === 'liquidityDirectory.persona.list' && response.ok) {
    const personas = response.body.personas ?? [];
    rec.provider_id = response.body.provider_id ?? null;
    rec.personas_count = personas.length;
    rec.first_persona_id = personas[0]?.persona_id ?? null;
  }

  if ((op.op === 'counterpartyPreferences.get' || op.op === 'counterpartyPreferences.upsert') && response.ok) {
    const preferences = response.body.preferences ?? {};
    rec.allow_bots = preferences.allow_bots ?? null;
    rec.allow_house_liquidity = preferences.allow_house_liquidity ?? null;
    rec.allow_partner_lp = preferences.allow_partner_lp ?? null;
    rec.category_filters_count = (preferences.category_filters ?? []).length;
  }

  if (op.op === 'proposalCounterpartyDisclosure.get' && response.ok) {
    const disclosures = response.body.disclosures ?? [];
    rec.proposal_id = response.body.proposal_id ?? null;
    rec.disclosures_count = disclosures.length;
    rec.total_counterparties = response.body.total_counterparties ?? null;
    rec.filtered_counterparties = response.body.filtered_counterparties ?? null;
    rec.first_provider_id = disclosures[0]?.provider_ref?.provider_id ?? null;
  }

  if (op.op === 'receiptCounterpartyDisclosure.get' && response.ok) {
    const disclosures = response.body.disclosures ?? [];
    rec.receipt_id = response.body.receipt_id ?? null;
    rec.disclosures_count = disclosures.length;
    rec.total_counterparties = response.body.total_counterparties ?? null;
    rec.filtered_counterparties = response.body.filtered_counterparties ?? null;
    rec.first_provider_id = disclosures[0]?.provider_ref?.provider_id ?? null;
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

store.save();

const final = {
  liquidity_providers_count: Object.keys(store.state.liquidity_providers ?? {}).length,
  liquidity_provider_personas_count: Object.keys(store.state.liquidity_provider_personas ?? {}).length,
  counterparty_preferences_count: Object.keys(store.state.counterparty_preferences ?? {}).length,
  liquidity_decisions_count: Object.keys(store.state.liquidity_decisions ?? {}).length,
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length
};

const out = canonicalize({ operations, final });
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: outHash,
  matched: outHash === expected.expected_sha256,
  operations_count: operations.length,
  final
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
